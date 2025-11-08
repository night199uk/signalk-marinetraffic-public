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

const fs = require("fs");
const _ = require('lodash')
const schema = require('@signalk/signalk-schema')
const pnc = require('persistent-node-cache')
const moment = require('moment')
const path = require('path')

const stateMapping = {
  0: 'motoring',
  1: 'anchored',
  2: 'not under command',
  3: 'restricted manouverability',
  4: 'constrained by draft',
  5: 'moored',
  6: 'aground',
  7: 'fishing',
  8: 'sailing',
  9: 'hazardous material high speed',
  10: 'hazardous material wing in ground',
  14: 'ais-sart',
  15: undefined
}


module.exports = function(app)
{
  var plugin = {};
  var timeout = undefined
  let selfContext = 'vessels.' + app.selfId
  let cache = undefined
  
  plugin.id = "signalk-marinetraffic-public"
  plugin.name = "MarineTraffic Public"
  plugin.description = plugin.name

  plugin.schema = {
    type: "object",
    required: [
      "apikey", "url"
    ],
    properties: {
      updaterate: {
        type: "number",
        title: "Rate to get updates from AisHub (s > 60)",
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
      listEnabled: {
        type: "boolean",
        title: "Enable MMSI list search",
        default: false
      },
      mmsiList: {
        type: "array",
        title: "MMSIs to retrieve even when outside of bounding box",
        items: {
          type: "string",
          title: "MMSI"
        }
      }
    }
  }

  function marineTrafficToDeltas(response)
  {
    app.debug("response: " + JSON.stringify(response))
    response.data.rows.forEach(vessel => {
      app.debug('found vessel %j', vessel)
      var delta = getVesselDelta(vessel)

      if ( delta == null ) {
        return
      }

      /*
      var existing = app.signalk.root.vessels["urn:mrn:imo:mmsi:" + vessel.MMSI]

      if ( existing )
      {
        var ts = _.get(existing, "navigation.position.timestamp")
        if ( ts )
        {
          var existingDate = new Date(ts)
          
        }
      }*/
      
      app.debug("vessel delta:  %j", delta)
      app.handleMessage(plugin.id, delta)
    })
  }

  function getShipData(shipid, fetchFunction) {
    if (cache.has(shipid)) {
      app.debug('Cache hit');
      return cache.get(shipid);
    } else {
      app.debug('Cache miss - fetching new data');
      var url = `https://www.marinetraffic.com/en/vessels/${shipid}/general`;
      app.debug("url: %o", url); 
      fetch(url, {
        'headers': {
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache', 
          'Pragma': 'no-cache',
          'Priority': 'u=1, i',
          'Sec-Ch-Ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Linux"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://www.marinetraffic.com/en/ais/home/shipid:7814591/zoom:11',
        },
      'body': null,
      'method': 'GET'
      }).then(async function(response) {
        ship = await response.json();
        cache.set(shipid, ship);
	return ship;
      });
    }
  }

  function getVesselDelta(vessel)
  {
    ship = getShipData(vessel.SHIP_ID);
    app.debug(ship);
    // signalk indexes on mmsi, so no mmsi == no bueno
    if (typeof ship === 'undefined')
    {
      return
    }

    var context = "vessels.urn:mrn:imo:mmsi:" + ship.mmsi;
    if (context == selfContext) {
      app.debug(`ignorning vessel: ${context}`)
      return null
    }

    const now = new Date()
    const then = moment(now).subtract(parseInt(vessel.ELAPSED), "minutes").toDate()
    var delta = {
      "context": context,
      "updates": [
        {
          "timestamp": then.toISOString(),
          "source": {
            "label": "marinetraffic"
          },
          "values": []
        }
      ]
    }
    addValue(delta, '', { 'mmsi': ship.mmsi });
    addValue(delta, '', { 'imo': ship.imo });
    addValue(delta, '', { 'callsign': ship.callsign });
    addValue(delta, '', { 'name': vessel.SHIPNAME });
    addValue(delta, "navigation.courseOverGroundTrue", degsToRad(parseInt(vessel.COURSE)));
    addValue(delta, "navigation.headingTrue", degsToRad(parseInt(vessel.HEADING)));
    let position = {
	    latitude: parseFloat(vessel.LAT),
	    longitude: parseFloat(vessel.LON),
    };
    addValue(delta, "navigation.position", position);

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
    addValue(delta, "design.aisShipType", 
      {
        id: parseInt(ship.typeId),
        'name': schema.getAISShipTypeName(ship.typeId),
      });
    return delta;
  }
  
  plugin.start = function(options)
  {
    cache = new pnc.PersistentNodeCache("ships", 1000, app.getDataDirPath());
    var update = function()
    {
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
      southwest = degs2tile(box.latmin, box.lonmin, 10)
      northeast = degs2tile(box.latmax, box.lonmax, 10)

      for (let x = southwest.x; x <= northeast.x+1; x++) {
        for (let y = southwest.y; y <= northeast.y+1; y++) {
          var url = `https://www.marinetraffic.com/getData/get_data_json_4/z:10/X:${x}/Y:${y}/station:0`
          app.debug("url: %o", url);
          fetch(url, {
            'headers': {
              'Accept': '*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache',
              'Pragma': 'no-cache',
              'Priority': 'u=1, i',
              'Sec-Ch-Ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
              'Sec-Ch-Ua-Mobile': '?0',
              'Sec-Ch-Ua-Platform': '"Linux"',
              'Sec-Fetch-Dest': 'empty',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
              'X-Requested-With': 'XMLHttpRequest',
              'Referer': 'https://www.marinetraffic.com/en/ais/home/shipid:7814591/zoom:11',
            },
          'body': null,
          'method': 'GET'
	  }).then(async function(response) {
            vessels = await response.json();
//            app.debug(vessels);
            marineTrafficToDeltas(vessels);
          })
        }
      }
    }

    var rate = options.updaterate

    if ( !rate || rate <=60 )
      rate = 61
    update()
    timeout = setInterval(update, rate * 1000)
  }

  plugin.stop = function()
  {
    if ( timeout ) {
      clearInterval(timeout)
      timeout = undefined
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
         
function degsToRadC(vessel, degrees) {
  return degrees * (Math.PI/180.0);
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
  if ( typeof value !== 'undefined' )
  {
    delta.updates[0].values.push({path: path, value: value})
  }
}

function numberToString(vessel, num)
{
  return '' + num
}

  {
    path: "design.draft",
    key: "DRAUGHT",
    conversion: function(vessel, val) {
      if ( val == 0 )
        return null
      return { maximum: val }
    }
  },
  {
    path: 'navigation.position',
    key: "LAT",
    conversion: function(vessel, val) {
      return { latitude: val, longitude:vessel.LONGITUDE }
    }
  },
  {
    path: "navigation.speedOverGround",
    key: "SOG",
    conversion: function(vessel, val) {
      if ( val == 102.4 )
        return null;
      return val * 0.514444
    }
  },
  {
    path: "design.aisShipType",
    key: "TYPE",
    conversion: function(vessel, val) {
      const name = schema.getAISShipTypeName(val)
      if ( name ) {
        return { id: val, 'name': name }
      } else {
        return null
      }
    }
  },
]


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

const ensureDirectoryExists = (path) => {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path);
  }
};

