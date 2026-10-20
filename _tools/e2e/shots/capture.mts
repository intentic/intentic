/* Marketing screenshot harness. */
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

const DEMO_DIR = join(repoRoot(import.meta.url), "_site/site/public/demo");

// The site ships two skins, so it needs two sets of these. `--light` drives the app in its light scheme and writes
// the twin set; the site pairs them by filename (see _site/site/src/lib/shots.ts). Both wear the Mist wallpaper, which
// draws behind the board and the card pages: the dark set over Sanctum, the light set over the plain light look.
//
// Every shot of the code workspace is taken of the demo's `showcase` recording (_site/demo/src/mode.ts): seven agents on
// an ordinary afternoon, served QUIET, so no card carries a cooling cache, a teammate's reaction or a key it is waiting
// for, no pipeline is failing and nothing on the rail asks for attention it does not need. The recording's every-state
// richness is for a visitor exploring the demo; a screenshot is a picture of the workspace at rest.
//
// `--desk` is a third run over the light set: the desk recording (_site/demo/src/fixture/desk.ts, documents rather
// than code, read as a maker) shot for the desk edition of the landing page. Those shots have no dark twin — the desk
// edition is only ever light — so they frame themselves, and are named `desk-*` in the same directory.
//
// A shot that is gone from the catalogues below is gone from the site: delete its two files with it, since
// src/lib/shots.ts globs the directories and a stale picture is a picture nobody re-shoots.
const DESK = process.argv.includes("--desk");
const LIGHT = process.argv.includes("--light") || DESK;
const OUT_DIR = join(repoRoot(import.meta.url), `_site/site/src/assets/${LIGHT ? "product-light" : "product"}`);
const PORT = 47_147;
const ORIGIN = `http://localhost:${PORT}`;
/* Serve the demo under its configured /demo base. */
const BASE = "/demo";
// `DEMO_URL` points the run at a demo dev server instead (`pnpm -C _site/demo dev --port 47148`, then
// DEMO_URL=http://127.0.0.1:47148/demo): the same app with no build step, which is what iterating on a frame wants.
const DEMO_URL = process.env["DEMO_URL"]?.replace(/\/$/u, "");
const demoUrl = (path: string): string => `${DEMO_URL ?? `${ORIGIN}${BASE}`}${path}`;

// THE FRAMES DECIDE THE SHAPES. Every frame on the site is a fixed box the picture fills edge to edge (Landing.astro and
// DeskLanding.astro over home.css): the hero's centre window and every tour stage are 16:9, the hero's two wings are
// portraits (1:2 and 5:9), and the Features menu's preview is about 21rem by 19rem. A shot taken at its box's own shape
// is drawn whole, at 100%. The set this replaced was taken at other shapes and drawn 112% to 222% wide to fill the box,
// which cut the board's Finished lane in half and kept only the left edge of both wings. So every shot below is taken
// in a window of its frame's shape, and the frames draw it at 100%.
//
// The windows are smaller than a desktop monitor on purpose, at twice the density or more. A frame on the page is up to
// 1440px wide, so a 1440px window shows the app's own 13px text at 13px there; the 1760px windows before drew it at
// about 10, which is why every card on the old board read as grey noise.
const DESKTOP = { width: 1440, height: 810 } as const;
// Two cards to a row instead of three or one-and-a-leftover: the same 16:9, drawn larger.
const SNUG = { width: 1152, height: 648 } as const;
const MOBILE = { width: 430, height: 932 };
// The Features menu's preview window is 336x304 and the shot covers it: the window's own shape, as small as the app
// stays a desktop app (under 768px it is the phone shell, back arrows and all).
const MENU = { width: 840, height: 760 } as const;
// The hero's two wings, as chat columns: the plan at 1:2 and the report at 5:9. Each is the docked chat at that width
// (ui-chat-width) and that height, so the clip of the chat is exactly the wing's shape. The report's is the wider of
// the two so the agent's whole account fits under the chat's header, with no row cut off at the top.
const PLAN_WING = { chat: 400, height: 800 } as const;
const REPORT_WING = { chat: 480, height: 864 } as const;
// What the chat column does not own, which a wing's window adds to the column it asks for: the terminal's dock along the
// window's foot (29px; the desk has no terminal, so no dock) and the 1px seam the column's width counts.
const TERMINAL_DOCK = 29;
const CHAT_SEAM = 1;
/* Narrow sources use 3× density; wide sources use 2×; the snug pages 2.5× so they match a 1440 window's pixels. */
const DENSE_DPR = 3;
const DEFAULT_DPR = 2;
const SNUG_DPR = 2.5;

// Hide demo-only chrome and tooltips from screenshots. Installed on the CONTEXT rather than the page, because the
// popped-out chat is a window the app opens for itself and a style tag added to the opener never reaches it: both
// hero-chat shots shipped with the demo's mode switcher sitting across the bottom of the frame.
//
// Also hidden: the parked chat's pill (`.chat-quick-seat`), which floats over the middle of any page the chat is not
// docked beside and reads as a toast caught mid-flight; scrollbars, which a capture freezes at whatever length the
// recording happened to load; and the caret.
const HIDE_DEMO_CHROME = `#demo-switcher, .ui-tooltip, .chat-quick-seat { display: none !important; }
* { scrollbar-width: none !important; caret-color: transparent !important; }
*::-webkit-scrollbar { display: none !important; }`;

