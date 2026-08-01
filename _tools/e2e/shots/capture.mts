/* Marketing screenshot harness. Drives the REAL Vue SPA — the demo build of it (`@intentic-dev/demo`, which
 * enters the app's own source with the recorded fixture installed in place of a daemon and lands in the site's
 * `public/demo/`). That makes the shots hermetic: no postgres, no platform API, no tunnel, no seeded session;
 * one world, the same "acme-shop" workspace a visitor meets at the live demo, so the site and the demo can't
 * tell two stories.
 *
 *   pnpm --filter @intentic-dev/demo build
 *   node --experimental-strip-types _tools/e2e/shots/capture.mts            # every shot
 *   node --experimental-strip-types _tools/e2e/shots/capture.mts fleet-board sandbox-usage
 *
 * Output: _apps/site/public/assets/product/<name>.png at devicePixelRatio 2. Whole surfaces, not crops — a page
 * that wants the Attention lane alone crops in CSS (the landing hero does), so a layout change on the site
 * doesn't mean a re-shoot.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

const DEMO_DIR = resolve(import.meta.dirname, "../../../_apps/site/public/demo");
const OUT_DIR = resolve(import.meta.dirname, "../../../_apps/site/public/assets/product");
const PORT = 47_147;
const ORIGIN = `http://localhost:${PORT}`;
/* The demo builds under a base, because it ships inside the site's own deploy rather than on an origin of its
 * own — so its assets are `/demo/assets/…` and vue-router's history paths are `/demo/agents`. Serve it where it
 * expects to be, or the app boots to a blank page and every shot is of nothing. */
const BASE = "/demo";
const demoUrl = (path: string): string => `${ORIGIN}${BASE}${path}`;

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 430, height: 932 };

// The composer's textarea is the docked chat's left edge — every desktop surface shares the shell, so one
// landmark decides where the workspace ends and the chat begins.
const COMPOSER = 'textarea[name="draft"]';

interface Shot {
    name: string;
    path: string;
    mobile?: boolean;
    /* A route to open and settle on first. The shell keeps ONE docked chat: land on an agent and the chat holds
     * that conversation for every later navigation — without it the board shoots with an empty "New agent"
     * draft card, which is a truthful screen and a confusing screenshot. */
    openFirst?: string;
    /** Text or selector the surface is not itself until it renders. */
    waitFor?: string;
    settleMs?: number;
    /** `area` keeps the workspace left of the docked chat; `chat` keeps the chat. Absent ⇒ the whole viewport. */
    clip?: "area" | "chat";
    /** Trim empty canvas below the content (CSS px from the top). */
    height?: number;
    /** Scroll the main column before shooting — for the tabs whose story is below the fold. */
    scrollTo?: number;
}

const SHOTS: Shot[] = [
    // Run agents
    {
        name: "fleet-board",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=ATTENTION",
        settleMs: 1200,
        clip: "area",
        height: 620,
    },
    { name: "agent-review", path: "/agents/cnv_soft_deletes", waitFor: "text=Ready to land", settleMs: 1600, clip: "area" },
    {
        name: "chat-plan",
        path: "/workspace",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=No, keep planning",
        settleMs: 3200,
        clip: "chat",
    },
    // The workspace
    { name: "workspace-editor", path: "/workspace/api/src/db/schema.ts", waitFor: "text=deletedAt", settleMs: 1800, clip: "area", height: 470 },
    { name: "workspace-changes", path: "/workspace", waitFor: "text=uncommitted changes", settleMs: 1400, clip: "area", height: 620 },
    // The environment
    { name: "capabilities", path: "/capabilities", waitFor: "text=1 connected", settleMs: 1200, clip: "area" },
    { name: "capability-github", path: "/capabilities/github", waitFor: "text=GitHub", settleMs: 1200, clip: "area", height: 660 },
    { name: "sandbox-overview", path: "/sandbox", waitFor: "text=AT A GLANCE", settleMs: 1200, clip: "area", height: 720 },
    { name: "sandbox-usage", path: "/sandbox/usage", waitFor: "text=Cache hit rate", settleMs: 1800, clip: "area", height: 400 },
    // Stops above the token-savings cards on purpose: those numbers are the recording's, and a marketing page
    // that shows them reads as a benchmark we never measured.
    { name: "sandbox-spend", path: "/sandbox/usage", waitFor: "text=Spend per day", settleMs: 1800, clip: "area", scrollTo: 620, height: 640 },
    { name: "sandbox-environment", path: "/sandbox/environment", waitFor: "text=Dockerfile", settleMs: 1200, clip: "area", height: 650 },
    // Stops after the account picker: below it sit the recording's savings figures, which are not ours to quote.
    { name: "sandbox-agent", path: "/sandbox/agent", waitFor: "text=AI ACCOUNT", settleMs: 1400, clip: "area", height: 360 },
    // Mobile — the same app, its own shell
    { name: "mobile-fleet", path: "/agents", mobile: true, waitFor: "text=ATTENTION", settleMs: 1400 },
    /* The turn keeps running in the fixture across navigations, so opening the conversation twice shows the
     * chat a few seconds INTO it — the plan card — without sitting on one page long enough for the mobile
     * shell to move on. */
    { name: "mobile-chat", path: "/agents/cnv_checkout_stripe", openFirst: "/agents/cnv_checkout_stripe", mobile: true, settleMs: 3200 },
];

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".map": "application/json; charset=utf-8",
};

