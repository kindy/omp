/**
 * Self-hosted collab: serves the built web client (`dist/`) and the local relay
 * from one Bun server, mirroring the public deployment where `my.omp.sh` is
 * both the site and the relay.
 *
 * - `GET /r/<roomId>?role=host|guest` → relay WebSocket (see `local-relay.ts`).
 * - `GET /` → the web client (`dist/index.html`). Routing is hash-only, so
 *   no SPA fallback is needed; its `./<hash>.js` asset refs resolve to the root.
 * - Other paths → the matching regular file in `dist/` (bundles, favicons, …).
 * - Everything else, including `/index.html` and directories → empty 404.
 *
 * Usage: `bun run build && bun scripts/serve.ts [--port N] [--dist DIR]`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parsePort, startLocalRelay } from "./local-relay";

const DEFAULT_DIST = path.join(import.meta.dir, "..", "dist");

const APP_PATH = "/";

/** Resolves a request path to a regular file under `root`, or null. */
async function resolveFile(root: string, pathname: string): Promise<string | null> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	const target = path.resolve(root, `.${decoded}`);
	if (!target.startsWith(root + path.sep)) return null;
	try {
		return (await fs.stat(target)).isFile() ? target : null;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw err;
	}
}

function notFound(): Response {
	return new Response(null, { status: 404 });
}

export function createStaticHandler(root: string): (req: Request) => Promise<Response> {
	const distRoot = path.resolve(root);
	const indexPath = path.join(distRoot, "index.html");
	return async (req: Request): Promise<Response> => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
		}
		const { pathname } = new URL(req.url);
		if (pathname === APP_PATH) {
			// index.html references content-hashed bundles; always revalidate it.
			return new Response(Bun.file(indexPath), { headers: { "Cache-Control": "no-cache" } });
		}
		const file = await resolveFile(distRoot, pathname);
		// The app page is only reachable at APP_PATH.
		if (!file || file === indexPath) return notFound();
		return new Response(Bun.file(file));
	};
}

function parseDist(argv: readonly string[]): string {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--dist" && argv[i + 1]) return path.resolve(argv[i + 1]!);
		if (arg.startsWith("--dist=")) return path.resolve(arg.slice("--dist=".length));
	}
	return DEFAULT_DIST;
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const dist = parseDist(argv);
	if (!(await Bun.file(path.join(dist, "index.html")).exists())) {
		console.error(`collab serve: ${path.join(dist, "index.html")} not found; run \`bun run build\` first`);
		process.exit(1);
	}
	const relay = startLocalRelay(parsePort(argv), createStaticHandler(dist));
	const httpUrl = relay.url.replace(/^ws:/, "http:");
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		relay.stop();
		process.exit(0);
	};
	console.log(`collab web client: ${httpUrl}${APP_PATH}  (serving ${dist})`);
	console.log(`collab relay:      ${relay.url}  — host with \`/collab ${relay.url}\``);
	console.log("Ctrl+C stops the server");
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
