# OpenClaw Version Control

The Dockerfile installs OpenClaw from npm at a pinned version:

```dockerfile
ARG OPENCLAW_VERSION=2026.9.6
RUN npm install -g openclaw@${OPENCLAW_VERSION} clawhub@latest
```

## Why it is pinned

Every Railway rebuild used to run `npm install -g openclaw@latest`, so a
redeploy for any reason — a wrapper fix, a restart from the dashboard — could
also move every brain to a new gateway nobody had chosen. A new OpenClaw
changes the config shape, the tool surface and startup behaviour (2026.9.x
added the gateway owner lease; see `src/gateway-lease.js`). The version now
changes only in a commit.

## Bumping it

1. Read the release notes between the pinned version and the new one
   (`npm view openclaw time --json`, and the openclaw/openclaw releases).
2. Change the `ARG OPENCLAW_VERSION` default in the Dockerfile and open a PR.
3. Merging rebuilds every service that builds from `main`. Watch each gateway
   log for `[gateway] ready`, then drive one agent turn per brain.

## Overriding it for one service

Railway passes a service variable to the build as a build arg of the same
name, so setting `OPENCLAW_VERSION` (an npm version or dist-tag, e.g.
`2026.9.7` or `latest`) on one service's variables builds that service with it
on the next deploy. This is the way to try a new version on one brain before
bumping the default. Remove the variable afterwards so the service follows the
Dockerfile again.

Locally:

```bash
docker build --build-arg OPENCLAW_VERSION=2026.9.7 -t openclaw-railway-template .
```
