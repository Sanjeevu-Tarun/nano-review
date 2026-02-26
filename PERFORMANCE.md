# NanoReview Scraper – Performance Optimizations

## Changes Made

### New Files
| File | Purpose |
|------|---------|
| `cache.js` | Two-tier cache: in-memory LRU + persistent file-based (.cache/) |
| `pool.js` | Persistent browser pool – 2–3 browsers kept alive, no cold start |
| `http.js` | Direct HTTP client with connection pooling – bypasses browser entirely |
| `worker.js` | Background cache warming + periodic refresh of popular/ranking pages |

### Modified Files
| File | What Changed |
|------|-------------|
| `browser.js` | Stripped to navigation helpers only; pool/launch logic moved to `pool.js` |
| `scraper.js` | Added HTTP-first / browser-fallback strategy; integrated cache layer; pure HTML scrapers exported for worker reuse |
| `routes.js` | Removed per-request browser lifecycle; added `/health` endpoint; added `_ms` timing field |
| `server.js` | Pool initialized before first request; cache warmup started in background; graceful shutdown |

## Performance Architecture

```
Request arrives
     │
     ▼
Cache check (memory, ~0ms)
     │ hit → return instantly (<5ms)
     │
     ▼
Cache check (file, ~2ms)
     │ hit → return + warm memory cache
     │
     ▼
Direct HTTP to nanoreview.net API (no browser, ~200–800ms)
     │ success → parse, cache, return
     │
     ▼
Browser pool (context already alive, ~300–1500ms)
     │ navigate + parse HTML → cache + return
```

## Expected Performance

| Scenario | Before | After |
|----------|--------|-------|
| Cached request (memory) | N/A | **< 5ms** |
| Cached request (file) | N/A | **< 20ms** |
| Fresh search (HTTP) | 2–5s | **200–800ms** |
| Fresh device page (HTTP) | 2–5s | **300–900ms** |
| Browser fallback (Cloudflare) | 2–5s | **1–2s** (pool pre-warmed) |
| Compare operation | 5–10s | **500ms–2s** |
| Rankings (cached 24h) | 5–10s | **< 10ms** |

## Cache TTLs

| Type | TTL |
|------|-----|
| Search results | 1 hour |
| Device pages | 6 hours |
| Compare pages | 6 hours |
| Ranking pages | 24 hours |

## Environment Variables

```env
PORT=3000
BROWSER_POOL_SIZE=2          # Increase to 3 for high traffic
CACHE_DIR=.cache             # Override to /tmp for ephemeral environments
DISABLE_WARMUP=0             # Set to 1 to skip startup warmup
```

## API Endpoints

All existing endpoints are unchanged. Added:

- `GET /health` — pool status, cache stats, uptime

Response bodies now include `data._ms` — the server-side processing time in milliseconds.

## Startup Sequence

1. Browser pool initialized (blocks until ready, ~3–5s one time)
2. Server starts accepting requests
3. Cache warmup runs **in background** (non-blocking):
   - Popular search queries pre-fetched
   - All 5 ranking pages fetched and cached
   - Top 10 device pages pre-scraped
