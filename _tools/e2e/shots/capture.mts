/* Marketing screenshot harness. */
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { chromium, type Browser, type Page } from "@playwright/test";

const DEMO_DIR = join(repoRoot(import.meta.url), "_site/site/public/demo");

// The site ships two skins, so it needs two sets of these. `--light` drives the app in its light scheme and writes
// the twin set; the site pairs them by filename (see _site/site/src/lib/shots.ts).
const LIGHT = process.argv.includes("--light");
const OUT_DIR = join(repoRoot(import.meta.url), `_site/site/src/assets/${LIGHT ? "product-light" : "product"}`);
const PORT = 47_147;
const ORIGIN = `http://localhost:${PORT}`;
/* Serve the demo under its configured /demo base. */
const BASE = "/demo";
const demoUrl = (path: string): string => `${ORIGIN}${BASE}${path}`;

/* Capture at 1760px so desktop surfaces fit without upscaling. */
const DESKTOP = { width: 1760, height: 1000 };
const MOBILE = { width: 430, height: 932 };
/* Narrow sources use 3× density; wide sources use 2×. */
const DENSE_DPR = 3;
const DEFAULT_DPR = 2;

/* Hide demo-only chrome and tooltips from screenshots. */
const HIDE_DEMO_CHROME = `#demo-switcher, .ui-tooltip { display: none !important; }`;

// WHERE THE WORKSPACE ENDS AND THE CHAT BEGINS. Every desktop surface shares the shell, so one landmark decides it
// for all of them. It used to be the composer's textarea, and that selector has since stopped matching anything the
// demo renders — the pane and its controls mount, the textarea does not. A stale landmark here is expensive and
// quiet: `composerLeft` fell back to the whole viewport and every clipped shot came out ~400px too wide, with
// nothing in the log to say so. Hence two of them, the panel first, and a loud failure when neither is found.
const CHAT_PANEL = ".chat-panel";
const COMPOSER = 'textarea[name="draft"]';

/* Match the platform-independent start of the chat popout label. */
const POPOUT_BUTTON = 'button[aria-label^="Move chat into new window"]';

/* Keep popped-out chat readable within the landing frame. */
const POPOUT_WINDOW = { width: 800, height: 660 } as const;

/* Use one desktop window size for the hero's rotating surfaces. */
const HERO_WINDOW = { width: DESKTOP.width, height: 860 } as const;

/* Capture showcase surfaces in the landing page's 16:9 frame. */
const SHOWCASE = { width: 1760, height: 990 } as const;
const SHOWCASE_DPR = 1.5;

interface Shot {
    name: string;
    path: string;
    mobile?: boolean;
    /* Open this route first to establish the shared docked conversation. */
    openFirst?: string;
    /** Text or selector the surface is not itself until it renders. */
    waitFor?: string;
    /** Controls to open, in order, once the surface has rendered — for a panel whose CONTENT is the story. */
    click?: string[];
    settleMs?: number;
    /** `area` keeps the workspace left of the docked chat; `chat` keeps the chat. Absent ⇒ the whole viewport. */
    clip?: "area" | "chat";
    /* Stop trimming at this content-specific editorial floor. */
    stopAt?: number;
    /* Select the demo fixture density used for this shot. */
    mode?: "minimal" | "default" | "full";
    /** Overrides the shared desktop window, for a shot whose subject is not our app. */
    viewport?: { width: number; height: number };
    /** Overrides the device scale factor. Narrow sources need the extra rungs; wide ones already overshoot. */
    dpr?: number;
    /** Scroll the main column before shooting — for the tabs whose story is below the fold. */
    scrollTo?: number;
    /* Serve this path directly from the harness origin. */
    raw?: true;
    /** Type into a field once the surface is up, for a shot whose story is a conversation. */
    type?: { target: string; text: string; settleMs?: number };
    /* Capture the conversation in a separate browser window. */
    popout?: {
        width: number;
        height: number;
        /* Press these controls inside the popped-out window in order. */
        press?: string[];
        settleMs?: number;
    };
    /* Preserve the full window height instead of trimming content. */
    fullHeight?: true;
}

