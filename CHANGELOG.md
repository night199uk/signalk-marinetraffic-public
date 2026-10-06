# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-06

### Added

- `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/).

### Changed

- Rewrote the README with features, a configuration table, the buddy locations
  section and the data published.
- Relicensed the project as Apache-2.0 and added a `LICENSE` file.

## [0.1.0] - 2026-10-06

### Added

- Optional integration with
  [signalk-buddylist-plugin](https://github.com/sbender9/signalk-buddylist-plugin),
  declared via `signalk.recommends`. When enabled, each buddy's MMSI is resolved
  to a MarineTraffic ship id and its current position is published, even when the
  buddy is outside the bounding box.
- New options: **Fetch buddy locations** and
  **How often to fetch buddy locations (s)** (minimum 60s, default 300s).
- Reverse MMSI → ship id index in the persistent cache. It is maintained on every
  ship lookup and back-populated at startup for ships already in the cache, so
  buddy lookups normally need no network request.

### Changed

- README documents the buddy locations feature.

## [0.0.7] - 2026-10-05

### Added

- Original plugin icon (`icon.svg`) and `signalk.displayName` / `signalk.appIcon`,
  so the plugin is identifiable in the Signal K App Store.
- README and `.gitignore`.

### Fixed

- A `ReferenceError: context is not defined` when a tile echoed our own vessel,
  which aborted the remaining vessels in that tile.
- Cloudflare `403` responses are now logged once at info level and abandon the
  rest of the cycle, instead of surfacing as a full axios unhandled rejection.
- Vessels are now published on first sighting; a cache miss previously returned
  `undefined` and silently dropped the vessel until a later poll.
- Missing MarineTraffic fields no longer publish `NaN`/`null` values.
- Non-403 errors no longer escape as unhandled rejections.
- Implicit globals (`ship`, `existing`, `southwest`, `northeast`) are declared.
- `plugin.stop` clears the initial timer as well as the polling interval.

### Changed

- The **Enable bounding box search** option is now honoured; it was previously
  advertised but ignored.
- The npm `test` script now performs a syntax check instead of invoking an
  undefined `$NODE`.

### Removed

- Unused schema requirements (`apikey`, `url`), unused imports and dead code.

## [0.0.6] - 2026-02-15

### Fixed

- Don't overwrite a vessel with a MarineTraffic report that is older than the
  information already held, for example from a local AIS receiver.

## [0.0.5] - 2025-12-21

### Added

- Correct support for AIS aids to navigation (ATONs), published under `atons.*`
  contexts.

## [0.0.4] - 2025-11-28

### Fixed

- Only retrieve vessels that have a numeric ship id.

## [0.0.3] - 2025-11-28

### Changed

- Switched from `fetch` to `axios` to reduce Cloudflare rejections.

## [0.0.2] - 2025-11-08

### Fixed

- Compilation fixes.

### Changed

- Repository URL updates.

## [0.0.1] - 2025-11-08

### Added

- Initial release: retrieve vessel positions within a bounding box around the
  boat's position and publish them to Signal K.