/* The demo is a history-mode SPA: `/demo/agents` and `/demo/workspace/api/src/db/schema.ts` are routes, not
 * files, so anything that isn't a real file on disk is served index.html — the same rule its dev server and the
 * site's worker use. The base is stripped first: on disk the build IS the `/demo/` directory, so its own
 * `/demo/assets/…` requests would otherwise look for `public/demo/demo/assets/…`. */
const serveDemo = (): Server => {
    const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", ORIGIN).pathname;
        const routed = path.startsWith(`${BASE}/`) ? path.slice(BASE.length) : path;
        const asset = join(DEMO_DIR, normalize(decodeURIComponent(routed)));
        const file = existsSync(asset) && statSync(asset).isFile() ? asset : join(DEMO_DIR, "index.html");
        response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        createReadStream(file).pipe(response);
    });
    server.listen(PORT, "localhost");
    return server;
};

/** Where the docked chat starts — the split every desktop clip is taken on. */
const composerLeft = async (page: Page): Promise<number> => {
    const box = await page
        .locator(COMPOSER)
        .boundingBox()
        .catch(() => null);
    return box === null ? DESKTOP.width : Math.round(box.x);
};

const clipFor = async (page: Page, shot: Shot): Promise<{ x: number; y: number; width: number; height: number } | undefined> => {
    if (shot.clip === undefined) {
        return undefined;
    }
    const split = await composerLeft(page);
    const height = shot.height ?? DESKTOP.height;
    // 26px of gutter on the chat side of the split belongs to neither panel.
    return shot.clip === "area" ? { x: 0, y: 0, width: split - 26, height } : { x: split - 26, y: 0, width: DESKTOP.width - split + 26, height };
};

const shoot = async (browser: Browser, shot: Shot): Promise<boolean> => {
    const context = await browser.newContext({
        viewport: shot.mobile === true ? MOBILE : DESKTOP,
        deviceScaleFactor: 2,
        isMobile: shot.mobile ?? false,
        hasTouch: shot.mobile ?? false,
        colorScheme: "dark",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => console.warn(`  [pageerror ${shot.name}] ${error.message.split("\n")[0]}`));
    try {
        if (shot.openFirst !== undefined) {
            await page.goto(demoUrl(shot.openFirst), { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(2_400);
        }
        await page.goto(demoUrl(shot.path), { waitUntil: "domcontentloaded" });
        if (shot.waitFor !== undefined) {
            await page.waitForSelector(shot.waitFor, { timeout: 20_000 }).catch(() => console.warn(`  [no waitFor ${shot.name}] ${shot.waitFor}`));
        }
        await page.waitForTimeout(shot.settleMs ?? 800);
        if (shot.scrollTo !== undefined) {
            await page.mouse.move(300, 400);
            await page.mouse.wheel(0, shot.scrollTo);
            await page.waitForTimeout(600);
        }
        await page.screenshot({ path: resolve(OUT_DIR, `${shot.name}.png`), clip: await clipFor(page, shot) });
        console.log(`  ✓ ${shot.name} → ${shot.path}`);
        return true;
    } catch (error) {
        console.error(`  ✗ ${shot.name}:`, (error as Error).message.split("\n")[0]);
        return false;
    } finally {
        await page.close();
        await context.close();
    }
};

const run = async (): Promise<void> => {
    if (!existsSync(join(DEMO_DIR, "index.html"))) {
        throw new Error(`No demo build at ${DEMO_DIR} — run: pnpm --filter @intentic-dev/demo build`);
    }
    const only = process.argv.slice(2);
    const wanted = only.length === 0 ? SHOTS : SHOTS.filter((shot) => only.includes(shot.name));
    if (wanted.length === 0) {
        throw new Error(`No shot matches ${only.join(", ")} — known: ${SHOTS.map((shot) => shot.name).join(", ")}`);
    }

    mkdirSync(OUT_DIR, { recursive: true });
    const server = serveDemo();
    const browser = await chromium.launch();
    let failed = 0;
    try {
        for (const shot of wanted) {
            if (!(await shoot(browser, shot))) {
                failed += 1;
            }
        }
    } finally {
        await browser.close();
        server.close();
    }
    console.log(`${wanted.length - failed}/${wanted.length} shots written to ${OUT_DIR}`);
};

await run();
