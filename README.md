# NanoReview API

Free deployment on Render.com.

## Deploy to Render (one-time setup)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` → click **Deploy**
5. Wait ~3 mins for build (installs Chromium)

## Keep it awake for free (important!)

Render free tier sleeps after 15 min inactivity.
Use [UptimeRobot](https://uptimerobot.com) (free) to ping `/health` every 14 minutes:
- Monitor type: HTTP
- URL: `https://your-app.onrender.com/health`
- Interval: 14 minutes

This keeps the server awake 24/7 at zero cost.

## Endpoints

| Endpoint | Example |
|----------|---------|
| `GET /api/search?q=` | `/api/search?q=iPhone 16` |
| `GET /api/search?q=&index=` | `/api/search?q=iPhone 16&index=1` |
| `GET /api/compare?q1=&q2=` | `/api/compare?q1=iPhone 16&q2=Galaxy S24` |
| `GET /api/suggestions?q=` | `/api/suggestions?q=pixel` |
| `GET /api/rankings?type=` | `/api/rankings?type=mobile-soc` |
| `GET /health` | Server status + cache stats |

### Rankings types
`desktop-cpu` · `laptop-cpu` · `mobile-soc` · `desktop-gpu` · `laptop-gpu`

## Performance
- First request after deploy/wake: ~5-8s (browser warm-up)
- Subsequent requests: ~1-3s
- Cached requests: <100ms