// WHERE THE WORKSPACE ENDS AND THE CHAT BEGINS. Every desktop surface shares the shell, so one landmark decides it
// for all of them. A stale landmark here is expensive and quiet: when the composer's textarea stopped matching, the
// split fell back to the whole viewport and every clipped shot came out ~400px too wide, with nothing in the log to
// say so. Hence two of them and a loud failure when neither is found.
//
// The PANEL is the landmark and the composer is only the fallback, because the panel's left edge IS the boundary
// while the textarea sits 20px inside it. Asking the textarea first put the split 20px into the chat, which let the
// chat's own boxes into the workspace band: shots that should have trimmed to a 314px-tall diff measured the
// composer at the foot of the window instead and came out full-height, most of them empty canvas.
const CHAT_PANEL = ".chat-panel";
const COMPOSER = 'textarea[name="draft"]';

// The featured run's plan, parked for a yes. Every shot with the chat in it waits for this: each page load replays the
// run from its start, and a frame taken before the plan lands shows the chat mid-read with a status pill and no plan.
const PLAN_WAITING = "text=Plan waiting for your approval";

// A row in the Changes list, by file name. Scoped to the list on purpose: the plan in the docked chat names the same
// files as links, it comes first in the document, and an unscoped `text=` click opened the file plain from the chat
// instead of its diff from the list, which is how the review shots lost their diff.
const changesRow = (file: string): string => `div[class~="group/file"] button:has-text("${file}")`;

// The connector cards (GitHub, GitLab, Sentry, PostgreSQL, Stripe…), Discord's and Slack's are extensions, so a catalogue
// shot switches on exactly those: the tiles are the subject, and no other extension's icon joins the rail beside them.
const CONNECTOR_EXTENSIONS = ["intentic.connectors", "intentic.discord", "intentic.slack"] as const;
// The desk's connections: where a maker's mail, calendar and messages live. Its own two extensions (the Projects home
// and the viewers) stay on, as in every desk shot.
const DESK_CONNECTIONS = [
    "intentic.projects",
    "intentic.viewers",
    "intentic.google-workspace",
    "intentic.microsoft-365",
    "intentic.imap",
    "intentic.telegram",
    "intentic.whatsapp",
] as const;

// The desk recording's two special conversations (_site/demo/src/fixture/desk.ts): the scripted run, and the finished draft.
const DESK_FEATURED = "cnv_desk_newsletter";
const DESK_REVIEW = "cnv_desk_september";

// The chat docked to the rail rather than beside the page, for a shot whose subject is the page: the board gets the
// window's whole width, and its three lanes their full card width.
const CHAT_ON_RAIL = { "ui-chat-home": "rail" } as const;

interface Shot {
    name: string;
    path: string;
    mobile?: boolean;
    /* Open this route first to establish the shared docked conversation. */
    openFirst?: string;
    /** Text or selector the surface is not itself until it renders; several are waited for in order. */
    waitFor?: string | readonly string[];
    /** Controls to open, in order, once the surface has rendered — for a panel whose CONTENT is the story. */
    click?: string[];
    settleMs?: number;
    /** `area` keeps the workspace left of the docked chat; `chat` keeps the chat. Absent ⇒ the whole viewport. */
    clip?: "area" | "chat";
    /**
     * Keep only these elements: the box around all of them (each selector's last match, so the innermost of nested
     * ones), plus a gutter. For a feature block about one panel, where the page around it is only distance.
     */
    region?: readonly string[];
    /* Stop trimming at this content-specific editorial floor. */
    stopAt?: number;
    /** The demo recording; `showcase` unless a shot names another. `desk` is the documents recording. */
    mode?: "showcase" | "desk";
    /** A disturbance the quiet recording should still serve, for a shot that is a picture of it. */
    keep?: readonly "proposal"[];
    /**
     * Which extensions are switched on, overriding the recording's own list (the showcase's is none).
     *
     * The rail carries one icon and one badge per enabled extension, so only a shot whose subject an extension draws
     * switches one on: the catalogue its connector cards, Automations its own page.
     */
    extensions?: readonly string[];
    /** App preferences written before boot, on top of the look: where the chat docks, how wide, the text size. */
    storage?: Readonly<Record<string, string>>;
    /** Overrides the shared desktop window, for a shot whose frame has another shape. */
    viewport?: { width: number; height: number };
    /** Overrides the device scale factor. Narrow sources need the extra rungs; wide ones already overshoot. */
    dpr?: number;
    /** Scroll the main column before shooting, by pixels or until this selector's element is at the top. */
    scrollTo?: number | string;
    /* Serve this path directly from the harness origin. */
    raw?: true;
    /** Type into a field once the surface is up, for a shot whose story is a conversation. */
    type?: { target: string; text: string; settleMs?: number };
    /* Preserve the full window height instead of trimming content. */
    fullHeight?: true;
}

// A wing of the hero: the docked chat alone, at the wing's width and height, cut at the column's own foot.
const wing = (column: { chat: number; height: number }, dock = TERMINAL_DOCK): Pick<Shot, "clip" | "viewport" | "storage" | "dpr"> => ({
    clip: "chat",
    viewport: { width: DESKTOP.width, height: column.height + dock },
    storage: { "ui-chat-width": String(column.chat + CHAT_SEAM) },
    dpr: DENSE_DPR,
});

