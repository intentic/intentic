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
 * Output: _site/site/src/assets/product/<name>.png at 2× (3× where the source is narrow) — src/, not public/, because the site
 * build resizes and re-encodes them (`_site/site/src/lib/shots.ts`). Whole surfaces, not crops — a page
 * that wants the Attention lane alone crops in CSS (the landing hero does), so a layout change on the site
 * doesn't mean a re-shoot.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { chromium, type Browser, type Page } from "@playwright/test";

const DEMO_DIR = join(repoRoot(import.meta.url), "_site/site/public/demo");
const OUT_DIR = join(repoRoot(import.meta.url), "_site/site/src/assets/product");
const PORT = 47_147;
const ORIGIN = `http://localhost:${PORT}`;
/* The demo builds under a base, because it ships inside the site's own deploy rather than on an origin of its
 * own — so its assets are `/demo/assets/…` and vue-router's history paths are `/demo/agents`. Serve it where it
 * expects to be, or the app boots to a blank page and every shot is of nothing. */
const BASE = "/demo";
const demoUrl = (path: string): string => `${ORIGIN}${BASE}${path}`;

/* 1760 rather than the 1440 this used to shoot at, for a reason that is about the SITE, not the app: the
 * workspace pane left of the docked chat is what a desktop shot contains, and at 1440 that pane was 1038 CSS
 * px — 2076 device px at 2×, painted into a column the site gives 1232 CSS px. Every desktop shot was being
 * upscaled ~19%, which is what "blurry" was. At 1760 the pane is 1358 px, so a shot arrives at 2716 device px
 * and the browser downsamples into the 1232-px column instead of stretching. It also stops the fleet board
 * eliding its own card titles: the lanes get the width the app would give them on a real desktop. */
const DESKTOP = { width: 1760, height: 1000 };
const MOBILE = { width: 430, height: 932 };
/* The chat dock is a FIXED width, so the portrait shots cannot be made crisper by widening the window the way
 * the panes above can — the only axis left is resolution. 3× where the source is narrow (the docked chat, the
 * phone), 2× where 1358 CSS px already overshoots the column that paints it. */
const DENSE_DPR = 3;
const DEFAULT_DPR = 2;

/* The demo's own switcher (`_site/demo/src/switcher.ts`) is the one thing on that page the product did not
 * draw — a fixed bar across the bottom saying how full the recording is. It belongs to the live demo, where a
 * visitor needs to know which of three states they are looking at, and to nothing on the marketing site. It is
 * hidden rather than left to the trim below because it sits BELOW the content: left in, every shot would be
 * padded out to it and the dead canvas it caused is exactly what this harness is trying to stop shooting. */
const HIDE_DEMO_CHROME = `#demo-switcher { display: none !important; }`;

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
    /** Controls to open, in order, once the surface has rendered — for a panel whose CONTENT is the story. */
    click?: string[];
    settleMs?: number;
    /** `area` keeps the workspace left of the docked chat; `chat` keeps the chat. Absent ⇒ the whole viewport. */
    clip?: "area" | "chat";
    /* An EDITORIAL floor on the shot: stop here even if the surface carries on below. Two shots use it, both
     * because what follows is the recording's own spend figures, which a marketing page must not quote as if
     * they were a benchmark. It is a cap, not a height — the trim below still pulls the frame in to whatever
     * the content actually reaches, so this number never invents empty canvas the way the old per-shot
     * heights did. */
    stopAt?: number;
    /* How full the recorded workspace is (`_site/demo/src/mode.ts`). Left unset, a shot gets the demo's own
     * curated opening: three agents, three extensions — right for the surfaces whose story is ONE screen, where
     * a full rail and a nine-card board are furniture the caption never mentions. `full` is for the board
     * itself, whose section sells running ten at once: three cards in three lanes would undersell the sentence
     * printed beside it. */
    mode?: "minimal" | "default" | "full";
    /** Overrides the shared desktop window, for a shot whose subject is not our app. */
    viewport?: { width: number; height: number };
    /** Overrides the device scale factor. Narrow sources need the extra rungs; wide ones already overshoot. */
    dpr?: number;
    /** Scroll the main column before shooting — for the tabs whose story is below the fold. */
    scrollTo?: number;
    /* Serve `path` straight off the harness origin instead of under the demo's `/demo` base — for the one shot
     * whose subject is NOT the app: the Doorbell widget as a visitor meets it, on a page that is not ours. */
    raw?: true;
    /** Type into a field once the surface is up, for a shot whose story is a conversation. */
    type?: { target: string; text: string; settleMs?: number };
}

