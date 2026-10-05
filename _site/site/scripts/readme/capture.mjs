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

/** Every raw picture the README is built from. `mode` picks the demo's fixture density (_site/demo/src/mode.ts). */
export const SHOTS = [
    // The hero's window: the whole fleet on the board, and the docked chat holding a plan that waits for a yes. The
    // site's own showcase size, since narrower windows squeeze the card titles; a slimmer chat gives the lanes room.
    {
        name: "hero-app",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        mode: "full",
        waitFor: "text=ATTENTION",
        viewport: { width: 1760, height: 1000 },
        storage: { "ui-text-size": "default", "ui-chat-home": "side", "ui-chat-width": "400" },
    },
    { name: "hero-phone", path: "/agents", openFirst: "/agents/cnv_checkout_stripe", mode: "default", waitFor: "text=ATTENTION", phone: true },
    // The whole fleet: every lane, subagents on another provider, a Discord-started run, a teammate.
    {
        name: "board",
        path: "/agents",
        openFirst: "/agents/cnv_checkout_stripe",
        mode: "full",
        waitFor: "text=ATTENTION",
        viewport: { width: 1280, height: 860 },
    },
    // The chat on its own page: the plan the agent wrote, and the bar that asks for a yes.
    {
        name: "plan",
        path: "/chat",
        openFirst: "/agents/cnv_checkout_stripe",
        mode: "default",
        waitFor: "text=Plan waiting for your approval",
        viewport: { width: 1280, height: 900 },
    },
    // A finished run waiting to land: its branch, its files, the diff and the agent's own account of the work.
    {
        name: "review",
        path: "/agents/cnv_soft_deletes",
        openFirst: "/agents",
        mode: "default",
        waitFor: "text=liveUsers",
        viewport: { width: 1240, height: 780 },
        storage: { "ui-chat-home": "side", "ui-chat-width": "380" },
    },
    { name: "phone-board", path: "/agents", openFirst: "/agents/cnv_checkout_stripe", mode: "default", waitFor: "text=ATTENTION", phone: true },
    { name: "phone-review", path: "/agents/cnv_soft_deletes", openFirst: "/agents", mode: "default", waitFor: "text=held on", phone: true },
    { name: "phone-changes", path: "/workspace?panel=changes", mode: "default", waitFor: "text=CheckoutPanel.tsx", phone: true },
    // What the work would have cost at API rates, and the plan limits of every connected account.
    {
        name: "usage",
        path: "/sandbox/usage",
        mode: "default",
        waitFor: "text=accounts have room",
        viewport: { width: 1400, height: 1180 },
    },
    // The catalogue's categories beside one connection, open on what it will add to the sandbox before it is saved.
    {
        name: "capabilities",
        path: "/capabilities",
        openFirst: "/agents/cnv_checkout_stripe",
        mode: "full",
        waitFor: "text=Connected",
        click: ['text="GitHub"'],
        viewport: { width: 1280, height: 860 },
    },
    { name: "automations", path: "/ext/automations", mode: "full", waitFor: "text=CODE CHORES", viewport: { width: 1120, height: 700 } },
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

/** A browser context with the look, the fixture density and the hidden chrome in place before the app boots. */
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
    await context.addInitScript((mode) => {
        sessionStorage.setItem("intentic.demo.mode", mode);
        // The rail carries one icon per extension: a bare rail unless the extensions are the subject.
        if (mode !== "full") {
            sessionStorage.setItem("intentic.demo.extensions", "[]");
        }
    }, shot.mode);
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