const SHOTS: Shot[] = [
    // A CUSTOMER'S website with the Visitor chat open on it. Its own window, since the subject is not our app.
    {
        name: "visitor-chat",
        path: "/visitor-chat/",
        raw: true,
        viewport: { width: 1440, height: 900 },
        waitFor: "intentic-visitor-chat",
        click: ["intentic-visitor-chat .launcher"],
        type: { target: "intentic-visitor-chat textarea", text: "Do these arms work outdoors?", settleMs: 2600 },
        settleMs: 900,
    },

    // THE HERO. Its centre window rotates between the board and a review; its two wings stand either side of it: the
    // plan an agent is waiting on (before) and the report another one left (after).
    //
    // The board with the chat parked on the rail, so its three lanes get the whole window: one card asking for you,
    // three at work, three done (the showcase roster, _site/demo/src/mode.ts). Opened from a conversation first, since
    // without one the Active lane leads with an empty "New agent" draft card. Also the Agent Workspace page's hero, and
    // the board Automations shows its runs arriving on.
    {
        name: "hero-agents",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=ATTENTION",
        settleMs: 1400,
        storage: CHAT_ON_RAIL,
    },
    // A finished run waiting for a yes, open on the route file: a whole file with three small edits in it
    // (fixture/workspace.ts, USERS_ROUTE_*), where the schema's eleven lines left two thirds of the frame empty.
    {
        name: "hero-review",
        path: "/agents/cnv_soft_deletes",
        openFirst: "/agents/cnv_soft_deletes",
        waitFor: "text=Land now",
        click: [changesRow("users.ts")],
        settleMs: 1600,
        storage: CHAT_ON_RAIL,
    },
    // The left wing: the plan the checkout agent wrote, and the bar that waits for a yes. Also the Approvals page's
    // hero, drawn whole there.
    {
        name: "chat-plan",
        path: "/workspace",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: PLAN_WAITING,
        settleMs: 1200,
        ...wing(PLAN_WING),
    },
    // The right wing: the soft-deletes agent's own account of what it did, on its branch, beside the review it opens.
    {
        name: "hero-report",
        path: "/agents/cnv_soft_deletes",
        openFirst: "/agents/cnv_soft_deletes",
        waitFor: "text=held on",
        settleMs: 1600,
        ...wing(REPORT_WING),
    },

    // THE TOUR: one 16:9 stage per Features page, each a different surface. Only the first keeps the chat docked
    // beside the page (a plan waiting in it); the others are their own page at full width, since the same chat in four
    // frames in a row read as one picture four times.
    {
        name: "stage-run",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: ["text=ATTENTION", PLAN_WAITING],
        settleMs: 1400,
        storage: { "ui-chat-width": "400" },
    },
    // The catalogue with the connector extensions on: the shipped catalogue (fixture/sandbox.ts reads the real
    // manifests), so its rows are full of the services a reader recognises. Also the Integrations page's hero. A little
    // over the shared window, 16:9 still, so the catalogue's foot (the window less 53px) falls in the 8px gap under the
    // first row of Business & docs (Outline, Notion, Stripe) rather than through a row of tiles.
    {
        name: "stage-connect",
        path: "/capabilities",
        waitFor: "text=Connected",
        settleMs: 1200,
        extensions: CONNECTOR_EXTENSIONS,
        storage: CHAT_ON_RAIL,
        viewport: { width: 1472, height: 828 },
    },
    // The finished run beside its own chat: the branch, the files, the route's diff, Land now, and the agent's report.
    {
        name: "stage-review",
        path: "/agents/cnv_soft_deletes",
        openFirst: "/agents/cnv_soft_deletes",
        waitFor: ["text=Land now", "text=held on"],
        click: [changesRow("users.ts")],
        settleMs: 1800,
        storage: { "ui-chat-width": "400" },
    },
    // The machines the sandboxes run on: a Windows desktop, an Ubuntu build server and a Mac, each with what it runs
    // (fixture/devices.ts, quiet), one row of three. Also the Self-hosting page's hero.
    {
        name: "stage-host",
        path: "/sandbox/devices",
        waitFor: "text=build-box",
        settleMs: 1400,
        storage: CHAT_ON_RAIL,
    },

    // THE FEATURE PAGES' BLOCKS: drawn whole in the page's column, so their shapes are their content's.
    // The board on a phone: the same app, its own shell.
    {
        name: "mobile-fleet",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        mobile: true,
        waitFor: "text=ATTENTION",
        settleMs: 1400,
        dpr: DENSE_DPR,
    },
    // A connection not made yet, so the card is the add form and what it will add, rather than a second GitHub
    // ("github-2") under the one already connected.
    {
        name: "capability-add",
        path: "/capabilities",
        waitFor: 'text="GitLab"',
        click: ['text="GitLab"'],
        settleMs: 1400,
        extensions: CONNECTOR_EXTENSIONS,
        storage: CHAT_ON_RAIL,
        // The form and the panel beside it; the box around the two takes in the card's head above the form too.
        region: ['form:has-text("Access token")', 'aside:has-text("This will add to your sandbox")'],
    },
    // The Changes tab, the checkout panel's diff open beside the list, at the window's whole width.
    {
        name: "workspace-changes",
        path: "/workspace",
        waitFor: 'button:has-text("Changes")',
        click: ['button:has-text("Changes")', changesRow("CheckoutPanel.tsx")],
        settleMs: 1800,
        storage: CHAT_ON_RAIL,
    },
    // The change an agent proposed to the sandbox's image, waiting for the owner's yes: the one disturbance a shot is OF.
    // The Environment section alone, without the settings column beside it.
    {
        name: "sandbox-environment",
        path: "/sandbox/environment",
        waitFor: 'button:text-is("Recipe")',
        click: ['button:text-is("Recipe")'],
        settleMs: 1600,
        keep: ["proposal"],
        storage: CHAT_ON_RAIL,
        viewport: { width: 1440, height: 900 },
        region: ['section:has(button:text-is("Recipe"))'],
    },
    // A month of spend per day and who spent it, without the plan limits above it or the token-savings cards below:
    // those numbers are the recording's, and a marketing page that shows them reads as a benchmark we never measured.
    {
        name: "sandbox-spend",
        path: "/sandbox/usage",
        waitFor: "text=Cost per day",
        settleMs: 1800,
        storage: CHAT_ON_RAIL,
        viewport: { width: 1440, height: 900 },
        scrollTo: "text=Cost per day",
        region: ['.ui-card:has-text("Cost per day")', '.ui-card:has-text("Cost by agent")'],
    },

    // THE FEATURES MENU'S PREVIEWS: one per row, each its page's surface in the preview window's own shape.
    { name: "menu-run", path: "/agents", openFirst: "/agents/cnv_checkout_stripe", waitFor: "text=ATTENTION", settleMs: 1400, storage: CHAT_ON_RAIL, viewport: MENU },
    {
        name: "menu-connect",
        path: "/capabilities",
        waitFor: "text=Connected",
        settleMs: 1200,
        extensions: CONNECTOR_EXTENSIONS,
        storage: CHAT_ON_RAIL,
        viewport: MENU,
    },
    // Automations is an extension, so this shot is the one that switches it on.
    {
        name: "menu-automate",
        path: "/ext/automations",
        waitFor: "text=CODE CHORES",
        settleMs: 1600,
        extensions: ["intentic.automations"],
        storage: CHAT_ON_RAIL,
        viewport: MENU,
    },
    // The review in a window half again the menu's size: under about 900px the review folds its file list and its
    // Land now away, which are the two things this preview is of.
    {
        name: "menu-review",
        path: "/agents/cnv_soft_deletes",
        openFirst: "/agents/cnv_soft_deletes",
        waitFor: "text=Land now",
        click: [changesRow("users.ts")],
        settleMs: 1600,
        storage: CHAT_ON_RAIL,
        viewport: { width: MENU.width * 1.5, height: MENU.height * 1.5 },
        dpr: 1.5,
    },
    { name: "menu-host", path: "/sandbox/devices", waitFor: "text=build-box", settleMs: 1400, storage: CHAT_ON_RAIL, viewport: MENU },
];

