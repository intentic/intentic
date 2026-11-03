import { type Browser, BrowserError, type ConsoleEntry, frameStats, type GpuInfo, type RawFrames, renderPage, STALL_MS } from "@intentic/browser";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { assertScope } from "../../policy.js";

// The browser, driven by what is on the page rather than where it is on screen: snapshot it, act on an element
// by reference, so the same instruction works at any window size or re-render. Scopes follow the apps.ts rule
// (look -> `screen`, change -> `control`, open -> `shell`). The browser is a separate instance with its own
// profile, never the user's own, so a misfired click never touches their session.

export const openPage = async (web: Browser, url: string, scopes: DeviceScopes): Promise<string> => {
    // Opening may start a browser process, which is what the shell switch governs.
    assertScope(scopes, "shell");
    if (url === "") {
        throw new BrowserError(`"url" is required: the page to open.`);
    }
    // A bare host is what people type; a browser needs the scheme, and refusing over a missing "https://" would be
    // pedantry rather than safety.
    const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    return renderPage(await web.open(target));
};

export const snapshotPage = async (web: Browser, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "screen");
    return renderPage(await web.snapshot());
};

export const readPage = async (web: Browser, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "screen");
    const text = await web.text();
    return text.trim() === "" ? "That page has no readable text, it may still be loading, or it may be a canvas or a PDF." : text;
};

// Every action answers with a fresh snapshot: the page after a click is a different page, and an agent that has
// to ask what happened will forget to, or spend a round trip finding out.
export const clickElement = async (web: Browser, ref: string, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "control");
    if (ref === "") {
        throw new BrowserError(`"ref" is required: take a snapshot and use one of the [e…] references from it.`);
    }
    await web.click(ref);
    await web.settleAfterAction();
    return `Clicked ${ref}.\n\n${renderPage(await web.snapshot())}`;
};

export const fillElement = async (web: Browser, ref: string, text: string, submit: boolean, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "control");
    if (ref === "") {
        throw new BrowserError(`"ref" is required: take a snapshot and use one of the [e…] references from it.`);
    }
    await web.fill(ref, text, submit);
    await web.settleAfterAction();
    // Counted, never echoed: a filled field is as likely to hold a password as anything typed on the keyboard.
    return `Typed ${text.length} characters into ${ref}${submit ? " and submitted" : ""}.\n\n${renderPage(await web.snapshot())}`;
};

export const pressKey = async (web: Browser, combo: string, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "control");
    await web.press(combo === "" ? "Return" : combo);
    await web.settleAfterAction();
    return `Pressed ${combo === "" ? "Return" : combo}.\n\n${renderPage(await web.snapshot())}`;
};

export const listTabs = async (web: Browser, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "screen");
    const tabs = await web.tabs();
    if (tabs.length === 0) {
        return "The browser has no open tabs.";
    }
    return [
        `${tabs.length} tab${tabs.length === 1 ? "" : "s"} (* = the one these tools are acting on). Pass an id to switch.`,
        ...tabs.map((tab) => `${tab.active ? "* " : "  "}[${tab.id}] ${tab.title}, ${tab.url}`),
    ].join("\n");
};

export const selectTab = async (web: Browser, id: string, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "control");
    if (id === "") {
        throw new BrowserError(`"id" is required: list the tabs and pass one of the ids in brackets.`);
    }
    return renderPage(await web.selectTab(id));
};

// SEEING AND MEASURING A PAGE ON THIS DEVICE'S OWN GPU (2026-11-03). A sandbox renders WebGL and WebGPU in software, if
// at all: the shinobi sandbox's agents waited 176 s for a game to load and 6-11 s a frame, and a bug that showed only on
// the owner's NVIDIA card through Chrome's D3D12 backend could not be seen from there. These four answer from the page
// in this device's browser, drawn by its real GPU under Chrome's own GPU watchdog: a picture, its console, a script's
// value, and its frame timing with the GPU that drew it named.

// A picture of the page is looking at it: `screen`, like browser_snapshot. It is not a screen capture: it shows only the
// agent's own tab, captured from the browser's compositor, whatever else is on the owner's desktop.
export const screenshotPage = async (web: Browser, selector: string | undefined, scopes: DeviceScopes): Promise<{ readonly said: string; readonly png: Buffer }> => {
    assertScope(scopes, "screen");
    const shot = await web.screenshot(selector === "" ? undefined : selector);
    const shrunk = shot.width < Math.round(shot.cssWidth * shot.devicePixelRatio);
    return {
        said:
            `${shot.what === "the visible page" ? "The visible page" : shot.what}: ${shot.width}×${shot.height} pixels of ${shot.cssWidth}×${shot.cssHeight} CSS pixels ` +
            `at devicePixelRatio ${shot.devicePixelRatio}${shrunk ? ", shrunk to fit what you read whole; pass a selector to look closer at one part" : ""}. ` +
            "Captured from the GPU's own surface, so a WebGL or WebGPU canvas shows what it really drew.",
        png: shot.png,
    };
};

export const DEFAULT_CONSOLE_LIMIT = 100;

const consoleLine = (entry: ConsoleEntry): string =>
    `${new Date(entry.at).toISOString().slice(11, 23)} ${entry.level.padEnd(7)} ${entry.source === "console" ? "" : `[${entry.source}] `}${entry.text}${entry.where === undefined ? "" : `  (${entry.where})`}`;

