import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Ceilings on what this extension ships to a store, checked on every build because the regression that matters is
// silent: one `import { z } from "zod"` in anything the background bundle reaches re-adds ~330 kB of zod locales, and
// one import from the contract's barrel instead of `@intentic/sandbox-contract/webext` re-adds ~440 kB of the daemon's
// unrelated wire surface. Both type-check, both pass the tests, and neither is visible in a diff.
// Raise a number here only with the reason the bundle legitimately grew; the headroom is deliberate, not spare.

const BUDGETS = {
    // 165 kB today: zod's runtime, @orpc's client/server, the page driver and the tools.
    "background.js": 260_000,
    // Injected into every intentic.dev page, so it stays two constants and a listener. 374 bytes today.
    "pair-bridge.js": 4_000,
    // The popup's own script; it holds no schema surface.
    "popup.js": 20_000,
};

const dist = join(import.meta.dirname, "..", "dist");
const over = [];
const sizes = [];
for (const [file, budget] of Object.entries(BUDGETS)) {
    const bytes = statSync(join(dist, file)).size;
    sizes.push(`${file} ${(bytes / 1000).toFixed(1)} kB / ${(budget / 1000).toFixed(0)} kB`);
    if (bytes > budget) {
        over.push(`${file} is ${(bytes / 1000).toFixed(1)} kB, over its ${(budget / 1000).toFixed(0)} kB budget.`);
    }
}

// An unexpected file in dist/ is uploaded to the store as-is: a stray source map or scratch file ships to users.
const EXPECTED = new Set(["background.js", "pair-bridge.js", "popup.js", "popup.html", "manifest.json", "icons"]);
const strays = readdirSync(dist).filter((entry) => !EXPECTED.has(entry));

if (over.length > 0 || strays.length > 0) {
    for (const line of over) {
        console.error(line);
    }
    if (strays.length > 0) {
        console.error(`dist/ holds files the store upload does not expect: ${strays.join(", ")}`);
    }
    console.error("Check with: pnpm --filter @intentic/webext exec esbuild src/background/main.ts --bundle --minify --analyze --outfile=/dev/null");
    process.exit(1);
}

console.log(`dist: ${sizes.join(", ")}`);