// THE DESK EDITION'S SHOTS: the same frames the developer page has, on the desk recording. Every one runs in `desk`
// mode, whose own two extensions (the Projects home and the viewers) stay on: a maker's rail is those and the core, and
// the shot should be of what they see.
const DESK_SHOTS: Shot[] = [
    // The board, as the hero's first frame: one assistant working on the newsletter, one waiting on a question about a
    // letter, one finished draft to read, one sorting job already accepted. In the snug window, since the desk's four
    // cards across three lanes in the wide one left the frame two thirds wallpaper.
    {
        name: "desk-hero-agents",
        path: "/agents",
        openFirst: `/agents/${DESK_FEATURED}`,
        waitFor: "text=ATTENTION",
        settleMs: 1400,
        storage: CHAT_ON_RAIL,
        viewport: SNUG,
        dpr: SNUG_DPR,
        mode: "desk",
    },
    // A document open in the desk's files, drawn as a document: last month's newsletter, the one the finished draft
    // reworked, beside the folder it lives in.
    {
        name: "desk-hero-files",
        path: "/workspace/newsletter/september.md",
        openFirst: `/agents/${DESK_FEATURED}`,
        waitFor: "text=September at the studio",
        settleMs: 1400,
        storage: CHAT_ON_RAIL,
        viewport: SNUG,
        dpr: SNUG_DPR,
        mode: "desk",
    },
    // The left wing: the plan the assistant wrote for the October newsletter, Approve in the bar below it.
    { name: "desk-hero-plan", path: "/workspace", openFirst: `/agents/${DESK_FEATURED}`, waitFor: PLAN_WAITING, settleMs: 1200, ...wing(PLAN_WING, 0), mode: "desk" },
    // The right wing: the finished draft's conversation, ending on the two copies it made (a Word file and a web page).
    {
        name: "desk-hero-chat",
        path: `/agents/${DESK_REVIEW}`,
        openFirst: `/agents/${DESK_REVIEW}`,
        waitFor: "text=september.html",
        settleMs: 1600,
        ...wing(REPORT_WING, 0),
        mode: "desk",
    },
    {
        name: "desk-stage-run",
        path: "/agents",
        openFirst: `/agents/${DESK_FEATURED}`,
        waitFor: ["text=ATTENTION", PLAN_WAITING],
        settleMs: 1400,
        storage: { "ui-chat-width": "400" },
        mode: "desk",
    },
    // The desk's connections: mail, calendar and messages, which is what the tour's line promises. The Communication
    // shelf of the catalogue, two to a row in a window small enough that the app draws it two to a row.
    {
        name: "desk-stage-connect",
        path: "/capabilities",
        waitFor: "text=Connected",
        click: ['button:has-text("Communication")'],
        settleMs: 1200,
        extensions: DESK_CONNECTIONS,
        storage: CHAT_ON_RAIL,
        viewport: { width: 1024, height: 576 },
        dpr: 2.8125,
        mode: "desk",
    },
    // A finished draft, held for a yes, opened to check before accepting it: the September newsletter as a page in the
    // shop's own style, over the review it came from. The review itself is a row of two downloads on an empty page.
    {
        name: "desk-stage-review",
        path: `/agents/${DESK_REVIEW}`,
        openFirst: `/agents/${DESK_REVIEW}`,
        waitFor: "text=Results",
        click: ["main >> text=september.html >> nth=0"],
        settleMs: 2400,
        storage: { "ui-chat-width": "400" },
        mode: "desk",
    },
    // The computers the desk can live on, the same quiet fleet as the developer page's stage.
    { name: "desk-stage-host", path: "/sandbox/devices", waitFor: "text=build-box", settleMs: 1400, storage: CHAT_ON_RAIL, mode: "desk" },
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

const VISITOR_CHAT_CONFIG = {
    automationId: "visitor-chat",
    title: "Ask Northwind",
    greeting: "Hi! I'm the agent that builds this site. Ask me anything about the arms.",
    // Left as the daemon's own default (webchat-config.ts) rather than a colour picked for the shot: the
    // marketing image must show what an unconfigured Visitor chat actually looks like.
    accent: "#e47100",
    position: "bottom-right",
    access: "public",
    requireName: false,
    antiBot: "off",
};

// Written in the deliberate voice of the thing being sold: an answer with a real detail in it, not "Hello! How
// may I assist you today?" — the sentence is doing the same job as the rest of the page's copy.
const VISITOR_CHAT_REPLY =
    "Yes — the RX-4 is rated IP66, so rain and dust are fine. Below -10°C you'll want the cold-weather grease kit, " +
    "which is a five-minute swap.\n\nWant me to open a ticket with our hardware team for your specific setup?";

// A customer's site, laid out so the widget sits in its own column: the copy and the cards keep to the left two thirds,
// where the old single centred column ran its third card under the open chat. A bar and a row of the customer's own
// customers below make it read as somebody's real front page rather than a test fixture with a bubble on it.
const VISITOR_CHAT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Northwind Robotics</title>
<style>
  :root{color-scheme:${LIGHT ? `light` : `dark`};--ink:${LIGHT ? `#1b1d20` : `#e6e8eb`};--muted:${LIGHT ? `#5f6368` : `#9aa0a6`};--quiet:${LIGHT ? `#80868b` : `#6b7280`};--line:${LIGHT ? `#e3e5e8` : `#1e2227`};--card:${LIGHT ? `#fff` : `#101318`};--accent:${LIGHT ? `#1a56c4` : `#8ab4f8`}}
  *{box-sizing:border-box}
  body{margin:0;background:${LIGHT ? `#fbfaf9` : `#0b0d10`};color:var(--ink);font:16px/1.65 ui-serif,Georgia,serif}
  .bar{display:flex;align-items:center;gap:2.5rem;height:4.5rem;padding:0 6rem;border-bottom:1px solid var(--line);font:500 14px/1 ui-sans-serif,system-ui}
  .brand{display:flex;align-items:center;gap:.6rem;font-weight:700;font-size:15px;letter-spacing:-.01em;margin-right:auto}
  .mark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--accent),${LIGHT ? `#0d3b8c` : `#3b6fd4`})}
  .bar a{color:var(--muted);text-decoration:none}
  .bar .cta{color:var(--ink);border:1px solid var(--line);border-radius:999px;padding:.55rem 1rem;background:var(--card)}
  main{padding:7.5rem 6rem 0;max-width:62rem}
  .eyebrow{font:600 12px/1 ui-sans-serif,system-ui;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
  h1{font-size:3.3rem;line-height:1.06;letter-spacing:-.025em;margin:1.1rem 0 1.1rem;max-width:46rem;text-wrap:balance}
  p{color:var(--muted);max-width:34rem;margin:0}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.25rem;margin-top:3.25rem}
  .card{border:1px solid var(--line);border-radius:.75rem;padding:1.25rem 1.3rem;background:var(--card)}
  .card h3{font:600 14px/1.3 ui-sans-serif,system-ui;margin:0 0 .45rem;color:var(--ink)}
  .card p{font:13px/1.55 ui-sans-serif,system-ui;color:var(--quiet)}
  .used{display:flex;gap:2.25rem;align-items:baseline;margin-top:3.5rem;font:600 12px/1 ui-sans-serif,system-ui;letter-spacing:.08em;text-transform:uppercase;color:var(--quiet)}
  .used b{font-weight:600;color:var(--muted);letter-spacing:.02em;text-transform:none;font-size:14px}
