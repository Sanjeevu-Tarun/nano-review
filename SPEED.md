# Speed Guide — Why It's Slow & How To Fix It

## The Real Problem: Render Free Tier

| Scenario | Time | Why |
|---|---|---|
| Render FREE, cold start | ~13s | Process slept → browser launch from scratch |
| Render FREE, warm | ~3s | Browser ready but CF cookies not persisted |
| Render PAID / Railway, cold start | ~1-2s | **Disk cookies valid → skip browser nav** |
| Render PAID / Railway, warm | ~300ms | Pure HTTP, no browser |
| Any host, cached response | <5ms | Memory cache hit |

## Fix 1: Use UptimeRobot (Free, Prevents Sleep)

1. Go to https://uptimerobot.com — free account
2. Add HTTP monitor → your service URL + `/health`
3. Set interval: **5 minutes**
4. Done. Render won't sleep your service.

This alone drops you from 13s → ~1-2s on free tier.

## Fix 2: Persistent CF Cookies (Already Implemented)

The browser now uses `launchPersistentContext()` which saves CF cookies to disk.
After the FIRST warmup, subsequent restarts load saved cookies and skip browser
navigation entirely. Combined with UptimeRobot, restarts are rare anyway.

Point the `BROWSER_DATA_DIR` env var at a persistent volume (already configured
in render.yaml with a 1GB disk mount at `/data`).

## Fix 3: Railway (Already Faster)

Railway keeps processes alive on all plans. Use the included `railway.json` +
`Dockerfile`. No extra config needed.

## Request Flow (After Warmup)

```
Request arrives
    ↓
Memory cache hit? → return in <5ms
    ↓ miss
CF cookies valid? (from disk or memory)
    ↓ yes
directSearch() [parallel HTTP, all types] + 
directFetchHtml() or /_next/data/ JSON API
    → total ~300-600ms
    ↓ CF blocked
browserFetchDirect() [single nav, direct to device page]
    → ~2-4s
```

## Environment Variables

| Var | Default | Purpose |
|---|---|---|
| `BROWSER_DATA_DIR` | `./.browser-data` | Persistent CF cookie storage |
| `CACHE_DIR` | `./.cache` | Response cache |
| `SELF_URL` | `http://localhost:PORT` | Self keep-alive URL |
| `RENDER_EXTERNAL_URL` | (auto on Render) | External URL for keep-alive |
