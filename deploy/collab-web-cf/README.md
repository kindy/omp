# collab-web on Cloudflare Workers

Fork-local deployment of [`packages/collab-web`](../../packages/collab-web) as a **static-assets-only Worker**: no Worker script, no WebSocket relay. Guests still connect to whatever relay their link names; bare `<roomId>.<key>` links resolve to the public relay `wss://my.omp.sh`. This deployment only replaces the UI.

This directory is not a workspace package and nothing in `packages/` depends on it. Leave it out of upstream PRs.

## Layout

| File | Purpose |
|---|---|
| `wrangler.jsonc` | Worker `omp-omy`, assets from `./dist`, custom domain `omy.hon.sh` (production + Previews), no `workers.dev` URLs |
| `scripts/build.ts` | Builds collab-web, then writes `./dist` from its output (see below) |
| `_headers` | Immutable caching for hashed `*.js`/`*.css`; `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer` site-wide |
| `robots.txt` | Disallows all crawling |

### What `scripts/build.ts` does

1. Runs `bun run build` in `packages/collab-web`. Its `dist/` is only read, so `bun run serve` there keeps working, even during a deploy.
2. Rewrites `index.html` without upstream branding and SEO: favicons, web manifest, canonical link, Open Graph / Twitter cards, JSON-LD, author/description, and the analytics tag are removed; robots becomes `noindex, nofollow`; an empty `data:` icon stops the browser requesting `/favicon.ico`.
3. Copies only the files the rewritten page still references (the hashed JS and CSS bundles), plus `_headers` and `robots.txt`.

What's left is 5 files: `index.html`, one `.js`, one `.css`, `_headers`, `robots.txt`.

The in-app π mark and the "omp collab" title come from the React bundle and are unchanged. Changing them would mean editing collab-web source.

## Prerequisites

- Wrangler ≥ 4.135.0 (Worker Previews). The scripts run `bunx wrangler@^4.135.0`, so nothing needs installing.
- A Cloudflare account that contains the `hon.sh` zone.
- Log in once with `bunx wrangler login`, and check the account with `bunx wrangler whoami`. For CI, set `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, Workers Routes: Edit, Zone: Read) and `CLOUDFLARE_ACCOUNT_ID`.
- Dependencies installed at the repo root (`bun install`), which collab-web's build needs.

All commands below run from `deploy/collab-web-cf/`.

## Commands

| Command | What it does |
|---|---|
| `bun run build` | Build `./dist` only |
| `bun run check` | Build, then `wrangler deploy --dry-run` (validates config, uploads nothing) |
| `bun run dev` | Build, then serve through local workerd on `http://localhost:8787` |
| `bun run preview` | Build, then deploy a Preview |
| `bun run deploy` | Build, then deploy production |

## Run locally (workerd)

```sh
bun run dev
```

Paste a collab link into the connect screen, or open `http://localhost:8787/#<link>`. A local relay works too: run `bun run relay` in `packages/collab-web` and host with `/collab ws://localhost:7466`.

## Deploy a Preview

```sh
bun run preview                          # Preview named after the current git branch
bun run preview -- --name ui-tweaks      # explicit Preview name
```

Wrangler prints two URLs:

- **Preview URL** `https://<preview-name>.omy.hon.sh/`: always serves the latest deployment of that Preview.
- **Deployment URL** `https://<deployment-id>-<preview-name>.omy.hon.sh/`: pinned to one deployment.

Previews never touch production traffic. Existing Previews are listed in the dashboard (Workers & Pages → `omp-omy` → Preview dropdown). Delete one with:

```sh
bunx wrangler@^4.135.0 preview delete --name ui-tweaks
```

Notes:

- The first Preview makes Cloudflare create a wildcard DNS record and certificate for `*.omy.hon.sh`. Issuing it can take a few minutes, so early requests may fail TLS.
- Preview URLs are public (but `noindex`). To require sign-in, put them behind Cloudflare Access (Workers & Pages → the Worker → Settings → Domains).
- If no production deployment exists yet, the `omy.hon.sh` custom domain (and so Preview hostnames) is created by the first `bun run deploy`. If the Preview URL doesn't resolve, run one production deploy first.

## Deploy production

```sh
bun run check     # optional: validate without uploading
bun run deploy    # upload ./dist and serve it on https://omy.hon.sh/
```

The first deploy creates the Worker `omp-omy` and attaches the `omy.hon.sh` custom domain (DNS record and certificate managed by Cloudflare). If `omy.hon.sh` already has a DNS record or another Worker, Wrangler stops and asks; remove the conflicting record first.

Roll back to an earlier version:

```sh
bunx wrangler@^4.135.0 deployments list
bunx wrangler@^4.135.0 rollback [<version-id>]
```

## Using it

Open `https://omy.hon.sh/` and paste a `/collab` link, or open `https://omy.hon.sh/#<link>`. The room key stays in the URL fragment and never reaches the Worker. Links that name another relay (`wss://host/r/...`, or `ws://localhost...` for local testing) work unchanged.