</style></head><body>
<nav class="bar">
  <span class="brand"><span class="mark"></span>Northwind Robotics</span>
  <a>Arms</a><a>Controllers</a><a>Industries</a><a>Support</a><a class="cta">Request a quote</a>
</nav>
<main>
  <span class="eyebrow">Industrial robotics</span>
  <h1>Arms that pick things up, in weather that would rather they didn't.</h1>
  <p>The RX series runs outdoors, on ships, and in cold stores — the same arm, the same controller, no enclosure.</p>
  <div class="grid">
    <div class="card"><h3>IP66 sealed</h3><p>Rain, dust and wash-down without an enclosure.</p></div>
    <div class="card"><h3>-30°C to 55°C</h3><p>Cold-store rated with the winter grease kit.</p></div>
    <div class="card"><h3>One controller</h3><p>Every arm in the range speaks the same protocol.</p></div>
  </div>
  <div class="used">In service at <b>Halden Port</b><b>Kestrel Cold Chain</b><b>Arvo Marine</b></div>
</main>
<script src="/webchat/widget.js" data-automation="visitor-chat" defer></script>
</body></html>`;

// The three widget routes, answered inline. Returns true when it handled the request.
const serveVisitorChat = (path: string, response: import("node:http").ServerResponse): boolean => {
    if (path === "/visitor-chat/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(VISITOR_CHAT_PAGE);
        return true;
    }
    if (path === "/webchat/widget.js") {
        if (!existsSync(WIDGET_BUNDLE)) {
            throw new Error(`the Visitor chat shot needs the widget built first: pnpm --filter @intentic/webchat-widget build`);
        }
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        createReadStream(WIDGET_BUNDLE).pipe(response);
        return true;
    }
    if (path.endsWith("/config")) {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(VISITOR_CHAT_CONFIG));
        return true;
    }
    if (path.endsWith("/message")) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        // Streamed in pieces, like the real thing, so the shot can be taken mid- or post-stream either way.
        let at = 0;
        const tick = setInterval(() => {
            const chunk = VISITOR_CHAT_REPLY.slice(at, at + 14);
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
        if ((path === "/visitor-chat/" || path.startsWith("/webchat/")) && serveVisitorChat(path, response)) {
            return;
        }
        const routed = path.startsWith(`${BASE}/`) ? path.slice(BASE.length) : path;
        const asset = join(DEMO_DIR, normalize(decodeURIComponent(routed)));
        const file = existsSync(asset) && statSync(asset).isFile() ? asset : join(DEMO_DIR, "index.html");
        // A run against DEMO_URL has no build here, and a stray request must not take the whole run down with it.
        if (!existsSync(file)) {
            console.warn(`  [unserved] ${path}`);
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        createReadStream(file).pipe(response);
    });
    server.listen(PORT, "localhost");
    return server;
};

/** Where the docked chat starts — the split every desktop clip is taken on. */
const composerLeft = async (page: Page, fallback: number): Promise<number> => {
    for (const selector of [CHAT_PANEL, COMPOSER]) {
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

/** The gutter left under the content, so a trimmed shot ends on breathing room rather than on a card's edge. */
const TRIM_PAD = 24;

// How far a cut may be pulled back to clear the element it crossed. Past this the shot keeps the cut it asked for:
// a snap that travels further is no longer tidying a frame, it is deleting a section of one.
const SNAP_LIMIT = 340;

// A box this much of the frame or more is a panel, a lane or a toolbar — scenery every cut is necessarily inside,
// so it cannot veto one. Cards, rows, tiles and buttons all sit well under it, and those are what may not be sliced.
const SCENERY = 0.45;

/* The strip at the foot of a frame checked for a widowed heading, and the height under which a box is a label. */
const WIDOW_BAND = 52;
const LABEL_HEIGHT = 30;

/**
 * Where to cut a shot's bottom and right edges: at the end of the content, or — when the frame stops short of it —
 * on a line that crosses no element.
 *
 * Trimming to the last inked pixel is not enough on its own. A `stopAt` floor, or a clip that stops at the docked
 * chat, lands wherever the layout happens to put it, and the shots that shipped show what that costs: a row of
 * capability tiles cut through their middles, a diff cut mid-line, the "New agent" button cut down its shaft. So a
 * cut that lands inside the content walks back to the nearest line that crosses nothing, and the frame ends on a
 * gap between cards instead of through one.
 */
const contentFrame = async (page: Page, band: { left: number; floorY: number; floorX: number }): Promise<{ bottom: number; right: number }> =>
    page.evaluate(
        ({ left: leftEdge, floorY, floorX, pad, limit, scenery, widow, label }) => {
            const rightEdge = floorX;
            const height = window.innerHeight;
            const rail = document.querySelector(`.icon-rail`)?.getBoundingClientRect();
            const left = rail === undefined ? leftEdge : Math.max(leftEdge, rail.right);
            const boxes: DOMRect[] = [];
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
                if (ink) {
                    boxes.push(box);
                }
            }
            // 1px of slack either side: a cut that grazes a box's own edge is landing in the gap, not through it.
            // Only boxes short enough to sit wholly inside the frame get a say; a panel or a lane is scenery the cut
            // is necessarily within, and letting those vote means no line is ever clear.
            const crossed = (y: number): boolean => boxes.some((box) => box.height < height * scenery && box.top < y - 1 && box.bottom > y + 1);
            // Walks up from the asked-for cut to the first line that crosses nothing, giving up — and keeping the
            // asked-for cut — once it has travelled further than tidying a frame could justify.
            const walkBack = (asked: number): number => {
                for (let line = Math.round(asked); line > asked - limit; line -= 1) {
                    if (!crossed(line)) {
                        return line;
                    }
                }
                return Math.round(asked);
            };
            // Never end on a widowed section heading. A clear line often falls in the gap a heading opens ABOVE its
            // own rows, which leaves the shot ending on a label with nothing under it — "PLAN LIMITS", "AGENT
            // ENGINES" — and that reads as a cut through the section rather than as a list that carries on. So when
            // the last band of the frame holds nothing but label-height boxes, the cut goes above them instead.
            const unwidow = (line: number): number => {
                // Boxes wholly inside the last band. Ones that merely reach into it from above are the card the
                // heading follows; ones that run out through the cut are the section it heads, which is exactly the
                // thing being widowed. Counting either made the guard decline every time.
                const tail = boxes.filter((box) => box.top > line - widow && box.bottom <= line);
                if (tail.length === 0 || Math.max(...tail.map((box) => box.height)) > label) {
                    return line;
                }
                const above = Math.floor(Math.min(...tail.map((box) => box.top))) - 8;
                return above > 0 && !crossed(above) ? above : line;
            };
            const inked = (pick: (box: DOMRect) => number): number => Math.ceil(Math.max(0, ...boxes.map(pick)));
            const bottomInk = inked((box) => box.bottom);
            return {
                // A floor past the end of the content is already in empty canvas, so it needs no snapping, only the
                // pad — and no widow guard either, since a short last row there is the end of the list, not a
                // heading over rows the frame cut off.
                bottom: bottomInk + pad <= floorY ? bottomInk + pad : unwidow(walkBack(floorY)),
                // The right edge is never snapped, only trimmed. Its floor is a real layout boundary that content is
                // entitled to reach, and the only lines clear of a lane grid are the gaps BETWEEN lanes — so a snap
                // here does not tidy an edge, it deletes a column.
                right: Math.min(floorX, inked((box) => box.right) + pad),
            };
        },
        {
            left: band.left,
            floorY: band.floorY,
            floorX: band.floorX,
            pad: TRIM_PAD,
            limit: SNAP_LIMIT,
            scenery: SCENERY,
            widow: WIDOW_BAND,
            label: LABEL_HEIGHT,
        },
    );

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

interface Clip {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A light shot's frame, copied from its dark twin. `full` is a twin that filled its window, i.e. was not clipped. */
const twinClip = (shot: Shot): Clip | "full" | undefined => {
    // A region is found by its own elements in either look, so it needs no twin to tell it where it is.
    if (shot.region !== undefined) {
        return undefined;
    }
    const twin = twinBox(shot);
    if (twin === undefined) {
        return undefined;
    }
    const paired = shot.viewport ?? (shot.mobile === true ? MOBILE : DESKTOP);
    if (twin.width >= paired.width - 1 && twin.height >= paired.height - 1) {
        return "full";
    }
    // The chat is flush right, the workspace flush left: that is the whole of where a clip can start.
    return { x: shot.clip === "chat" ? paired.width - twin.width : 0, y: 0, width: twin.width, height: twin.height };
};

// A region's gutter: enough to clear a card's own shadow, short of the next column's controls (the settings list
// stands 34px left of the section beside it).
const REGION_PAD = 14;

/** The box around every element a region names, plus its gutter, kept inside the window. */
const regionClip = async (page: Page, shot: Shot, selectors: readonly string[]): Promise<Clip> => {
    const window = shot.viewport ?? DESKTOP;
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    for (const selector of selectors) {
        const box = await page
            .locator(selector)
            .last()
            .boundingBox()
            .catch(() => null);
        if (box === null) {
            // Loud for the same reason the split is: a region that lost an element frames the rest as if it were whole.
            console.warn(`  [region ${shot.name}] nothing matches ${selector}`);
            continue;
        }
        boxes.push(box);
    }
    if (boxes.length === 0) {
        throw new Error(`no element of ${shot.name}'s region is on the page`);
    }
    const left = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.x)) - REGION_PAD));
    const top = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.y)) - REGION_PAD));
    const right = Math.min(window.width, Math.ceil(Math.max(...boxes.map((box) => box.x + box.width)) + REGION_PAD));
    const bottom = Math.min(window.height, Math.ceil(Math.max(...boxes.map((box) => box.y + box.height)) + REGION_PAD));
    return { x: left, y: top, width: right - left, height: bottom - top };
};

