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

// Optional companion plugin whose buddy list we can read in-process via
// app.getPluginOptions(). Declared as signalk.recommends in package.json.
const BUDDY_PLUGIN_ID = 'signalk-buddylist-plugin'

// Minimum seconds between buddy location fetches. Each buddy costs two
// MarineTraffic requests, so don't let this be configured aggressively.
const BUDDY_FETCH_MIN_SECONDS = 60
const BUDDY_FETCH_DEFAULT_SECONDS = 300

// Give up on a MarineTraffic request rather than let it hang forever.
const MARINETRAFFIC_TIMEOUT_MS = 20000

const MARINETRAFFIC_HEADERS = {
  "Accept": "*/*",
  // Deliberately omit br/zstd. Node 24 + axios' http adapter has known issues
  // with the brotli decompression stream that can surface as unhandled
  // rejections; gzip/deflate are handled reliably.
  "Accept-Encoding": "gzip, deflate",
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
  var buddyStartTimeout = undefined
  var buddyInterval = undefined
  let selfContext = 'vessels.' + app.selfId
  let cache = undefined

  // Circuit breaker state, one per flow. Set when MarineTraffic rate limits
  // us; reset at the start of each cycle. While set we neither log again nor
  // send further requests for that flow.
  const boxState = { rateLimited: false }
  const buddyState = { rateLimited: false }
  
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
    if (!err) {
      return false
    }
    const status = err.response
      ? err.response.status
      : err.status || err.statusCode
    if (status === 403) {
      return true
    }
    // Cloudflare occasionally returns its "unable to access" block page in a
    // shape where axios exposes no usable status; treat that as rate limiting
    // too so it can't escape as an unhandled rejection.
    const body = err.response && err.response.data
    return typeof body === 'string' &&
      (body.includes('unable_to_access') || body.includes('You are unable to access'))
  }

  // GET a MarineTraffic URL. A 403 means Cloudflare is rate limiting us: we
  // log once and trip the supplied flow's circuit breaker for the rest of its
  // cycle, so the caller abandons the cycle instead of hammering the site
  // further. Any other error is rethrown unchanged.
  async function marineTrafficGet(url, state) {
    if (state.rateLimited) {
      return null
    }

    let response
    try {
      response = await axios.get(url, {
        headers: MARINETRAFFIC_HEADERS,
        timeout: MARINETRAFFIC_TIMEOUT_MS,
        // Resolve on every HTTP status rather than rejecting. We handle a 403
        // ourselves; letting axios reject it can surface the same error a
        // second time as an unhandled rejection that floods the server log.
        // This also avoids the rejected-request path that could abort the
        // process on Node 24 (axios#10558). The default (http) adapter is used
        // deliberately: undici's fetch adapter reorders/lowercases headers,
        // which trips Cloudflare's bot detection.
        validateStatus: () => true
      })
    } catch (err) {
      // Only transport-level failures (DNS, TLS, timeout) reach here now.
      if (isRateLimited(err)) {
        state.rateLimited = true
        logInfo(REJECTED_MESSAGE)
        return null
      }
      throw err
    }

    if (response && response.status === 403) {
      state.rateLimited = true
      logInfo(REJECTED_MESSAGE)
      return null
    }

    return response
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
      buddyFetchEnabled: {
        type: "boolean",
        title: "Fetch buddy locations",
        description: "Look up MarineTraffic positions for the MMSIs in the Signal K buddy list (requires the Buddy List plugin)",
        default: false
      },
      buddyFetchRate: {
        type: "number",
        title: "How often to fetch buddy locations (s)",
        default: 300
      },
    }
  }

  async function marineTrafficToDeltas(response)
  {
    const rows = response && response.data && Array.isArray(response.data.rows)
      ? response.data.rows
      : []
    for (const vessel of rows) {
      var delta = await getVesselDelta(vessel)
      if ( delta == null ) {
        continue
      }

      app.handleMessage(plugin.id, delta)
    }
  }

  // Keep the MMSI -> ship id reverse index in sync for a ship record. Writes
  // only when the mapping is missing, so it doubles as lazy back-population
  // for records that were cached before the index existed.
  function indexMmsi(ship, shipid) {
    if (ship && ship.mmsi !== undefined && ship.mmsi !== null) {
      const key = `mmsi:${ship.mmsi}`
      if (!cache.has(key)) {
        cache.set(key, shipid)
      }
    }
  }

  // Back-populate the reverse index for every ship already in the persistent
  // cache, so an upgraded install can resolve buddy MMSIs without a single
  // network lookup.
  function backfillReverseMmsiIndex() {
    if (typeof cache.keys !== 'function') {
      return
    }
    let added = 0
    for (const shipid of cache.keys()) {
      if (shipid.startsWith('mmsi:')) {
        continue
      }
      const ship = cache.get(shipid)
      if (ship && ship.mmsi !== undefined && ship.mmsi !== null &&
          !cache.has(`mmsi:${ship.mmsi}`)) {
        cache.set(`mmsi:${ship.mmsi}`, shipid)
        added++
      }
    }
    if (added > 0) {
      app.debug(`back-filled ${added} mmsi reverse cache entr${added === 1 ? 'y' : 'ies'}`)
    }
  }

  // Resolve a vessel's static details, fetching them on first sight. Returns
  // undefined when the details are unavailable (e.g. we were rate limited), in
  // which case the caller skips the vessel until a later cycle.
  async function getShipData(shipid, state) {
    if (cache.has(shipid)) {
      app.debug(`Cache hit: ${shipid}`);
      return cache.get(shipid);
    }

    app.debug(`Cache miss: ${shipid} fetching new data`);
    var url = `https://www.marinetraffic.com/en/vessels/${shipid}/general`;
    const response = await marineTrafficGet(url, state);
    if (!response || !response.data) {
      return undefined;
    }
    app.debug(response.data);
    cache.set(shipid, response.data);
    indexMmsi(response.data, shipid);
    return response.data;
  }

  async function getVesselDelta(vessel)
  {
    app.debug(vessel);
    if (!isNumeric(vessel.SHIP_ID))
    {
      return null
    }
    const ship = await getShipData(vessel.SHIP_ID, boxState);
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

  // ---- Buddy locations ---------------------------------------------------
  // Optional integration with signalk-buddylist-plugin. We read its configured
  // buddy list in-process (app.getPluginOptions), resolve each MMSI to a
  // MarineTraffic ship id, then fetch that ship's current position.

  function mmsiFromUrn(urn) {
    if (typeof urn !== 'string') {
      return undefined
    }
    const match = urn.match(/mmsi:(\d+)$/)
    return match ? match[1] : undefined
  }

  function getBuddies() {
    if (typeof app.getPluginOptions !== 'function') {
      app.debug('app.getPluginOptions unavailable; cannot read the buddy list')
      return []
    }
    let options
    try {
      options = app.getPluginOptions(BUDDY_PLUGIN_ID)
    } catch (err) {
      app.debug(`could not read ${BUDDY_PLUGIN_ID} options: ${err.message}`)
      return []
    }
    const list = options && Array.isArray(options.buddies) ? options.buddies : []
    const buddies = []
    for (const buddy of list) {
      const mmsi = mmsiFromUrn(buddy && buddy.urn)
      if (mmsi) {
        buddies.push({ mmsi, name: buddy.name, urn: buddy.urn })
      } else {
        app.debug(`skipping buddy without a usable mmsi urn: ${JSON.stringify(buddy)}`)
      }
    }
    return buddies
  }

  // Reverse query: find a ship id already in the persistent cache whose
  // /general data carries this MMSI. Avoids hitting MarineTraffic (and
  // Cloudflare) again for a mapping we already know.
  function findShipIdByMmsi(mmsi) {
    const key = `mmsi:${mmsi}`
    if (cache.has(key)) {
      app.debug(`Reverse cache hit (mmsi): ${mmsi}`)
      return cache.get(key)
    }
    if (typeof cache.keys !== 'function') {
      return undefined
    }
    for (const cachedKey of cache.keys()) {
      if (cachedKey.startsWith('mmsi:')) {
        continue
      }
      const data = cache.get(cachedKey)
      if (data && data.mmsi !== undefined && data.mmsi !== null &&
          Number(data.mmsi) === Number(mmsi)) {
        cache.set(key, cachedKey)
        app.debug(`Reverse cache scan hit (mmsi): ${mmsi} -> ${cachedKey}`)
        return cachedKey
      }
    }
    return undefined
  }

  // MMSI -> MarineTraffic ship id. Resolved from the persistent cache when
  // possible; otherwise via the public search endpoint, whose result is cached
  // (both directions) so later cycles need no network lookup.
  async function resolveShipId(mmsi) {
    const cached = findShipIdByMmsi(mmsi)
    if (cached !== undefined) {
      return cached
    }

    app.debug(`Resolving ship id for mmsi ${mmsi} via MarineTraffic search`)
    const url = `https://www.marinetraffic.com/en/global_search/search?term=${encodeURIComponent(mmsi)}`
    const response = await marineTrafficGet(url, buddyState)
    if (!response || !response.data) {
      return undefined
    }

    const results = response.data && Array.isArray(response.data.results)
      ? response.data.results
      : []
    const match = results.find(
      (r) => r && r.type === 'MMSI' && Number(r.value) === Number(mmsi)
    )
    if (!match || match.id === undefined || match.id === null) {
      return undefined
    }

    cache.set(`mmsi:${mmsi}`, match.id)
    return match.id
  }

  async function fetchVesselPosition(shipId) {
    const url = `https://www.marinetraffic.com/en/vessels/${shipId}/position?cb=_${Date.now()}`
    const response = await marineTrafficGet(url, buddyState)
    if (!response || !response.data) {
      return undefined
    }
    const data = response.data
    // When MarineTraffic has no current fix it returns an empty array.
    if (!data || Array.isArray(data) || toFiniteNumber(data.lat) === undefined ||
        toFiniteNumber(data.lon) === undefined) {
      return undefined
    }
    return data
  }

  function buddyToDelta(buddy, ship, position) {
    const timestampSeconds = toFiniteNumber(position.timestamp)
    const timestamp = timestampSeconds === undefined
      ? new Date().toISOString()
      : new Date(timestampSeconds * 1000).toISOString()

    const delta = {
      context: `vessels.urn:mrn:imo:mmsi:${buddy.mmsi}`,
      updates: [
        {
          timestamp,
          source: { label: 'marinetraffic' },
          values: []
        }
      ]
    }

    addValue(delta, '', { mmsi: buddy.mmsi })
    addValue(delta, '', { name: buddy.name || ship.name })
    if (ship.imo) {
      addValue(delta, '', { imo: ship.imo })
    }
    if (ship.callsign) {
      addValue(delta, '', { callsign: ship.callsign })
    }

    addValue(delta, 'navigation.position', {
      latitude: toFiniteNumber(position.lat),
      longitude: toFiniteNumber(position.lon)
    })

    const course = toFiniteNumber(position.course)
    if (course !== undefined) {
      addValue(delta, 'navigation.courseOverGroundTrue', degsToRad(course))
    }
    const heading = toFiniteNumber(position.heading)
    if (heading !== undefined) {
      addValue(delta, 'navigation.headingTrue', degsToRad(heading))
    }
    // MarineTraffic reports speed in knots; Signal K expects m/s.
    const speed = toFiniteNumber(position.speed)
    if (speed !== undefined) {
      addValue(delta, 'navigation.speedOverGround', speed * 0.514444)
    }

    const width = toFiniteNumber(ship.width)
    if (width !== undefined) {
      addValue(delta, 'design.beam', width)
    }
    const length = toFiniteNumber(ship.length)
    if (length !== undefined) {
      addValue(delta, 'design.length', { overall: length })
    }
    const shipType = toFiniteNumber(ship.typeId)
    if (shipType !== undefined) {
      addValue(delta, 'design.aisShipType', {
        id: shipType,
        name: schema.getAISShipTypeName(shipType)
      })
    }

    return delta
  }

  async function fetchBuddyLocations() {
    const buddies = getBuddies()
    if (buddies.length === 0) {
      app.debug('no buddies configured (or buddy list plugin unavailable)')
      return
    }

    buddyState.rateLimited = false
    app.debug(`fetching MarineTraffic locations for ${buddies.length} buddy(ies)`)

    for (const buddy of buddies) {
      if (buddyState.rateLimited) {
        app.debug('rate limited, abandoning the rest of this buddy cycle')
        return
      }

      const context = `vessels.urn:mrn:imo:mmsi:${buddy.mmsi}`
      if (context === selfContext) {
        continue
      }

      try {
        const shipId = await resolveShipId(buddy.mmsi)
        if (shipId === undefined) {
          continue
        }
        const ship = await getShipData(shipId, buddyState)
        if (typeof ship === 'undefined') {
          continue
        }
        const position = await fetchVesselPosition(shipId)
        if (position === undefined) {
          app.debug(`no position available for buddy ${buddy.mmsi}`)
          continue
        }

        const delta = buddyToDelta(buddy, ship, position)

        // Don't overwrite newer information we already hold (e.g. from our own
        // AIS receiver), mirroring the bounding box flow.
        const existing = app.getPath(context)
        const previous = _.get(existing, 'navigation.position.timestamp')
        if (previous && moment(previous).isAfter(moment(delta.updates[0].timestamp))) {
          app.debug(`ignoring stale buddy position for ${buddy.mmsi}`)
          continue
        }

        app.handleMessage(plugin.id, delta)
      } catch (err) {
        app.debug(`buddy ${buddy.mmsi} lookup failed: ${err && err.message ? err.message : err}`)
      }
    }
  }

  var fetchBuddyLocationsSafe = async function() {
    try {
      await fetchBuddyLocations()
    } catch (err) {
      app.error(`buddy update failed: ${err && err.message ? err.message : err}`)
    }
  }

  plugin.start = function(options)
  {
    cache = new pnc.PersistentNodeCache("ships", 1000, app.getDataDirPath());
    backfillReverseMmsiIndex();

    var doUpdate = async function()
    {
      boxState.rateLimited = false

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
          if (boxState.rateLimited) {
            app.debug("rate limited, abandoning the rest of this cycle")
            return
          }
          var url = `https://www.marinetraffic.com/getData/get_data_json_4/z:10/X:${x}/Y:${y}/station:0`
          app.debug("url: %o", url);
          const response = await marineTrafficGet(url, boxState)
          if (!response || !response.data) {
            // null happens when the circuit breaker tripped; the outer loop
            // will observe the flag and stop.
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

    if (options.buddyFetchEnabled) {
      var buddyRate = Number(options.buddyFetchRate)
      if (!Number.isFinite(buddyRate) || buddyRate < BUDDY_FETCH_MIN_SECONDS) {
        buddyRate = BUDDY_FETCH_DEFAULT_SECONDS
      }
      app.debug(`buddy location fetch enabled every ${buddyRate}s`)
      buddyStartTimeout = setTimeout(fetchBuddyLocationsSafe, 10000)
      buddyInterval = setInterval(fetchBuddyLocationsSafe, buddyRate * 1000)
    }
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
    if ( buddyStartTimeout ) {
      clearTimeout(buddyStartTimeout)
      buddyStartTimeout = undefined
    }
    if ( buddyInterval ) {
      clearInterval(buddyInterval)
      buddyInterval = undefined
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

// Number() coerces null/'' to 0, which would publish bogus zeroes, so reject
// those before coercing. Returns undefined for anything not a finite number.
function toFiniteNumber(value)
{
  if (value === null || value === undefined || value === '') {
    return undefined
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
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

