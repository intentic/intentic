// Photographs the demo build (`_site/demo`) for the repository README: the real `@intentic/web` app on its recorded
// fixture, once per look. The README's pictures are read at about 830px wide, so every desktop shot is taken in a
// window narrower than the site's (and at the app's Large text size) to keep its words legible at that width.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

// Two looks, one per GitHub colour scheme. Dark wears Sanctum, the carved skin the site's own dark shots wear.
export const LOOKS = {
    dark: { scheme: "dark", skin: "sanctum" },
    light: { scheme: "light", skin: "none" },
};

// Demo chrome, tooltips, the parked-chat pill and scrollbars are not part of the product a reader should study.
const HIDE = `
#demo-switcher, .ui-tooltip, .chat-quick-seat { display: none !important; }
* { scrollbar-width: none !important; caret-color: transparent !important; }
*::-webkit-scrollbar { display: none !important; }
`;

// Large text and the chat docked to the rail (so the board gets the window's whole width) unless a shot says otherwise.
const ROOMY = { "ui-text-size": "large", "ui-chat-home": "rail" };

// Every picture is of the demo's `showcase` recording served QUIET, the same afternoon the site's screenshots show
// (_tools/e2e/shots/capture.mts): seven agents, one asking for you, three at work, three done, and none of the busy
// moment's marks (a cooling cache, a teammate's reactions, a key an agent is waiting for, a failing pipeline). The
// README was shot of the loud `full` recording, and every picture of it read as a dashboard of alarms.
const SHOWCASE = "showcase";
// The connector extensions, for the one picture of the catalogue; no other extension's icon joins the rail.
const CONNECTORS = ["intentic.connectors", "intentic.discord", "intentic.slack"];

/** Every raw picture the README is built from. `extensions` pins which are on; every shot's default is none. */
export const SHOTS = [
    // The hero's window: the board, and the docked chat holding a plan that waits for a yes. Default text, since the
    // window is drawn small beside the phone; the board falls to two columns beside the chat, which reads at that size.
    {
        name: "hero-app",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=Plan waiting for your approval",
        viewport: { width: 1280, height: 800 },
        storage: { "ui-text-size": "default", "ui-chat-home": "side", "ui-chat-width": "400" },
    },
    { name: "hero-phone", path: "/agents", openFirst: "/agents/cnv_checkout_stripe", waitFor: "text=ATTENTION", phone: true },
    // The whole fleet across three lanes: Opus, Sonnet, Haiku and Codex at work, a run started from Discord, a teammate.
    { name: "board", path: "/agents", openFirst: "/agents/cnv_checkout_stripe", waitFor: "text=ATTENTION", viewport: { width: 1280, height: 800 } },
    // The chat on its own page: the plan the agent wrote, and the bar that asks for a yes.
    {
        name: "plan",
        path: "/chat",
        openFirst: "/agents/cnv_checkout_stripe",
        waitFor: "text=Plan waiting for your approval",
        viewport: { width: 1280, height: 760 },
    },
    // A finished run waiting to land: its branch, its files, the diff and the agent's own account of the work.
    // Wide enough that the review keeps its file list beside the diff (narrower, it folds the list into a menu), open on
    // the route file: three small edits in a whole file, where the schema is eleven lines.
    {
        name: "review",
        path: "/agents/cnv_soft_deletes",
        openFirst: "/agents/cnv_soft_deletes",
        waitFor: "text=held on",
        click: ['div[class~="group/file"] button:has-text("users.ts")'],
        viewport: { width: 1440, height: 800 },
        storage: { "ui-chat-home": "side", "ui-chat-width": "420" },
    },
    { name: "phone-board", path: "/agents", openFirst: "/agents/cnv_checkout_stripe", waitFor: "text=ATTENTION", phone: true },
    { name: "phone-review", path: "/agents/cnv_soft_deletes", openFirst: "/agents", waitFor: "text=held on", phone: true },
    { name: "phone-changes", path: "/workspace?panel=changes", waitFor: "text=CheckoutPanel.tsx", phone: true },
    // What the work would have cost at API rates, and the plan limits of every connected account.
    { name: "usage", path: "/sandbox/usage", waitFor: "text=accounts have room", viewport: { width: 1400, height: 1180 } },
    // The catalogue, its shelves full of the services a reader knows (the demo reads the shipped manifests).
    // Default text, so the shelves are three tiles wide and every one but Data's is full.
    {
        name: "capabilities",
        path: "/capabilities",
        waitFor: "text=Connected",
        viewport: { width: 1280, height: 860 },
        extensions: CONNECTORS,
        storage: { "ui-text-size": "default" },
    },
    { name: "automations", path: "/ext/automations", waitFor: "text=CODE CHORES", viewport: { width: 1120, height: 700 }, extensions: ["intentic.automations"] },
];