const SHOTS: Shot[] = [
    /* The Doorbell, from the visitor's side — the REAL built widget bundle on a page that is not ours, which is
     * the only honest way to show a surface that by definition lives on someone else's site. The page and the
     * endpoints behind it are the harness's own (below); the widget is `_sandbox/webchat-widget/dist/widget.js`
     * exactly as a customer's browser would load it, so what the shot shows is what it renders. */
    {
        name: "doorbell",
        path: "/doorbell/",
        raw: true,
        // Keeps the old window: this shot's subject is a CUSTOMER's website, and that page is a 54rem column.
        // Widening it for our app's sake would only add margin either side of someone else's design.
        viewport: { width: 1440, height: 900 },
        waitFor: "intentic-doorbell",
        click: ["intentic-doorbell .launcher"],
        type: { target: "intentic-doorbell textarea", text: "Do these arms work outdoors?", settleMs: 2600 },
        settleMs: 900,
    },
    // Run agents
    {
        name: "fleet-board",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=ATTENTION",
        settleMs: 1200,
        clip: "area",
        mode: "full",
    },
    { name: "agent-review", path: "/agents/cnv_soft_deletes", waitFor: "text=Ready to land", settleMs: 1600, clip: "area" },
    {
        name: "chat-plan",
        path: "/workspace",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=No, keep planning",
        settleMs: 3200,
        clip: "chat",
        dpr: DENSE_DPR,
    },
    // The workspace
    { name: "workspace-editor", path: "/workspace/api/src/db/schema.ts", waitFor: "text=deletedAt", settleMs: 1800, clip: "area" },
    {
        name: "workspace-changes",
        path: "/workspace",
        waitFor: 'button:has-text("Changes")',
        /* Opens the Changes tab rather than shooting the Files tab it lands on — that one opens on a "drop your
         * work here" pane, which is truthful and a screenshot of nothing — and then opens the largest of the
         * five diffs: the block this sits under is about reading a change file by file, and the +23/−4 one
         * fills the pane with an actual review where the +2/−1 beside it would leave most of the frame blank. */
        click: ['button:has-text("Changes")', "text=CheckoutPanel.tsx"],
        settleMs: 1800,
        clip: "area",
    },
    /* The environment — both on the full recording, because these two are the catalog and a connection in it.
     * The curated mode leaves most extensions switched off, and a capability an extension contributes is not in
     * the catalog when it is: the page came back with eleven tiles and three connections, no GitHub among them,
     * under a heading that sells everything an agent can reach. */
    // Stops under Business & docs: the catalog scrolls on, and a frame that ends a fifth of the way into the
    // next row of tiles reads as a broken image rather than as a list with more below it.
    { name: "capabilities", path: "/capabilities", waitFor: "text=Connected", settleMs: 1200, clip: "area", mode: "full", stopAt: 900 },
    /* Lands on the catalog and OPENS GitHub rather than deep-linking `/capabilities/github`: that address
     * restores the catalog, and the panel this shot is of — what a connection adds, before you paste a token —
     * is what opening the tile reveals. */
    {
        name: "capability-github",
        path: "/capabilities",
        waitFor: 'text="GitHub"',
        click: ['text="GitHub"'],
        settleMs: 1400,
        clip: "area",
        mode: "full",
    },
    { name: "sandbox-overview", path: "/sandbox", waitFor: "text=Installed version", settleMs: 1200, clip: "area" },
    // Stops under the four headline tiles, which is the whole of what this shot is for.
    { name: "sandbox-usage", path: "/sandbox/usage", waitFor: "text=Cache hit rate", settleMs: 1800, clip: "area", stopAt: 340 },
    // Stops above the token-savings cards on purpose: those numbers are the recording's, and a marketing page
    // that shows them reads as a benchmark we never measured.
    { name: "sandbox-spend", path: "/sandbox/usage", waitFor: "text=Spend per day", settleMs: 1800, clip: "area", scrollTo: 620, stopAt: 640 },
    /* Opens Recipe, and stops at the Approve button. The tab it lands on is Contents — what the box HAS, which
     * is a list of tools; the block beside this shot is about the recipe it was built FROM, and only Recipe
     * carries the overlay diff and the two buttons that caption names. Below the card sits the export panel,
     * a different subject entirely. */
    {
        name: "sandbox-environment",
        path: "/sandbox/environment",
        waitFor: "text=Dockerfile",
        click: ['button:text-is("Recipe")'],
        settleMs: 1600,
        clip: "area",
        stopAt: 620,
    },
    // Stops after the account picker: below it sit the recording's savings figures, which are not ours to quote.
    { name: "sandbox-agent", path: "/sandbox/agent", waitFor: "text=AI ACCOUNT", settleMs: 1400, clip: "area", stopAt: 480 },
    // Mobile — the same app, its own shell
    // Same reason the desktop board opens a conversation first: without it the Active lane leads with an empty
    // "New agent" draft card, which is a truthful screen and a confusing screenshot.
    {
        name: "mobile-fleet",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        mobile: true,
        waitFor: "text=ATTENTION",
        settleMs: 1400,
        dpr: DENSE_DPR,
    },
    /* The turn keeps running in the fixture across navigations, so opening the conversation twice shows the
     * chat a few seconds INTO it — the plan card — without sitting on one page long enough for the mobile
     * shell to move on. */
    { name: "mobile-chat", path: "/agents/cnv_checkout_stripe", openFirst: "/agents/cnv_checkout_stripe", mobile: true, settleMs: 3200, dpr: DENSE_DPR },
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
/* ---- the Doorbell shot's world: a site that is not ours, and just enough daemon behind it ----
 *
 * The widget derives the daemon to call from its own <script> src, so serving both from this origin is all it
 * takes. The endpoints are stubs because the shot's subject is the WIDGET — what it renders, on someone else's
 * page — and a real daemon behind it would change nothing a reader can see. The bundle is not a stub: it is the
 * built artifact, so a regression in the widget's own rendering shows up here as a wrong screenshot. */
const WIDGET_BUNDLE = join(repoRoot(import.meta.url), "_sandbox/webchat-widget/dist/widget.js");

const DOORBELL_CONFIG = {
    automationId: "website-concierge",
    title: "Ask Northwind",
    greeting: "Hi! I'm the agent that builds this site. Ask me anything about the arms.",
    // Left as the daemon's own default (webchat-config.ts) rather than a colour picked for the shot: the
    // marketing image must show what an unconfigured Doorbell actually looks like.
    accent: "#e47100",
    position: "bottom-right",
    access: "public",
    requireName: false,
    antiBot: "off",
};

// Written in the deliberate voice of the thing being sold: an answer with a real detail in it, not "Hello! How
// may I assist you today?" — the sentence is doing the same job as the rest of the page's copy.
const DOORBELL_REPLY =
    "Yes — the RX-4 is rated IP66, so rain and dust are fine. Below -10°C you'll want the cold-weather grease kit, " +
    "which is a five-minute swap.\n\nWant me to open a ticket with our hardware team for your specific setup?";

const DOORBELL_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Northwind Robotics</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0d10;color:#e6e8eb;font:16px/1.65 ui-serif,Georgia,serif}
  header,main{max-width:54rem;margin:0 auto;padding:0 2.5rem}
  header{padding-top:5.5rem}
  .eyebrow{font:600 12px/1 ui-sans-serif,system-ui;letter-spacing:.14em;text-transform:uppercase;color:#8ab4f8}
  h1{font-size:3.1rem;line-height:1.08;letter-spacing:-.025em;margin:1rem 0 1rem}
  p{color:#9aa0a6;max-width:36rem}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.25rem;margin-top:3.5rem}
  .card{border:1px solid #1e2227;border-radius:.75rem;padding:1.25rem;background:#101318}
  .card h3{font:600 14px/1.3 ui-sans-serif,system-ui;margin:0 0 .4rem}
  .card p{font:13px/1.55 ui-sans-serif,system-ui;margin:0;color:#6b7280}
</style></head><body>
<header>
  <span class="eyebrow">Industrial robotics</span>
  <h1>Arms that pick things up, in weather that would rather they didn't.</h1>
  <p>The RX series runs outdoors, on ships, and in cold stores — the same arm, the same controller, no enclosure.</p>
</header>
<main><div class="grid">
  <div class="card"><h3>IP66 sealed</h3><p>Rain, dust and wash-down without an enclosure.</p></div>
  <div class="card"><h3>-30°C to 55°C</h3><p>Cold-store rated with the winter grease kit.</p></div>
  <div class="card"><h3>One controller</h3><p>Every arm in the range speaks the same protocol.</p></div>
</div></main>
<script src="/webchat/widget.js" data-automation="website-concierge" defer></script>
</body></html>`;

// The three widget routes, answered inline. Returns true when it handled the request.
const serveDoorbell = (path: string, response: import("node:http").ServerResponse): boolean => {
    if (path === "/doorbell/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(DOORBELL_PAGE);
        return true;
    }
    if (path === "/webchat/widget.js") {
        if (!existsSync(WIDGET_BUNDLE)) {
            throw new Error(`the Doorbell shot needs the widget built first: pnpm --filter @intentic/webchat-widget build`);
        }
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        createReadStream(WIDGET_BUNDLE).pipe(response);
        return true;
    }
    if (path.endsWith("/config")) {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(DOORBELL_CONFIG));
        return true;
    }
    if (path.endsWith("/message")) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        // Streamed in pieces, like the real thing, so the shot can be taken mid- or post-stream either way.
        let at = 0;
        const tick = setInterval(() => {
            const chunk = DOORBELL_REPLY.slice(at, at + 14);
            at += 14;
            if (chunk === "") {
                clearInterval(tick);
                response.write(`event: done\ndata: \n\n`);
                response.end();
                return;
            }
            response.write(
                `event: delta\n${chunk
                    .split("\n")
                    .map((line) => `data: ${line}`)
                    .join("\n")}\n\n`,
            );
        }, 24);
        return true;
    }
    return false;
};

const serveDemo = (): Server => {
    const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", ORIGIN).pathname;
        if ((path === "/doorbell/" || path.startsWith("/webchat/")) && serveDoorbell(path, response)) {
            return;
        }
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
const composerLeft = async (page: Page, fallback: number): Promise<number> => {
    const box = await page
        .locator(COMPOSER)
        .boundingBox()
        .catch(() => null);
    return box === null ? fallback : Math.round(box.x);
};

/* WHERE THE CONTENT ACTUALLY STOPS, in CSS px from the top of the window.
 *
 * This replaces a per-shot height that had been hand-tuned once and then drifted: a surface whose fixture grew
 * got cut through the middle of a card, and one whose fixture shrank got shot with half a frame of empty
 * canvas under it — which the site then had to letterbox into a layout, and which read as "bloated" because
 * the interface occupied a third of the picture it was the subject of.
 *
 * The rule is the one a person applies by eye: find the lowest thing in this pane that put ink on the page.
 * Full-height chrome is skipped (the scroll containers are as tall as the window whatever is in them, so they
 * answer the question with the question), as is anything `fixed`, which by definition is pinned to the
 * viewport rather than sitting at the end of the content. The icon rail is skipped WHOLESALE rather than by
 * height, because it is not one tall element: it is a column with a button pinned at its foot, and that button
 * would hold every shot open to the full window on its own. */
const contentBottom = async (page: Page, from: number, to: number): Promise<number> =>
    page.evaluate(
        ({ from, to }) => {
            const height = window.innerHeight;
            const rail = document.querySelector(`.icon-rail`)?.getBoundingClientRect();
            const left = rail === undefined ? from : Math.max(from, rail.right);
            let bottom = 0;
            for (const element of document.querySelectorAll("body *")) {
                const style = getComputedStyle(element);
                if (style.position === "fixed" || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
                    continue;
                }
                const box = element.getBoundingClientRect();
                if (box.width < 8 || box.height < 8 || box.left >= to || box.right <= left) {
                    continue;
                }
                if (box.height > height * 0.9) {
                    continue;
                }
                const ink =
                    element.childElementCount === 0
                        ? (element.textContent ?? "").trim().length > 0 || ["IMG", "SVG", "CANVAS", "VIDEO"].includes(element.tagName)
                        : style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.borderBottomWidth !== "0px";
                if (ink && box.bottom > bottom) {
                    bottom = box.bottom;
                }
            }
            return Math.ceil(bottom);
        },
        { from, to },
    );

/** The gutter left under the content, so a trimmed shot ends on breathing room rather than on a card's edge. */
const TRIM_PAD = 24;

const clipFor = async (page: Page, shot: Shot): Promise<{ x: number; y: number; width: number; height: number } | undefined> => {
    if (shot.clip === undefined) {
        return undefined;
    }
    const window = shot.viewport ?? DESKTOP;
    const split = await composerLeft(page, window.width);
    // 26px of gutter on the chat side of the split belongs to neither panel.
    const [x, width] = shot.clip === "area" ? [0, split - 26] : [split - 26, window.width - split + 26];
    const measured = await contentBottom(page, x, x + width);
    const height = Math.min(measured + TRIM_PAD, shot.stopAt ?? window.height, window.height);
    return { x, y: 0, width, height };
};

const shoot = async (browser: Browser, shot: Shot): Promise<boolean> => {
    const context = await browser.newContext({
        viewport: shot.viewport ?? (shot.mobile === true ? MOBILE : DESKTOP),
        deviceScaleFactor: shot.dpr ?? DEFAULT_DPR,
        isMobile: shot.mobile ?? false,
        hasTouch: shot.mobile ?? false,
        colorScheme: "dark",
    });
    /* Set before the app boots rather than by loading `?mode=`, because the demo CONSUMES that parameter on
     * arrival (mode.ts) — a shot that navigates twice would drop back to the default on its second page. */
    if (shot.mode !== undefined) {
        await context.addInitScript((mode) => window.sessionStorage.setItem(`intentic.demo.mode`, mode), shot.mode);
    }
    const page = await context.newPage();
    page.on("pageerror", (error) => console.warn(`  [pageerror ${shot.name}] ${error.message.split("\n")[0]}`));
    try {
        if (shot.openFirst !== undefined) {
            await page.goto(demoUrl(shot.openFirst), { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(2_400);
        }
        await page.goto(shot.raw === true ? `${ORIGIN}${shot.path}` : demoUrl(shot.path), { waitUntil: "domcontentloaded" });
        if (shot.raw !== true) {
            await page.addStyleTag({ content: HIDE_DEMO_CHROME });
        }
        if (shot.waitFor !== undefined) {
            await page.waitForSelector(shot.waitFor, { timeout: 20_000 }).catch(() => console.warn(`  [no waitFor ${shot.name}] ${shot.waitFor}`));
        }
        for (const target of shot.click ?? []) {
            await page.click(target, { timeout: 20_000 });
            await page.waitForTimeout(600);
        }
        if (shot.type !== undefined) {
            await page.fill(shot.type.target, shot.type.text);
            await page.press(shot.type.target, "Enter");
            // The reply streams, so the wait is for it to finish arriving rather than for a layout to settle.
            await page.waitForTimeout(shot.type.settleMs ?? 2_000);
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
    const only = process.argv.slice(2);
    const wanted = only.length === 0 ? SHOTS : SHOTS.filter((shot) => only.includes(shot.name));
    if (wanted.length === 0) {
        throw new Error(`No shot matches ${only.join(", ")} — known: ${SHOTS.map((shot) => shot.name).join(", ")}`);
    }
    // Only the app shots need the demo build; a `raw` one brings its own world, so re-shooting just the
    // Doorbell shouldn't cost a full SPA build.
    if (wanted.some((shot) => shot.raw !== true) && !existsSync(join(DEMO_DIR, "index.html"))) {
        throw new Error(`No demo build at ${DEMO_DIR} — run: pnpm --filter @intentic-dev/demo build`);
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
