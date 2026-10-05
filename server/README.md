# Elevator Servicebox server

Node/Hono port of the Val.town ERP proxy (`VALTOWN_PROXY_CODE` in `../index.html`).
Routes, status codes and response bodies are unchanged, so the frontend only needs a new base URL.

## Run locally

```bash
cd server
npm ci
cp .env.example .env   # fill in values, never commit .env
npm run dev
npm test
```

## Deploy on Railway

- Service settings: root directory `/server`, start command `npm start`, health check path `/healthz`, restart on failure. These are set on the Railway service itself (Railway no longer uses `railway.json`).
- Add a volume mounted at `/data` and set `DATA_DIR=/data`, so sessions and sync status survive deploys.
- Set the secrets from `.env.example` as Railway service variables.
- Set `SYNC_CRON` (for example `*/30 * * * *`, UTC) to replace the Val.town cron file. Leave it empty to disable background sync.

## Routes

`POST /auth`, `POST /logout`, `/me`, `/health`, `/debug/env`, `POST /debug/probe`,
`/aufzug/<firma>/<path>`, `/freshdesk/<firma>/<path>`, `POST /sync/run`, `GET /sync/status`,
`POST /sync/run-all`, and the public `GET /healthz`.