const PHONE = { width: 430, height: 932 };

/** What the app reads from storage before it boots: the look, then the roomy desktop layout a phone has no use for. */
const storageFor = (shot, { scheme, skin }) => {
    const storage = { "ui-color-scheme": scheme, "ui-skin": skin };
    if (shot.phone !== true) {
        Object.assign(storage, ROOMY);
    }
    return Object.assign(storage, shot.storage);
};

/** A browser context with the look, the recording and the hidden chrome in place before the app boots. */
const openContext = async (browser, shot, look) => {
    const phone = shot.phone === true;
    const context = await browser.newContext({
        viewport: phone ? PHONE : shot.viewport,
        deviceScaleFactor: phone ? 3 : 2,
        colorScheme: look.scheme,
        isMobile: phone,
        hasTouch: phone,
    });
    await context.addInitScript(
        (pairs) => {
            for (const [key, value] of Object.entries(pairs)) {
                localStorage.setItem(key, value);
            }
        },
        storageFor(shot, look),
    );
    await context.addInitScript(
        ({ mode, extensions }) => {
            sessionStorage.setItem("intentic.demo.mode", mode);
            // Quiet, with nothing kept: the key the screenshots harness writes, which is also what keeps a dev server's
            // extras (the transcript specimen) off the board.
            sessionStorage.setItem("intentic.demo.quiet", "[]");
            // The rail carries one icon per extension: a bare rail unless the extensions are the subject.
            sessionStorage.setItem("intentic.demo.extensions", JSON.stringify(extensions));
        },
        { mode: SHOWCASE, extensions: shot.extensions ?? [] },
    );
    await context.addInitScript((css) => {
        const style = document.createElement("style");
        style.textContent = css;
        const attach = () => (document.head ?? document.documentElement).append(style);
        if (document.head === null) {
            document.addEventListener("DOMContentLoaded", attach, { once: true });
        } else {
            attach();
        }
    }, HIDE);
    return context;
};

/** Brings a page to the surface the shot is of: the route, then whatever the shot asks to have pressed. */
const surface = async (page, demoUrl, shot) => {
    if (shot.openFirst !== undefined) {
        await page.goto(`${demoUrl}${shot.openFirst}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2400);
    }
    await page.goto(`${demoUrl}${shot.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(shot.waitFor, { timeout: 20_000 }).catch(() => console.warn(`  ${shot.name}: never saw ${shot.waitFor}`));
    for (const target of shot.click ?? []) {
        await page.click(target, { timeout: 15_000 });
        await page.waitForTimeout(700);
    }
    await page.waitForTimeout(2600);
};

/** Captures `SHOTS` (or the named subset) from `demoUrl` into `outDir` as `<name>-<look>.png`. */
export const capture = async ({ demoUrl, outDir, only = [] }) => {
    mkdirSync(outDir, { recursive: true });
    const shots = SHOTS.filter((shot) => only.length === 0 || only.includes(shot.name));
    const browser = await chromium.launch({ headless: true, channel: "chromium" });
    try {
        for (const [name, look] of Object.entries(LOOKS)) {
            for (const shot of shots) {
                const context = await openContext(browser, shot, look);
                const page = await context.newPage();
                await surface(page, demoUrl, shot);
                await page.screenshot({ path: join(outDir, `${shot.name}-${name}.png`) });
                console.log(`  captured ${shot.name} (${name})`);
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }
};
