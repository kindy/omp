/**
 * Builds the Cloudflare Workers upload (`./dist`) from the collab-web build.
 *
 * 1. Runs `bun run build` in packages/collab-web (its dist/ stays untouched
 *    otherwise, so `serve.ts` and npm packing keep using it as-is).
 * 2. Rewrites index.html without the upstream omp/my.omp.sh branding and SEO:
 *    favicons, manifest, canonical, Open Graph / Twitter cards, JSON-LD,
 *    author, analytics. Robots switch to noindex.
 * 3. Copies only index.html and the files it still references (the hashed
 *    JS/CSS bundles), plus this directory's `_headers` and `robots.txt`.
 *
 * Usage: `bun scripts/build.ts [--skip-web-build]`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const HERE = path.join(import.meta.dir, "..");
const WEB = path.join(HERE, "..", "..", "packages", "collab-web");
const WEB_DIST = path.join(WEB, "dist");
const OUT = path.join(HERE, "dist");

/** `<link rel>` values that carry upstream branding or identity. */
const DROP_LINK_RELS: Record<string, true> = { icon: true, "apple-touch-icon": true, manifest: true, canonical: true };
/** `<meta name>` values that carry upstream identity. */
const DROP_META_NAMES: Record<string, true> = { author: true, description: true };

function stripBranding(html: string, referenced: Set<string>): string {
	const rewritten = new HTMLRewriter()
		.on("link", {
			element(el) {
				const rels = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
				if (rels.some(rel => DROP_LINK_RELS[rel])) {
					el.remove();
					return;
				}
				const href = el.getAttribute("href");
				if (href !== null) referenced.add(href);
			},
		})
		.on("meta", {
			element(el) {
				const name = (el.getAttribute("name") ?? "").toLowerCase();
				const property = el.getAttribute("property") ?? "";
				if (name === "robots") {
					el.setAttribute("content", "noindex, nofollow");
					return;
				}
				if (property.startsWith("og:") || name.startsWith("twitter:") || DROP_META_NAMES[name]) {
					el.remove();
				}
			},
		})
		.on("script", {
			element(el) {
				const src = el.getAttribute("src");
				if (el.getAttribute("type") === "application/ld+json" || (src !== null && /^https?:/.test(src))) {
					el.remove();
					return;
				}
				if (src !== null) referenced.add(src);
			},
		})
		.on("head", {
			element(el) {
				// Empty icon: no upstream favicon, and no /favicon.ico 404 on every load.
				el.append('<link rel="icon" href="data:," />', { html: true });
			},
		})
		.onDocument({
			comments(comment) {
				// Section labels ("Open Graph", commented-out analytics) for removed tags.
				comment.remove();
			},
		})
		.transform(html);
	// Removed tags leave their indentation behind.
	return rewritten.replace(/\n(?:[ \t]*\n)+/g, "\n");
}

if (!Bun.argv.includes("--skip-web-build")) {
	await $`bun run build`.cwd(WEB);
}

const html = await Bun.file(path.join(WEB_DIST, "index.html")).text();
const referenced = new Set<string>();
const branded = stripBranding(html, referenced);

await fs.rm(OUT, { recursive: true, force: true });
await Bun.write(path.join(OUT, "index.html"), branded);
for (const ref of referenced) {
	const rel = ref.replace(/^\.?\//, "");
	if (rel.includes("/") || rel.includes("..") || rel === "") {
		throw new Error(`collab-web-cf: unexpected asset reference ${ref}`);
	}
	await fs.copyFile(path.join(WEB_DIST, rel), path.join(OUT, rel));
}
for (const own of ["_headers", "robots.txt"]) {
	await fs.copyFile(path.join(HERE, own), path.join(OUT, own));
}

const files = (await fs.readdir(OUT)).sort();
console.log(`collab-web-cf: wrote ${files.length} files to ${OUT}`);
for (const file of files) console.log(`  ${file}`);
