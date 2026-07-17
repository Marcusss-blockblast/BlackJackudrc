# Render + Domain Deployment Guide

This repository is preconfigured for Render with `render.yaml`.

## What I already prepared

- Render blueprint file at project root.
- Backend verification script before deployment:
  - `verify-node-backend.ps1`
  - `verify-node-backend.bat`

## 1) Push this project to GitHub

1. Create a new GitHub repository.
2. Push this folder (`Blackjack Project`) to GitHub.

## 2) Run local verification first

From the project root:

- PowerShell: `./verify-node-backend.ps1`
- Or double-click: `verify-node-backend.bat`

Do not deploy until this passes.

## 3) Deploy on Render using Blueprint

1. Go to Render dashboard.
2. Click New -> Blueprint.
3. Connect your GitHub repo.
4. Select this repository.
5. Render reads `render.yaml` and proposes service `blackjack-backend`.
6. In environment variables, set `CORS_ORIGIN` to your final domain, for example:
   - `https://app.yourdomain.com`
7. Deploy.

After deployment you will get a Render URL, for example:
- `https://blackjack-backend-xxxx.onrender.com`

## 4) Connect your custom domain

1. Buy a domain from Cloudflare Registrar, Namecheap, or Porkbun.
2. In Render service settings, open Custom Domains and add:
   - `app.yourdomain.com`
3. Render gives you a DNS target.
4. In your domain DNS panel, create CNAME:
   - Name: `app`
   - Target: the Render target provided in Custom Domains.
5. Wait for DNS propagation and SSL certificate issuance.

## 5) Update CORS after domain is active

In Render environment variables:

- Set `CORS_ORIGIN=https://app.yourdomain.com`

Redeploy service.

## 6) 24/7 reliability checklist

- Use paid plan (free plans may sleep).
- Enable Render health checks (`/health` is already configured).
- Configure uptime monitoring (UptimeRobot or Better Stack).
- Keep backups of persistent state.

## Realtime UI readiness checklist

Before configuring domain DNS, verify realtime table numbers and states:

1. Open two browser windows and join the same table with different players.
2. Place bets from each window and confirm both screens update immediately.
3. Start a round and verify phase, current player, and hand values stay synced in both windows.
4. Trigger split/double/insurance flows and confirm no stale values overwrite fresh state.
5. Run backend tests:
   - `npm test`
   - Confirm `ui-realtime-regression.test.js` passes.

## Important note about game state persistence

Current setup stores account and table state in file paths inside the service container, and the service is configured to use a Render persistent disk so those files survive redeploys:

- `BLACKJACK_STATE_FILE=/opt/render/project/src/node-backend/data/table-state.json`
- `BLACKJACK_ACCOUNTS_FILE=/opt/render/project/src/node-backend/data/accounts.json`

Do not point these variables at a temporary path. If you change them, keep them inside the mounted Render disk path.

If you deploy somewhere without a persistent disk, the files will still be saved during runtime, but redeploys will reset them.
For long-term durable persistence across hosts, migrate state to a managed database (Postgres or Redis).
