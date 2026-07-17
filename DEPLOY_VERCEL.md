# Vercel Deployment Note

This app is a realtime multiplayer blackjack server built with Express and Socket.IO.

Vercel can host the static frontend, but it is not a drop-in replacement for the current realtime backend because Socket.IO needs a long-lived server process and this project currently stores game state on the local filesystem.

## What can be deployed to Vercel

- The browser UI in `node-backend/public`
- Static assets and pages
- Small serverless APIs, if you later split the backend away from Socket.IO

## What cannot move to Vercel without a rewrite

- The current Socket.IO game server
- Persistent table state stored in local files
- The current reconnect / seat management model that depends on a live process

## If you want a real Vercel version later

You would need to move the backend to a serverless-friendly architecture:

1. Replace Socket.IO with a realtime service that works on Vercel, or move realtime traffic to another host.
2. Replace file-backed persistence with a managed database such as Postgres, Neon, Supabase, or Redis.
3. Split the frontend from the backend so the frontend can be deployed on Vercel independently.

## What you can do right now

1. Keep this repo deployed on Render for the full realtime game.
2. If you still want a Vercel deployment, deploy only the frontend as a static preview build.
3. Use the Render backend URL as the live multiplayer backend.

## I could not complete an actual Vercel publish from here

I do not have access to your GitHub or Vercel account in this environment, so I cannot log in or press the deploy buttons for you.

If you want, the next step I can do is prepare this repo for a Vercel frontend preview build and point it at an external backend URL.