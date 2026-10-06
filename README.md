# signalk-marinetraffic-public

Signal K plugin that pulls vessel positions from MarineTraffic's public website
into Signal K. Unofficial and not affiliated with or endorsed by MarineTraffic /
Kpler.

Install with

`npm install signalk-marinetraffic-public`

## Buddy locations

Optionally integrates with
[signalk-buddylist-plugin](https://github.com/sbender9/signalk-buddylist-plugin)
(declared as a `recommends` dependency). When enabled, the plugin reads the
buddy list, extracts each buddy's MMSI, and fetches that vessel's current
position from MarineTraffic even when it is outside the bounding box.

Options:

- **Fetch buddy locations** — enable the feature (default off).
- **How often to fetch buddy locations (s)** — polling interval, minimum 60s
  (default 300s).

The MMSI → MarineTraffic ship id mapping is resolved from the persistent cache
first (both an explicit index and a reverse scan of cached ship records) and
only falls back to MarineTraffic's search endpoint on a miss, to minimise the
chance of being rate limited by Cloudflare. Every lookup is cached, so repeat
cycles need no network request for the mapping or for a ship's static details.

## Icon

`icon.svg` is an original work, licensed under this package's ISC license. It
deliberately does **not** reuse the MarineTraffic / Kpler logo or any asset from
their site — those are protected by copyright and trademark and may not be
reproduced without written permission. It only borrows the MarineTraffic blue
palette (`#263A75`, `#037FD7`, `#0FB9E9`) for visual familiarity.
