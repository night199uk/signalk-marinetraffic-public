# signalk-marinetraffic-public

A [Signal K](https://signalk.org/) plugin that pulls vessel positions from
[MarineTraffic](https://www.marinetraffic.com/)'s public website into your
Signal K data model.

> **Unofficial.** This plugin reads MarineTraffic's public web endpoints. It is
> not affiliated with, endorsed by, or supported by MarineTraffic or Kpler, and
> it is not the official MarineTraffic API.

## Features

- Retrieves vessels within a configurable bounding box around your own position
  and publishes them as Signal K vessel deltas.
- Supports AIS aids to navigation (ATONs).
- Optional **buddy locations**: publishes MarineTraffic positions for the MMSIs
  in your [Buddy List](https://github.com/sbender9/signalk-buddylist-plugin),
  even when they are outside the bounding box.
- Caches ship id ↔ MMSI mappings and ship details on disk, so repeat polls make
  as few requests as possible.
- Handles Cloudflare rate limiting (HTTP 403) gracefully: it logs once and stops
  querying for the rest of the cycle instead of flooding the server log.

## Requirements

- Signal K Node Server.
- The optional
  [signalk-buddylist-plugin](https://github.com/sbender9/signalk-buddylist-plugin)
  for the buddy locations feature.

## Installation

Install through the Signal K App Store, or:

```sh
npm install signalk-marinetraffic-public
```

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| Rate to get updates from MarineTraffic (s > 60) | `61` | How often to poll the bounding box, in seconds. Values of 60 or less are raised to 61. |
| Enable bounding box search | `true` | Master switch for the bounding box poll. |
| Size of the bounding box to retrieve data (km) | `10` | Width of the box, centred on your position. |
| Fetch buddy locations | `false` | Fetch positions for your buddy list. |
| How often to fetch buddy locations (s) | `300` | Buddy polling interval, in seconds. Values below 60 are raised to 300. |

## Buddy locations

When **Fetch buddy locations** is enabled, the plugin reads the buddy list from
`signalk-buddylist-plugin`, extracts each buddy's MMSI, and publishes that
vessel's current position from MarineTraffic. This is useful for keeping an eye
on friends who are outside the range of your own AIS receiver.

For each buddy it:

1. Resolves the MMSI to a MarineTraffic ship id, preferring the on-disk cache
   (an explicit index plus a reverse scan of cached ships) and only falling back
   to MarineTraffic's search endpoint on a cache miss.
2. Fetches the ship's static details (name, IMO, callsign, dimensions, type) via
   `/vessels/<id>/general`, which is cached.
3. Fetches the current position via `/vessels/<id>/position`.

Because the mapping and the static details are cached, a repeat cycle usually
makes no request beyond the position lookup.

## Data published

Vessels are published under their own context, for example
`vessels.urn:mrn:imo:mmsi:123456789`, with `navigation.position`,
`navigation.courseOverGroundTrue`, `navigation.headingTrue`,
`navigation.speedOverGround`, `design.*` and identity fields where available.
Aids to navigation are published under `atons.urn:mrn:imo:mmsi:<mmsi>`.

Existing data is not overwritten with a MarineTraffic report that is older than
the information already held (for example, from a local AIS receiver).

## Icon

`icon.svg` is an original work, licensed under the Apache License, Version 2.0. It
deliberately does **not** reuse the MarineTraffic / Kpler logo or any asset from
their site — those are protected by copyright and trademark and may not be
reproduced without written permission. It only borrows the MarineTraffic blue
palette (`#263A75`, `#037FD7`, `#0FB9E9`) for visual familiarity.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

See [CHANGELOG.md](CHANGELOG.md) for release history.