const clipFor = async (page: Page, shot: Shot): Promise<Clip | undefined> => {
    const paired = twinClip(shot);
    if (paired !== undefined) {
        return paired === "full" ? undefined : paired;
    }
    if (shot.region !== undefined) {
        return regionClip(page, shot, shot.region);
    }
    if (shot.clip === undefined) {
        return undefined;
    }
    const window = shot.viewport ?? DESKTOP;
    // The two panes are flush: the workspace runs from the icon rail to exactly where the chat panel starts. An
    // earlier version cut 26px back from that line as "gutter belonging to neither panel", and it belongs to both
    // — every `area` shot lost the right end of its own header (the New agent button, sliced mid-word) and every
    // `chat` shot opened on a 26px strip of the workspace behind it.
    const split = await composerLeft(page, window.width);
    if (shot.clip === "chat") {
        // The column alone, down to its own foot: the window's terminal dock runs under it, and a wing that kept that
        // strip ended on a band of another colour.
        const column = await page
            .locator(CHAT_PANEL)
            .first()
            .boundingBox()
            .catch(() => null);
        return { x: split, y: 0, width: window.width - split, height: column === null ? window.height : Math.round(column.y + column.height) };
    }
    const x = shot.clip === "area" ? 0 : split;
    const frame = await contentFrame(page, { left: x, floorX: shot.clip === "area" ? split : window.width, floorY: shot.stopAt ?? window.height });
    // Only the right edge of an `area` clip may come in off the split, and only to drop dead canvas: a surface whose
    // content genuinely reaches the chat has nothing to trim, and pulling that cut back would delete a whole column.
    const width = shot.clip === "area" ? frame.right : window.width - x;
    const height = shot.fullHeight === true ? window.height : Math.min(frame.bottom, window.height);
    return { x, y: 0, width, height };
};