const SHOTS: Shot[] = [
    /* Capture the built Front Desk widget in a standalone visitor page. */
    {
        name: "front-desk",
        path: "/front-desk/",
        raw: true,
        // Keeps the old window: this shot's subject is a CUSTOMER's website, and that page is a 54rem column.
        // Widening it for our app's sake would only add margin either side of someone else's design.
        viewport: { width: 1440, height: 900 },
        waitFor: "intentic-front-desk",
        click: ["intentic-front-desk .launcher"],
        type: { target: "intentic-front-desk textarea", text: "Do these arms work outdoors?", settleMs: 2600 },
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
    /* Showcase captures use whole 16:9 windows with settled curated conversations. */
    {
        name: "stage-run",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=ATTENTION",
        settleMs: 3200,
        viewport: SHOWCASE,
        dpr: SHOWCASE_DPR,
    },
    {
        /* Use the full fixture so this catalogue includes the connected capability tiles. */
        name: "stage-connect",
        path: "/capabilities",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=Connected",
        settleMs: 3200,
        viewport: SHOWCASE,
        dpr: SHOWCASE_DPR,
        mode: "full",
    },
    {
        /* Open the Changes tab and select CheckoutPanel.tsx for the review frame. */
        name: "stage-review",
        path: "/workspace",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: 'button:has-text("Changes")',
        click: ['button:has-text("Changes")', "text=CheckoutPanel.tsx"],
        settleMs: 1800,
        viewport: SHOWCASE,
        dpr: SHOWCASE_DPR,
    },
    {
        /* Capture sandbox access so the frame shows ownership and invitation controls. */
        name: "stage-host",
        path: "/sandbox/access",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=Sign out everywhere",
        settleMs: 3200,
        viewport: SHOWCASE,
        dpr: SHOWCASE_DPR,
    },
    /* Hero captures keep the workspace and popout chat in separate curated frames. */
    {
        name: "hero-agents",
        path: "/agents",
        // Same reason fleet-board does it: without a conversation already open the Active lane leads with an
        // empty "New agent" draft card, which is a truthful screen and a confusing screenshot.
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=ATTENTION",
        settleMs: 1400,
        clip: "area",
        viewport: HERO_WINDOW,
        fullHeight: true,
    },
    /* Capture the hero review in the same window and crop as the hero board. */
    {
        name: "hero-review",
        path: "/agents/cnv_soft_deletes",
        waitFor: "text=Ready to land",
        settleMs: 1600,
        clip: "area",
        viewport: HERO_WINDOW,
        fullHeight: true,
    },
    /* Capture the popped-out chat on the Agents and Personas rail views. */
    {
        name: "hero-chat-agents",
        path: "/agents/cnv_checkout_stripe",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: POPOUT_BUTTON,
        settleMs: 2600,
        popout: POPOUT_WINDOW,
        dpr: DENSE_DPR,
    },
    {
        name: "hero-chat-personas",
        path: "/agents/cnv_checkout_stripe",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: POPOUT_BUTTON,
        settleMs: 2600,
        popout: {
            ...POPOUT_WINDOW,
            /* Select Personas, Maya, and her run inside the popped-out chat. */
            press: ['button[role="tab"]:has-text("Personas")', "text=Maya · Customer Care", "button.chat-run-bar"],
            settleMs: 1_800,
        },
        dpr: DENSE_DPR,
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
        /* Open the Changes tab and select a compact schema diff. */
        click: ['button:has-text("Changes")', "text=schema.ts"],
        settleMs: 1800,
        clip: "area",
    },
    /* Use the full fixture so the environment frame includes its capability catalog. */
    // Stops under Business & docs: the catalog scrolls on, and a frame that ends a fifth of the way into the
    // next row of tiles reads as a broken image rather than as a list with more below it.
    { name: "capabilities", path: "/capabilities", waitFor: "text=Connected", settleMs: 1200, clip: "area", mode: "full", stopAt: 900 },
    /* Open GitHub from the catalog so the frame includes the connection panel. */
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
    /* Open the environment Recipe tab and stop at its Approve button. */
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
    /* Reopen the running fixture conversation so mobile chat shows its plan card. */
    {
        name: "mobile-chat",
        path: "/agents/cnv_checkout_stripe",
        openFirst: "/agents/cnv_checkout_stripe",
        mobile: true,
        settleMs: 3200,
        dpr: DENSE_DPR,
    },
    /* Capture mobile files, changes, menu, and sandbox surfaces for visual review. */
    { name: "mobile-files", path: "/workspace", mobile: true, waitFor: "text=README.md", settleMs: 1600, dpr: DENSE_DPR },
    { name: "mobile-changes", path: "/workspace?panel=changes", mobile: true, waitFor: "text=CheckoutPanel.tsx", settleMs: 1600, dpr: DENSE_DPR },
    { name: "mobile-menu", path: "/menu", mobile: true, waitFor: "text=SANDBOXES", settleMs: 1400, dpr: DENSE_DPR },
    { name: "mobile-sandbox", path: "/sandbox", mobile: true, waitFor: "text=Installed version", settleMs: 1400, dpr: DENSE_DPR },
    /* Preview captures use 16:10 frames sized for the 544px menu rail. */
    {
        /* Capture automations from the full fixture so the extension is enabled. */
        name: "menu-automate",
        path: "/ext/automations",
        waitFor: "text=Wake your agent on a schedule",
        settleMs: 1600,
        clip: "area",
        mode: "full",
        viewport: { width: 1290, height: 900 },
        stopAt: 500,
    },
    {
        /* Capture the dense review surface with its file list and uncommitted diff. */
        name: "menu-review",
        path: "/workspace",
        waitFor: 'button:has-text("Changes")',
        click: ['button:has-text("Changes")', "text=CheckoutPanel.tsx"],
        settleMs: 1800,
        clip: "area",
        viewport: { width: 1290, height: 900 },
        stopAt: 500,
    },
    {
        /* Capture the hosted sandbox hub with its identity and status. */
        name: "menu-host",
        path: "/sandbox",
        waitFor: "text=Installed version",
        settleMs: 1200,
        clip: "area",
        viewport: { width: 1380, height: 900 },
        stopAt: 556,
    },
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

/* History routes and demo assets are served from the /demo build root. */
/* Serve the built widget with stubbed daemon endpoints for the visitor-page shot. */
const WIDGET_BUNDLE = join(repoRoot(import.meta.url), "_sandbox/webchat-widget/dist/widget.js");

const FRONT_DESK_CONFIG = {
    automationId: "front-desk",
    title: "Ask Northwind",
    greeting: "Hi! I'm the agent that builds this site. Ask me anything about the arms.",
    // Left as the daemon's own default (webchat-config.ts) rather than a colour picked for the shot: the
    // marketing image must show what an unconfigured Front Desk actually looks like.
    accent: "#e47100",
    position: "bottom-right",
    access: "public",
    requireName: false,
    antiBot: "off",
};

// Written in the deliberate voice of the thing being sold: an answer with a real detail in it, not "Hello! How
// may I assist you today?" — the sentence is doing the same job as the rest of the page's copy.
const FRONT_DESK_REPLY =
    "Yes — the RX-4 is rated IP66, so rain and dust are fine. Below -10°C you'll want the cold-weather grease kit, " +
    "which is a five-minute swap.\n\nWant me to open a ticket with our hardware team for your specific setup?";

const FRONT_DESK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Northwind Robotics</title>
<style>
  :root{color-scheme:${LIGHT ? `light` : `dark`}}
  body{margin:0;background:${LIGHT ? `#fbfaf9` : `#0b0d10`};color:${LIGHT ? `#1b1d20` : `#e6e8eb`};font:16px/1.65 ui-serif,Georgia,serif}
  header,main{max-width:54rem;margin:0 auto;padding:0 2.5rem}
  header{padding-top:5.5rem}
  .eyebrow{font:600 12px/1 ui-sans-serif,system-ui;letter-spacing:.14em;text-transform:uppercase;color:${LIGHT ? `#1a56c4` : `#8ab4f8`}}
  h1{font-size:3.1rem;line-height:1.08;letter-spacing:-.025em;margin:1rem 0 1rem}
  p{color:${LIGHT ? `#5f6368` : `#9aa0a6`};max-width:36rem}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.25rem;margin-top:3.5rem}
  .card{border:1px solid ${LIGHT ? `#e3e5e8` : `#1e2227`};border-radius:.75rem;padding:1.25rem;background:${LIGHT ? `#fff` : `#101318`}}
  .card h3{font:600 14px/1.3 ui-sans-serif,system-ui;margin:0 0 .4rem}
  .card p{font:13px/1.55 ui-sans-serif,system-ui;margin:0;color:${LIGHT ? `#70757a` : `#6b7280`}}
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
<script src="/webchat/widget.js" data-automation="front-desk" defer></script>
</body></html>`;

// The three widget routes, answered inline. Returns true when it handled the request.
const serveFrontDesk = (path: string, response: import("node:http").ServerResponse): boolean => {
    if (path === "/front-desk/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(FRONT_DESK_PAGE);
        return true;
    }
    if (path === "/webchat/widget.js") {
        if (!existsSync(WIDGET_BUNDLE)) {
            throw new Error(`the Front Desk shot needs the widget built first: pnpm --filter @intentic/webchat-widget build`);
        }
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        createReadStream(WIDGET_BUNDLE).pipe(response);
        return true;
    }
    if (path.endsWith("/config")) {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(FRONT_DESK_CONFIG));
        return true;
    }
    if (path.endsWith("/message")) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        // Streamed in pieces, like the real thing, so the shot can be taken mid- or post-stream either way.
        let at = 0;
        const tick = setInterval(() => {
            const chunk = FRONT_DESK_REPLY.slice(at, at + 14);
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
        if ((path === "/front-desk/" || path.startsWith("/webchat/")) && serveFrontDesk(path, response)) {
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
    for (const selector of [COMPOSER, CHAT_PANEL]) {
        const box = await page
            .locator(selector)
            .first()
            .boundingBox()
            .catch(() => null);
        if (box !== null) {
            return Math.round(box.x);
        }
    }
    // Loud on purpose: the quiet version of this line framed a whole run wrong.
    console.warn(`  [split not found] neither ${COMPOSER} nor ${CHAT_PANEL} — clipping to the full window instead`);
    return fallback;
};

/* Trim screenshots to the last visible content pixel plus padding. */
const contentBottom = async (page: Page, from: number, to: number): Promise<number> =>
    page.evaluate(
        ({ from: leftEdge, to: rightEdge }) => {
            const height = window.innerHeight;
            const rail = document.querySelector(`.icon-rail`)?.getBoundingClientRect();
            const left = rail === undefined ? leftEdge : Math.max(leftEdge, rail.right);
            let bottom = 0;
            for (const element of document.querySelectorAll("body *")) {
                const style = getComputedStyle(element);
                if (style.position === "fixed" || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
                    continue;
                }
                const box = element.getBoundingClientRect();
                if (box.width < 8 || box.height < 8 || box.left >= rightEdge || box.right <= left) {
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

/**
 * The dark twin's box, in CSS pixels, read from its PNG header.
 *
 * The two sets are pairs: the site lays out from the dark shot's dimensions and swaps the light one in underneath,
 * so a reader changing skin must not see the page reflow. Measuring the light run independently does not give that
 * — `composerLeft` locates the workspace/chat split by finding the composer, and when it cannot it silently falls
 * back to the whole viewport, which framed the first light run 800px wider than its pair. Framing from the twin is
 * right whether or not that measurement works, so it is what decides the box.
 */
const twinBox = (shot: Shot): { width: number; height: number } | undefined => {
    if (!LIGHT) {
        return undefined;
    }
    const twin = join(repoRoot(import.meta.url), "_site/site/src/assets/product", `${shot.name}.png`);
    if (!existsSync(twin)) {
        return undefined;
    }
    // IHDR carries width and height in the first 24 bytes; the rest of the file is of no interest here.
    const header = Buffer.alloc(24);
    const file = openSync(twin, "r");
    try {
        readSync(file, header, 0, 24, 0);
    } finally {
        closeSync(file);
    }
    const dpr = shot.dpr ?? DEFAULT_DPR;
    return { width: header.readUInt32BE(16) / dpr, height: header.readUInt32BE(20) / dpr };
};

const clipFor = async (page: Page, shot: Shot): Promise<{ x: number; y: number; width: number; height: number } | undefined> => {
    const twin = twinBox(shot);
    if (twin !== undefined) {
        const paired = shot.viewport ?? (shot.mobile === true ? MOBILE : DESKTOP);
        // A twin that fills the window was shot unclipped; keep it that way rather than inventing a box.
        if (twin.width >= paired.width - 1 && twin.height >= paired.height - 1) {
            return undefined;
        }
        // The chat is flush right, the workspace flush left: that is the whole of where a clip can start.
        return { x: shot.clip === "chat" ? paired.width - twin.width : 0, y: 0, width: twin.width, height: twin.height };
    }
    if (shot.clip === undefined) {
        return undefined;
    }
    const window = shot.viewport ?? DESKTOP;
    const split = await composerLeft(page, window.width);
    // 26px of gutter on the chat side of the split belongs to neither panel.
    const [x, width] = shot.clip === "area" ? [0, split - 26] : [split - 26, window.width - split + 26];
    if (shot.fullHeight === true) {
        return { x, y: 0, width, height: window.height };
    }
    const measured = await contentBottom(page, x, x + width);
    const height = Math.min(measured + TRIM_PAD, shot.stopAt ?? window.height, window.height);
    return { x, y: 0, width, height };
};

/* Resize and capture the browser window opened by the app. */
const shootPopout = async (page: Page, shot: Shot, popout: NonNullable<Shot["popout"]>): Promise<void> => {
    const [window] = await Promise.all([page.context().waitForEvent("page"), page.click(POPOUT_BUTTON, { timeout: 20_000 })]);
    try {
        window.on("pageerror", (error) => console.warn(`  [pageerror ${shot.name}/popout] ${error.message.split("\n")[0]}`));
        await window.setViewportSize({ width: popout.width, height: popout.height });
        // The popped-out window is the chat and nothing else, so the panel itself is what "it has rendered" means.
        await window.waitForSelector(CHAT_PANEL, { timeout: 20_000 });
        for (const target of popout.press ?? []) {
            await window.click(target, { timeout: 20_000 });
            await window.waitForTimeout(600);
        }
        await window.waitForTimeout(popout.settleMs ?? 1_200);
        await window.screenshot({ path: resolve(OUT_DIR, `${shot.name}.png`) });
    } finally {
        await window.close();
    }
};

/* Scroll the tallest eligible pane inside the requested clip. */
const scrollPane = async (page: Page, shot: Shot, by: number): Promise<void> => {
    const width = (shot.viewport ?? DESKTOP).width;
    const split = shot.clip === undefined ? width : await composerLeft(page, width);
    const [from, to] = shot.clip === "chat" ? [split - 26, width] : [0, shot.clip === "area" ? split - 26 : width];
    // Named apart from the outer three on purpose: the page's copy of them lives in another realm, and one
    // spelling for both is the kind of shadowing that reads as the same variable when it never can be.
    await page.evaluate(
        ({ pixels, left, right }) => {
            const scrollers = [...document.querySelectorAll<HTMLElement>(`body *`)].filter((element) => {
                const box = element.getBoundingClientRect();
                // Judged on its CENTRE, not on being contained: the scroller of a full-bleed surface runs under
                // the docked chat's gutter, and a containment test rejects the very box every shot means.
                const centre = box.left + box.width / 2;
                if (centre < left || centre > right || box.width < 160 || box.height < 160) {
                    return false;
                }
                const style = getComputedStyle(element);
                return /(auto|scroll)/.test(`${style.overflowY}`) && element.scrollHeight > element.clientHeight + 8;
            });
            const tallest = scrollers.toSorted((a, b) => b.clientHeight - a.clientHeight)[0];
            (tallest ?? document.scrollingElement ?? document.documentElement)?.scrollBy(0, pixels);
        },
        { pixels: by, left: from, right: to },
    );
};

const shoot = async (browser: Browser, shot: Shot): Promise<boolean> => {
    const context = await browser.newContext({
        viewport: shot.viewport ?? (shot.mobile === true ? MOBILE : DESKTOP),
        deviceScaleFactor: shot.dpr ?? DEFAULT_DPR,
        isMobile: shot.mobile ?? false,
        hasTouch: shot.mobile ?? false,
        colorScheme: LIGHT ? "light" : "dark",
    });
    // TWO preferences decide how the app looks, and the light set needs both.
    //
    // `ui-skin` is the bigger of the two. Sanctum is the site's own carved design worn by the app, and it is DARK BY
    // CONSTRUCTION — its README says turning it on forces the dark scheme — so the light set is the app with no skin,
    // which is exactly the light theme the desk pages are built from. The dark set keeps Sanctum, which is why those
    // shots sit so well on the carved pages.
    //
    // Both are written before the app boots, and the app applies them itself: `definePreference` reads storage at
    // load and writes `data-mode`/`data-skin` onto <html> from it. An earlier version of this also forced the
    // attributes from a MutationObserver over the whole document; that fired on every node the app rendered and
    // stalled the boot far enough that the docked chat never mounted, which silently cost the two popped-out shots
    // and mis-framed every clipped one.
    await context.addInitScript(
        ({ scheme, skin }: { scheme: string; skin: string }) => {
            window.localStorage.setItem(`ui-color-scheme`, scheme);
            window.localStorage.setItem(`ui-skin`, skin);
        },
        LIGHT ? { scheme: `light`, skin: `none` } : { scheme: `dark`, skin: `sanctum` },
    );
    /* Set fixture mode before app boot so every navigation keeps it. */
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
            await scrollPane(page, shot, shot.scrollTo);
            await page.waitForTimeout(600);
        }
        if (shot.popout !== undefined) {
            await shootPopout(page, shot, shot.popout);
            console.log(`  ✓ ${shot.name} → ${shot.path} (popped out)`);
            return true;
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
    const only = process.argv.slice(2).filter((argument) => !argument.startsWith(`--`));
    const wanted = only.length === 0 ? SHOTS : SHOTS.filter((shot) => only.includes(shot.name));
    if (wanted.length === 0) {
        throw new Error(`No shot matches ${only.join(", ")} — known: ${SHOTS.map((shot) => shot.name).join(", ")}`);
    }
    // Only the app shots need the demo build; a `raw` one brings its own world, so re-shooting just the
    // Front Desk shouldn't cost a full SPA build.
    if (wanted.some((shot) => shot.raw !== true) && !existsSync(join(DEMO_DIR, "index.html"))) {
        throw new Error(`No demo build at ${DEMO_DIR} — run: pnpm --filter @intentic/demo build`);
    }

    mkdirSync(OUT_DIR, { recursive: true });
    const server = serveDemo();
    // The full baked chromium rather than the headless shell; ../playwright.config.ts carries the reasoning.
    const browser = await chromium.launch({ channel: "chromium" });
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
    console.log(`${wanted.length - failed}/${wanted.length} ${LIGHT ? `light` : `dark`} shots written to ${OUT_DIR}`);
};

await run();
