# ADR-003: Item price search and bounded live quotes

## Status

Accepted for the first price-search release.

## Context

The application currently ships quest, hideout, item, and map data as static
files. Users want an in-app flea-market price search that works in Korean and
English and follows the active PVP/PVE profile. The linked reference feature
uses Tarkov.dev price data.

Tarkov.dev exposes a static JSON catalog and per-item price history. Its older
GraphQL endpoint is not sufficiently available to be the only runtime source.
The Windows Direct launcher is already a loopback-only local server, while a
plain static deployment has no trusted backend or durable local cache.

## Decision

1. A generated `public/data/item-price-catalog.json` contains item identity,
   Korean/English names, local icons where available, release-time PVP/PVE
   price snapshots, and trader-sale snapshots. It is the immediate and offline
   fallback shown by the UI.
2. The catalog generator reads only the fixed HTTPS endpoints under
   `https://json.tarkov.dev/`. It validates response size and shape before an
   atomic replacement. It never accepts a user-provided URL.
3. Windows Direct exposes one read-only same-origin endpoint:
   `GET /api/v1/item-prices/quote?itemId=<24-hex>&gameMode=pvp|pve`.
   The launcher fetches only the corresponding fixed Tarkov.dev price-history
   URL, validates a bounded response, computes the latest/24-hour/48-hour
   summary, and caches it locally. Cross-site requests, duplicate/unknown query
   keys, invalid IDs, redirects, proxies, and oversized responses are rejected.
4. The frontend treats every launcher response as untrusted input and accepts
   only protocol version 1 and the exact requested item/mode. A 404 or network
   error means "static catalog only", not a page failure.
5. Search operates locally over the generated catalog. Korean, English, short
   names, and normalized names are indexed. No external request is made for
   each search keystroke; a live quote is requested only after item selection
   or an explicit refresh.
6. Price data is advisory. The UI shows the source and update time and warns
   that in-game prices can change. Quest progress, settings, and inventory stay
   in the existing browser-local store and are never sent upstream.

## API response

Successful responses use the following closed contract:

```json
{
  "protocolVersion": 1,
  "itemId": "5447a9cd4bdc2dbd208b4567",
  "gameMode": "pvp",
  "source": "LIVE",
  "fetchedAt": "2026-08-10T00:00:00.000Z",
  "expiresAt": "2026-08-10T00:10:00.000Z",
  "isStale": false,
  "flea": {
    "lastLowPrice": 30000,
    "avg24hPrice": 52000,
    "low24hPrice": 28000,
    "high24hPrice": 91000,
    "changeLast48hPercent": -4.25,
    "offerCount": 30,
    "updatedAt": "2026-08-09T23:58:01.000Z"
  }
}
```

Errors use `{ "error": { "code": "...", "message": "..." } }`.

## Availability and caching

- A successful live quote is fresh for 10 minutes.
- A validated cached quote may be used for up to seven days and is visibly
  marked stale while a new attempt fails.
- The catalog snapshot always remains available, including static hosting.
- Upstream calls have an eight-second timeout and a four-megabyte body cap.

## Consequences

- Price changes no longer require a full app release when the Windows Direct
  launcher can reach Tarkov.dev.
- Catalog identity and trader snapshots still refresh with app releases.
- The new upstream integration is deliberately isolated from all progress and
  map APIs. It adds no account, API key, CORS exception, or cloud persistence.

## Verification

- Generator tests cover size limits, schema rejection, translations, PVP/PVE
  merge, ambiguous local-icon matching, and deterministic output.
- Service tests cover exact response parsing, requested item/mode binding,
  aborts, static fallback, and stale/live states.
- Component tests cover Korean/English/short-name search, keyboard operation,
  mode switching, loading/error/stale/empty states, and responsive structure.
- Portable tests cover same-origin enforcement, query validation, redirects,
  body caps, cache freshness/staleness, upstream failure, and no-CORS headers.