/* Scroll the tallest eligible pane inside the requested clip. */
const scrollPane = async (page: Page, shot: Shot, by: number): Promise<void> => {
    const width = (shot.viewport ?? DESKTOP).width;
    const split = shot.clip === undefined ? width : await composerLeft(page, width);
    const [from, to] = shot.clip === "chat" ? [split, width] : [0, shot.clip === "area" ? split : width];
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

/** The window a shot is taken in: its size, density and the scheme the browser reports. */
const contextOptions = (shot: Shot): Parameters<Browser["newContext"]>[0] => ({
    viewport: shot.viewport ?? (shot.mobile === true ? MOBILE : DESKTOP),
    deviceScaleFactor: shot.dpr ?? DEFAULT_DPR,
    isMobile: shot.mobile ?? false,
    hasTouch: shot.mobile ?? false,
    colorScheme: LIGHT ? "light" : "dark",
});

// Which recording a shot is of: the showcase, unless it names the desk.
const modeOf = (shot: Shot): NonNullable<Shot["mode"]> => shot.mode ?? "showcase";

// The pointer is put where nothing is. A click leaves it over what it pressed, and a row under the pointer draws its
// hover actions — the Changes list's stage and discard buttons came out on the very row the diff is of.
const restPointer = async (page: Page): Promise<void> => {
    await page.mouse.move(-1, -1);
};

/** A browser context with everything the app reads before it boots already in place: look, audience, mode, rail. */
const openContext = async (browser: Browser, shot: Shot): Promise<BrowserContext> => {
    const context = await browser.newContext(contextOptions(shot));
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
    //
    // The wallpaper is a third, its own preference and worn under either look (skins/useWallpaper.ts). Mist has a dark
    // and a light picture, and the scheme picks between them, so both sets ask for the same name.
    await context.addInitScript(
        ({ scheme, skin, wallpaper }: { scheme: string; skin: string; wallpaper: string }) => {
            window.localStorage.setItem(`ui-color-scheme`, scheme);
            window.localStorage.setItem(`ui-skin`, skin);
            window.localStorage.setItem(`ui-wallpaper`, wallpaper);
        },
        { ...(LIGHT ? { scheme: `light`, skin: `none` } : { scheme: `dark`, skin: `sanctum` }), wallpaper: `mist` },
    );
    // The shot's own layout preferences: where the chat docks and how wide it is, read by the app at boot like the look.
    if (shot.storage !== undefined) {
        await context.addInitScript((pairs: Record<string, string>) => {
            for (const [key, value] of Object.entries(pairs)) {
                window.localStorage.setItem(key, value);
            }
        }, shot.storage);
    }
    const mode = modeOf(shot);
    // The desk is read as a maker: the third key the desk profile seeds, and the one that changes the words on screen.
    if (mode === "desk") {
        await context.addInitScript(() => window.localStorage.setItem(`ui-audience`, `maker`));
    }
    // Before first paint, and in every window the context opens. `raw` shots get it too: the visitor page carries
    // neither selector, so the rule is inert there rather than conditional here.
    await context.addInitScript((css: string) => {
        const style = document.createElement(`style`);
        style.textContent = css;
        const attach = (): void => (document.head ?? document.documentElement).append(style);
        if (document.head === null) {
            document.addEventListener(`DOMContentLoaded`, attach, { once: true });
        } else {
            attach();
        }
    }, HIDE_DEMO_CHROME);
    /* Set fixture mode before app boot so every navigation keeps it. */
    await context.addInitScript((id) => window.sessionStorage.setItem(`intentic.demo.mode`, id), mode);
    // Every shot is of the quiet recording, the desk's included; the showcase is quiet anyway, and the key carries what a
    // shot keeps regardless (_site/demo/src/mode.ts `demoQuiet`).
    await context.addInitScript((keeps) => window.sessionStorage.setItem(`intentic.demo.quiet`, JSON.stringify(keeps)), shot.keep ?? []);
    if (shot.extensions !== undefined) {
        await context.addInitScript((ids) => window.sessionStorage.setItem(`intentic.demo.extensions`, JSON.stringify(ids)), shot.extensions);
    }
    return context;
};

/** Bring the page to the surface the shot is of: the route, then everything the shot asked to have pressed or typed. */
const surface = async (page: Page, shot: Shot): Promise<void> => {
    if (shot.openFirst !== undefined) {
        await page.goto(demoUrl(shot.openFirst), { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2_400);
    }
    await page.goto(shot.raw === true ? `${ORIGIN}${shot.path}` : demoUrl(shot.path), { waitUntil: "domcontentloaded" });
    for (const selector of [shot.waitFor ?? []].flat()) {
        await page.waitForSelector(selector, { timeout: 20_000 }).catch(() => console.warn(`  [no waitFor ${shot.name}] ${selector}`));
    }
    for (const target of shot.click ?? []) {
        await page.click(target, { timeout: 20_000 });
        await page.waitForTimeout(600);
    }
    await restPointer(page);
    if (shot.type !== undefined) {
        await page.fill(shot.type.target, shot.type.text);
        await page.press(shot.type.target, "Enter");
        // The reply streams, so the wait is for it to finish arriving rather than for a layout to settle.
        await page.waitForTimeout(shot.type.settleMs ?? 2_000);
    }
    await page.waitForTimeout(shot.settleMs ?? 800);
    if (typeof shot.scrollTo === "number") {
        await scrollPane(page, shot, shot.scrollTo);
        await page.waitForTimeout(600);
    } else if (shot.scrollTo !== undefined) {
        // The element's card, not its heading text, goes to the top, with a gutter above it so the frame does not
        // open on the card's edge.
        await page
            .locator(shot.scrollTo)
            .first()
            .evaluate((element) => {
                const card = element.closest(".ui-card, .bg-card") ?? element;
                card.scrollIntoView({ block: "start" });
            });
        await scrollPane(page, shot, -TRIM_PAD);
        await page.waitForTimeout(600);
    }
};

const shoot = async (browser: Browser, shot: Shot): Promise<boolean> => {
    const context = await openContext(browser, shot);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.warn(`  [pageerror ${shot.name}] ${error.message.split("\n")[0]}`));
    try {
        await surface(page, shot);
        const clip = await clipFor(page, shot);
        await page.screenshot({ path: resolve(OUT_DIR, `${shot.name}.png`), ...(clip === undefined ? {} : { clip }) });
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
    const catalogue = DESK ? DESK_SHOTS : SHOTS;
    const wanted = only.length === 0 ? catalogue : catalogue.filter((shot) => only.includes(shot.name));
    if (wanted.length === 0) {
        throw new Error(`No shot matches ${only.join(", ")} — known: ${catalogue.map((shot) => shot.name).join(", ")}`);
    }
    // Only the app shots need the demo build; a `raw` one brings its own world, so re-shooting just the
    // Visitor chat shouldn't cost a full SPA build.
    if (DEMO_URL === undefined && wanted.some((shot) => shot.raw !== true) && !existsSync(join(DEMO_DIR, "index.html"))) {
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
    console.log(`${wanted.length - failed}/${wanted.length} ${DESK ? `desk` : LIGHT ? `light` : `dark`} shots written to ${OUT_DIR}`);
};

await run();