// The page's console is read off the page: `screen`.
export const readConsole = async (web: Browser, limit: number, errorsOnly: boolean, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "screen");
    const { entries, dropped } = await web.console();
    const errors = entries.filter((entry) => entry.level === "error").length;
    const warnings = entries.filter((entry) => entry.level === "warning").length;
    const chosen = errorsOnly ? entries.filter((entry) => entry.level === "error" || entry.level === "warning") : entries;
    if (chosen.length === 0) {
        return entries.length === 0
            ? "The page's console is empty since these tools attached to this tab."
            : `No errors or warnings among the ${entries.length} console messages since these tools attached to this tab.`;
    }
    const shown = chosen.slice(-limit);
    return [
        `${entries.length} console message${entries.length === 1 ? "" : "s"} since these tools attached to this tab (${errors} error${errors === 1 ? "" : "s"}, ` +
            `${warnings} warning${warnings === 1 ? "" : "s"}); ${shown.length < chosen.length ? `the newest ${shown.length}` : "all"}${errorsOnly ? " errors and warnings" : ""} below, ` +
            `oldest first, times in UTC.${dropped > 0 ? ` ${dropped} older ones were let go.` : ""}`,
        ...shown.map(consoleLine),
    ].join("\n");
};

// A script in the page can do anything the page can (click, submit, read what the signed-in site shows): `control`.
export const evaluateInPage = async (web: Browser, expression: string, timeoutMs: number, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "control");
    if (expression.trim() === "") {
        throw new BrowserError(`"expression" is required: the JavaScript to run in the page, e.g. "document.title".`);
    }
    return await web.evaluate(expression, timeoutMs);
};

export const DEFAULT_FRAMES = 120;
export const DEFAULT_FRAMES_WAIT_MS = 30_000;
// How long the timing itself may run, so a page at a few frames a second answers within a minute.
const FRAMES_MEASURE_MS = 60_000;

// What a renderer string says when no GPU drew the page.
const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|warp/i;

const fps = (ms: number): string => (ms <= 0 ? "∞" : String(Math.round(1000 / ms)));

const gpuLines = ({ webgpu, webgl }: GpuInfo): string[] => {
    const adapter = webgpu.found
        ? `${[webgpu.vendor, webgpu.architecture, webgpu.device, webgpu.description].filter((part) => part !== "").join(" · ") || "an adapter that names nothing"}${webgpu.fallback ? " (a FALLBACK adapter: software, not the GPU)" : ""}`
        : webgpu.why;
    const renderer = webgl.found ? `${webgl.renderer} (${webgl.vendor})${SOFTWARE.test(webgl.renderer) ? "  ← software rendering, not the GPU" : ""}` : webgl.why;
    return [`  WebGPU adapter: ${adapter}`, `  WebGL renderer: ${renderer}`];
};

const statsLine = (raw: RawFrames): string => {
    const stats = frameStats(raw.intervals);
    if (stats === undefined) {
        return "No frames were timed.";
    }
    return (
        `${stats.frames} frames: median ${stats.p50Ms} ms (${fps(stats.p50Ms)} fps) · p95 ${stats.p95Ms} ms (${fps(stats.p95Ms)} fps) · ` +
        `worst ${stats.maxMs} ms (${fps(stats.maxMs)} fps) · mean ${stats.meanFps} fps · ${stats.hitches} hitch${stats.hitches === 1 ? "" : "es"} (frames over twice the median)`
    );
};

const framesWarnings = (raw: RawFrames, waited: boolean): string[] => [
    ...(raw.ready ? [] : [`\`until\` was still not true after ${(raw.waitedMs / 1000).toFixed(1)} s, so nothing was measured.${raw.untilError === undefined ? "" : ` It last threw: ${raw.untilError}`}`]),
    ...(raw.stalled
        ? [`No animation frame came for ${STALL_MS / 1000} s: ${raw.visibility === "hidden" ? "the tab is hidden (minimised, or another tab is in front), and a hidden tab draws nothing" : "the page's main thread is stuck, or the GPU process stopped answering; read browser_console"}.`]
        : []),
    ...(raw.ready && waited ? [`Waited ${(raw.waitedMs / 1000).toFixed(1)} s for \`until\` first.`] : []),
];

// Timing frames is looking at the page (`screen`); a `until` condition is the agent's own script run in it, so it also
// needs what browser_evaluate needs (`control`).
export const measurePageFrames = async (
    web: Browser,
    options: { readonly count: number; readonly until: string | undefined; readonly waitMs: number },
    scopes: DeviceScopes,
): Promise<string> => {
    assertScope(scopes, "screen");
    const until = options.until?.trim() === "" ? undefined : options.until;
    if (until !== undefined) {
        assertScope(scopes, "control");
    }
    const raw = await web.frames({ count: options.count, until, waitMs: options.waitMs, measureMs: FRAMES_MEASURE_MS });
    return [
        statsLine(raw),
        ...framesWarnings(raw, until !== undefined),
        `Drawn by (the page's own adapter request may differ if it asks for another powerPreference):`,
        ...gpuLines(raw.gpu),
        `Tab ${raw.visibility}${raw.focused ? " and focused" : ""}; viewport ${raw.viewport[0]}×${raw.viewport[1]} CSS pixels at devicePixelRatio ${raw.devicePixelRatio}.`,
    ].join("\n");
};
