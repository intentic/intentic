// Assemble media/app from the web package's build — the SAME dist the platform deploys, taken as-is; the
// posture difference is entirely the env document the webview injects (src/appHtml.ts). Run the web build
// first (`pnpm --filter @intentic-app/web build`); this only copies.
import { cpSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "web", "dist");
const target = join(here, "..", "media", "app");

if (!existsSync(join(source, "index.html"))) {
    console.error(`copy-app: no web build at ${source} — run \`pnpm --filter @intentic-app/web build\` first`);
    process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`copy-app: ${target} assembled from the web build`);
