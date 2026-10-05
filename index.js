/*
 * Copyright 2017 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const _ = require('lodash')
const schema = require('@signalk/signalk-schema')
const pnc = require('persistent-node-cache')
const moment = require('moment')
const axios = require("axios")

// Cloudflare rejects our queries when we poll too fast. That is expected
// behaviour rather than a plugin fault, so it is logged as info instead of
// being allowed to surface as a huge unhandled rejection stack trace.
const REJECTED_MESSAGE =
  'MarineTraffic rejected our query - most likely caused by querying too fast. Ignoring.'

const MARINETRAFFIC_HEADERS = {
  "Accept": "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "close",
  "Cache-Control": "no-cache",
  "Host": "www.marinetraffic.com",
  "Pragma": "no-cache",
  "Priority": "u=1, i",
  "Referer": "https://www.marinetraffic.com/",
  "Sec-Ch-Ua": "\"Not(A:Brand\";v=\"8\", \"Chromium\";v=\"144\", \"Google Chrome\";v=\"144\"",
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": "\"Linux\"",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  "X-Requested-With": "XMLHttpRequest",
}

module.exports = function(app)
{
  var plugin = {};
  var startTimeout = undefined
  var interval = undefined
  let selfContext = 'vessels.' + app.selfId
  let cache = undefined

  // Set when MarineTraffic rate limits us. Reset at the start of each poll
  // cycle; while set we neither log again nor send further requests.
  let rateLimited = false
  
  plugin.id = "signalk-marinetraffic-public"
  plugin.name = "MarineTraffic Public"
  plugin.description = plugin.name

  // The Signal K plugin API only guarantees app.debug/app.error, so fall back
  // to console.info (which the server log captures as a non-error line) when
  // the running server has no app.info.
  function logInfo(msg) {
    if (typeof app.info === 'function') {
      app.info(msg)
    } else {
      console.info(`signalk-marinetraffic-public:${msg}`)
    }
  }

  function isRateLimited(err) {
    return !!err && !!err.response && err.response.status === 403
  }

  // GET a MarineTraffic URL. A 403 means Cloudflare is rate limiting us: we
  // log once and trip the circuit breaker for the rest of this cycle, so the
  // caller abandons the cycle instead of hammering the site further. Any other
  // error is rethrown unchanged.
  async function marineTrafficGet(url) {
    if (rateLimited) {
      return null
    }
    try {
      return await axios.get(url, { headers: MARINETRAFFIC_HEADERS })
    } catch (err) {
      if (isRateLimited(err)) {
        rateLimited = true
        logInfo(REJECTED_MESSAGE)
        return null
      }
      throw err
    }
  }

  plugin.schema = {
    type: "object",
    properties: {
      updaterate: {
        type: "number",
        title: "Rate to get updates from MarineTraffic (s > 60)",
        default: 61
      },
      boxEnabled: {
        type: "boolean",
        title: "Enable bounding box search",
        default: true
      },
      boxSize: {
        type: "number",
        title:"Size of the bounding box to retrieve data (km)",
        default: 10
      },
//      listEnabled: {
//        type: "boolean",
//        title: "Enable MMSI list search",
//        default: false
//      },
//      mmsiList: {
//        type: "array",
//        title: "MMSIs to retrieve even when outside of bounding box",
//        items: {
//          type: "string",
//          title: "MMSI"
//        }
//      }
    }
  }

  async function marineTrafficToDeltas(response)
  {
    for (const vessel of response.data.rows) {
      var delta = await getVesselDelta(vessel)
      if ( delta == null ) {
        continue
      }

      app.handleMessage(plugin.id, delta)
    }
  }

  // Resolve a vessel's static details, fetching them on first sight. Returns
  // undefined when the details are unavailable (e.g. we were rate limited), in
  // which case the caller skips the vessel until a later cycle.
  async function getShipData(shipid) {
    if (cache.has(shipid)) {
      app.debug(`Cache hit: ${shipid}`);
      return cache.get(shipid);
    }

    app.debug(`Cache miss: ${shipid} fetching new data`);
    var url = `https://www.marinetraffic.com/en/vessels/${shipid}/general`;
    const response = await marineTrafficGet(url);
    if (response === null) {
      return undefined;
    }
    app.debug(response.data);
    cache.set(shipid, response.data);
    return response.data;
  }

  async function getVesselDelta(vessel)
  {
    app.debug(vessel);
    if (!isNumeric(vessel.SHIP_ID))
    {
      return null
    }
    const ship = await getShipData(vessel.SHIP_ID);
    app.debug(ship);
    // signalk indexes on mmsi, so no mmsi == no bueno
    if (typeof ship === 'undefined' || ship.mmsi === undefined || ship.mmsi === null)
      return null

    const age = moment.utc().subtract(parseInt(vessel.ELAPSED), "minutes")

    var delta = {
      "updates": [
        {
          "timestamp": age.toDate().toISOString(),
          "source": {
            "label": "marinetraffic"
          },
          "values": []
        }
      ]
    }

    addValue(delta, '', { 'mmsi': ship.mmsi });
    addValue(delta, '', { 'name': vessel.SHIPNAME });
    let position = {
	    latitude: parseFloat(vessel.LAT),
	    longitude: parseFloat(vessel.LON),
    };
    addValue(delta, "navigation.position", position);

    if (ship.isNavigationalAid)
    {
      delta['context'] = "atons.urn:mrn:imo:mmsi:" + ship.mmsi;
      const existing = app.getPath(delta['context'])
      if (existing)
      {
        const previous = _.get(existing, "sensors.ais.class.timestamp")
        if (previous && moment(previous).isAfter(age))
          return null;
      }

      let atonType = parseInt(ship.typeId) - 100
      addValue(delta, 'atonType', 
        {
          id: atonType,
          'name': schema.getAtonTypeName(atonType),
        });
      addValue(delta, "sensors.ais.class", "ATON");
    }
    else
    {
      delta['context'] = "vessels.urn:mrn:imo:mmsi:" + ship.mmsi;
      if (delta['context'] === selfContext) {
        app.debug(`ignoring vessel: ${delta['context']}`)
        return null
      }

      const existing = app.getPath(delta['context'])
      if (existing)
      {
        const previous = _.get(existing, "navigation.position.timestamp")
        if (previous && moment(previous).isAfter(age))
          return null;
      }

      if (ship.imo)
      {
        addValue(delta, '', { 'imo': ship.imo });
      }
      if (ship.callsign)
      {
        addValue(delta, '', { 'callsign': ship.callsign });
      }
      addValue(delta, "navigation.courseOverGroundTrue", degsToRad(parseInt(vessel.COURSE)));
      if(vessel.HEADING)
      {
        addValue(delta, "navigation.headingTrue", degsToRad(parseInt(vessel.HEADING)));
      }
      if (vessel.DESTINATION != "CLASS B")
      {
        addValue(delta, "navigation.destination.commonName", vessel.DESTINATION);
      }

      // convert knots to kph
      let speedOverGround = (parseInt(vessel.SPEED) / 10) * 0.514444;
      addValue(delta, "navigation.speedOverGround", speedOverGround);
      addValue(delta, "design.beam", parseInt(vessel.WIDTH));
      addValue(delta, "design.length", { 'overall': parseInt(vessel.LENGTH) });
      addValue(delta, "sensors.ais.fromCenter", parseInt(vessel.W_LEFT));
      addValue(delta, "sensors.ais.fromBow", parseInt(vessel.L_FORE));

      let shipType = parseInt(ship.typeId)
      addValue(delta, "design.aisShipType", 
        {
          id: shipType,
          'name': schema.getAISShipTypeName(shipType),
        });
    }

    app.debug(JSON.stringify(delta, null, 2))
    return delta;
  }
  
  plugin.start = function(options)
  {
    cache = new pnc.PersistentNodeCache("ships", 1000, app.getDataDirPath());

    var doUpdate = async function()
    {
      rateLimited = false

      // The bounding box search is the only data source; honour the schema
      // option rather than ignoring it.
      if (options.boxEnabled === false)
      {
        app.debug("bounding box search disabled")
        return
      }

      var position = app.getSelfPath('navigation.position')
      app.debug("position: %o", position)
      if ( typeof position !== 'undefined' && position.value )
        position = position.value
      if ( typeof position == 'undefined' || typeof position.latitude == 'undefined' || typeof position.longitude === 'undefined' )
      {
        app.debug("no position available")
        return
      }

      var box = calc_boundingbox(options, position)
      publishBox(box)
      const southwest = degs2tile(box.latmin, box.lonmin, 10)
      const northeast = degs2tile(box.latmax, box.lonmax, 10)

      app.debug("box: %o", box)
      app.debug("southwest: %o", southwest)
      app.debug("northeast: %o", northeast)
      for (let x = southwest.x; x <= northeast.x+1; x++) {
        for (let y = southwest.y; y >= northeast.y-1; y--) {
          if (rateLimited) {
            app.debug("rate limited, abandoning the rest of this cycle")
            return
          }
          var url = `https://www.marinetraffic.com/getData/get_data_json_4/z:10/X:${x}/Y:${y}/station:0`
          app.debug("url: %o", url);
          const response = await marineTrafficGet(url)
          if (response === null) {
            // null only happens when the circuit breaker tripped; the outer
            // loop will observe the flag and stop.
            continue
          }
          app.debug('%o', response.data);
          await marineTrafficToDeltas(response.data);
        }
      }
    }

    // Keep a failing cycle from escaping as an unhandled rejection and taking
    // the whole server log with it.
    var update = async function()
    {
      try {
        await doUpdate()
      } catch (err) {
        app.error(`update failed: ${err && err.message ? err.message : err}`)
      }
    }

    var rate = options.updaterate

    if ( !rate || rate <=60 )
      rate = 61
    startTimeout = setTimeout(update, 5000)
    interval = setInterval(update, rate * 1000)
  }

  plugin.stop = function()
  {
    if ( startTimeout ) {
      clearTimeout(startTimeout)
      startTimeout = undefined
    }
    if ( interval ) {
      clearInterval(interval)
      interval = undefined
    }
  }

  function publishBox(box)
  {
    var delta = {
      "context": "vessels." + app.selfId,
      "updates": [
        {
          "source": {
            "label": "marinetraffic"
          },
          "values": [
            {
              path: "sensors.ais.boundingBox",
              value: box
            }
          ]
        }
      ]
    }
    app.handleMessage("signalk-marinetraffic-public", delta)
  }


  return plugin
}
         
function degsToRad(degrees) {
  return degrees * (Math.PI/180.0);
}

function radsToDeg(radians) {
  return radians * 180 / Math.PI
}
  
function degs2tile(lat, lng, zoom) {
  const latRad = lat * Math.PI / 180;
  const n = Math.pow(2, zoom - 1); // MarineTraffic uses a 512 * 512 grid

  const xTile = Math.floor(((lng + 180) / 360) * n);
  const yTile = Math.floor((1 - Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI) / 2 * n);

  return { x: xTile, y: yTile };
}

function addValue(delta, path, value)
{
  if ( typeof value === 'undefined' || value === null )
  {
    return
  }
  // MarineTraffic omits fields for some vessels; parseInt/parseFloat of those
  // yields NaN, which must never be published into the Signal K tree.
  if ( typeof value === 'number' && !Number.isFinite(value) )
  {
    return
  }
  delta.updates[0].values.push({path: path, value: value})
}

function isNumeric(str) 
{
  if (typeof str != "string") return false // we only process strings!  
  return !isNaN(str) && // use type coercion to parse the _entirety_ of the string (`parseFloat` alone does not do this)...
         !isNaN(parseFloat(str)) // ...and ensure strings of whitespace fail
}

function mod(x,y){
  return x-y*Math.floor(x/y)
}

function calc_position_from(position, heading, distance)
{
  var dist = (distance / 1000) / 1.852  //m to nm
  dist /= (180*60/Math.PI)  // in radians

  heading = (Math.PI*2)-heading
  
  var lat = Math.asin(Math.sin(degsToRad(position.latitude)) * Math.cos(dist) + Math.cos(degsToRad(position.latitude)) * Math.sin(dist) * Math.cos(heading))
  
  var dlon = Math.atan2(Math.sin(heading) * Math.sin(dist) * Math.cos(degsToRad(position.latitude)), Math.cos(dist) - Math.sin(degsToRad(position.latitude)) * Math.sin(lat))
  
  var lon = mod(degsToRad(position.longitude) - dlon + Math.PI, 2 * Math.PI) - Math.PI
  
  return { "latitude": radsToDeg(lat),
           "longitude": radsToDeg(lon) }
}

function calc_boundingbox(opions, position)
{
  var dist = opions.boxSize

  if ( ! dist )
    dist = 10
  dist = (dist/2) * 1000

  var min_lon = calc_position_from(position, 4.5, dist) // west
  var max_lon = calc_position_from(position, 1.5, dist) // east
  var max_lat = calc_position_from(position, 0, dist)   // north
  var min_lat = calc_position_from(position, 3.0, dist) // south
  return {
    'latmin': min_lat.latitude,
    'latmax': max_lat.latitude,
    'lonmin': min_lon.longitude,
    'lonmax': max_lon.longitude
  }
}

