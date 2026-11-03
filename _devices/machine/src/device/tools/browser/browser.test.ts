import type { Browser, ConsoleEntry, FramesOptions, PageState, RawFrames } from "@intentic/browser";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { ScopeError } from "../../policy.js";
import {
    clickElement,
    evaluateInPage,
    fillElement,
    listTabs,
    measurePageFrames,
    openPage,
    readConsole,
    readPage,
    screenshotPage,
    snapshotPage,
} from "./browser.js";

// Browser control at the layer that decides what is allowed and what comes back. Same scope split as the other
// tools: reading is `screen`, clicking/typing is `control`, opening is `shell`. Every action answers with the
// page after it, so a sequence of calls is one step each.

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "on", programs: "off",
    ...overrides,
});

const page = (overrides: Partial<PageState> = {}): PageState => ({
    url: "https://example.com/",
    title: "Example",
    elements: [{ ref: "e0", role: "button", name: "Send" }],
    ...overrides,
});

const entry = (overrides: Partial<ConsoleEntry> = {}): ConsoleEntry => ({
    at: Date.UTC(2026, 10, 3, 12, 0, 1, 250),
    level: "log",
    source: "console",
    text: "frame",
    where: undefined,
    ...overrides,
});

const ANGLE = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)";

const rawFrames = (overrides: Partial<RawFrames> = {}): RawFrames => ({
    intervals: [16, 16, 17, 16, 50],
    ready: true,
    waitedMs: 0,
    stalled: false,
    visibility: "visible",
    focused: true,
    devicePixelRatio: 1.5,
    viewport: [1280, 720],
    gpu: {
        webgpu: { found: true, vendor: "nvidia", architecture: "lovelace", device: "", description: "", fallback: false },
        webgl: { found: true, vendor: "Google Inc. (NVIDIA)", renderer: ANGLE },
    },
    ...overrides,
});

const fakeBrowser = (seen: { console?: readonly ConsoleEntry[]; frames?: RawFrames } = {}) => {
    const calls: string[] = [];
    const framesAsked: FramesOptions[] = [];
    let current = page();
    const web: Browser = {
        open: async (url) => {
            calls.push(`open ${url ?? ""}`);
            current = page({ url: url ?? current.url });
            return current;
        },
        snapshot: async () => current,
        click: async (ref) => void calls.push(`click ${ref}`),
        fill: async (ref, text, submit) => void calls.push(`fill ${ref} ${text}${submit === true ? " submit" : ""}`),
        press: async (combo) => void calls.push(`press ${combo}`),
        text: async () => "The readable text of the page.",
        screenshot: async (selector) => {
            calls.push(`screenshot ${selector ?? "page"}`);
            return { png: Buffer.from("png"), width: 1429, height: 804, what: selector === undefined ? "the visible page" : "canvas#game", cssWidth: 1920, cssHeight: 1080, devicePixelRatio: 1.5 };
        },
        console: async () => ({ entries: seen.console ?? [], dropped: 0 }),
        evaluate: async (expression, timeoutMs) => {
            calls.push(`evaluate ${expression} ${timeoutMs}`);
            return "true";
        },
        frames: async (options) => {
            framesAsked.push(options);
            return seen.frames ?? rawFrames();
        },
        tabs: async () => [
            { id: "T1", title: "Example", url: "https://example.com/", active: true },
            { id: "T2", title: "Docs", url: "https://docs.example.com/", active: false },
        ],
        selectTab: async (id) => {
            calls.push(`select ${id}`);
            return current;
        },
        settleAfterAction: async () => void calls.push("settle"),
        disconnect: async () => void calls.push("disconnect"),
    };
    return { web, calls, framesAsked };
};

test("opening a page may start a browser, so it rides the shell grant", async () => {
    const { web, calls } = fakeBrowser();
    await expect(openPage(web, "example.com", scopes({ shell: "off" }))).rejects.toThrow(/Run commands/);
    expect(calls).toEqual([]);
    await openPage(web, "example.com", scopes());
    // A bare host is what people type; refusing over a missing scheme would be pedantry rather than safety.
    expect(calls).toEqual(["open https://example.com"]);
});

test("a URL that already has a scheme is left alone", async () => {
    const { web, calls } = fakeBrowser();
    await openPage(web, "http://localhost:3000/admin", scopes());
    expect(calls).toEqual(["open http://localhost:3000/admin"]);
});

test("reading a page is looking, so it needs the screen grant", async () => {
    const { web } = fakeBrowser();
    await expect(snapshotPage(web, scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    await expect(readPage(web, scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    expect(await readPage(web, scopes())).toContain("readable text");
});

test("acting on a page needs the control grant, not the screen one", async () => {
    const { web, calls } = fakeBrowser();
    await expect(clickElement(web, "e0", scopes({ control: "off" }))).rejects.toThrow(/mouse and keyboard/);
    expect(calls).toEqual([]);
    await clickElement(web, "e0", scopes({ screen: "off" }));
    expect(calls).toEqual(["click e0", "settle"]);
});

// The page after a click is a different page. Answering with it stops the agent either forgetting to look or
// spending a round trip finding out what its own action did.
test("every action answers with the page as it stands afterwards", async () => {
    const { web } = fakeBrowser();
    const clicked = await clickElement(web, "e0", scopes());
    expect(clicked).toContain("Clicked e0");
    expect(clicked).toContain("Page: Example");
    expect(clicked).toContain("[e0] button");
});

// A password typed into a login form is a password; it is counted, never echoed back into the transcript.
test("filling reports a length, never the text", async () => {
    const { web } = fakeBrowser();
    const said = await fillElement(web, "e0", "hunter2", false, scopes());
    expect(said).toContain("7 characters");
    expect(said).not.toContain("hunter2");
});

test("submitting is stated, because it is the step that sends the form", async () => {
    const { web, calls } = fakeBrowser();
    const said = await fillElement(web, "e0", "invoice", true, scopes());
    expect(calls).toEqual(["fill e0 invoice submit", "settle"]);
    expect(said).toContain("and submitted");
});

test("acting without a reference says where references come from", async () => {
    const { web } = fakeBrowser();
    await expect(clickElement(web, "", scopes())).rejects.toThrow(/take a snapshot/);
    await expect(fillElement(web, "", "text", false, scopes())).rejects.toThrow(/\[e…\]/);
});

test("the tab list marks the one the tools are acting on", async () => {
    const { web } = fakeBrowser();
    const listed = await listTabs(web, scopes());
    expect(listed).toContain("[T1] Example");
    expect(listed).toContain("[T2] Docs");
    expect(
        listed
            .split("\n")
            .find((line) => line.includes("[T1]"))
            ?.startsWith("*"),
    ).toBe(true);
});

// A picture of the agent's own tab is looking, like a snapshot; it is not a capture of the owner's desktop.
test("a page screenshot needs the screen grant and says what it shows and how it was shrunk", async () => {
    const { web, calls } = fakeBrowser();
    await expect(screenshotPage(web, "canvas", scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    expect(calls).toEqual([]);
    const shot = await screenshotPage(web, "canvas", scopes({ control: "off", shell: "off" }));
    expect(calls).toEqual(["screenshot canvas"]);
    expect(shot.said).toContain("canvas#game: 1429×804 pixels of 1920×1080 CSS pixels at devicePixelRatio 1.5, shrunk to fit");
    expect(shot.png.toString()).toBe("png");
    await screenshotPage(web, "", scopes());
    expect(calls.at(-1)).toBe("screenshot page");
});

test("the console reads oldest first in UTC, counts errors, and can be narrowed to what went wrong", async () => {
    const { web } = fakeBrowser({
        console: [
            entry(),
            entry({ level: "error", source: "exception", text: "Uncaught RuntimeError: unreachable", where: "http://localhost:8080/game.js:1" }),
            entry({ level: "warning", source: "rendering", text: "WebGPU: device lost" }),
        ],
    });
    await expect(readConsole(web, 100, false, scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    const all = await readConsole(web, 100, false, scopes());
    expect(all.split("\n")).toEqual([
        "3 console messages since these tools attached to this tab (1 error, 1 warning); all below, oldest first, times in UTC.",
        "12:00:01.250 log     frame",
        "12:00:01.250 error   [exception] Uncaught RuntimeError: unreachable  (http://localhost:8080/game.js:1)",
        "12:00:01.250 warning [rendering] WebGPU: device lost",
    ]);
    const bad = await readConsole(web, 1, true, scopes());
    expect(bad.split("\n")).toEqual([
        "3 console messages since these tools attached to this tab (1 error, 1 warning); the newest 1 errors and warnings below, oldest first, times in UTC.",
        "12:00:01.250 warning [rendering] WebGPU: device lost",
    ]);
});

test("an empty console, or one with nothing wrong, says so in words", async () => {
    expect(await readConsole(fakeBrowser().web, 100, false, scopes())).toBe("The page's console is empty since these tools attached to this tab.");
    expect(await readConsole(fakeBrowser({ console: [entry()] }).web, 100, true, scopes())).toBe(
        "No errors or warnings among the 1 console messages since these tools attached to this tab.",
    );
});

// A script in the page can click, submit and send as the signed-in owner would: it is control, not looking.
test("running a script in the page needs the control grant", async () => {
    const { web, calls } = fakeBrowser();
    await expect(evaluateInPage(web, "document.title", 5000, scopes({ control: "off" }))).rejects.toThrow(/mouse and keyboard/);
    await expect(evaluateInPage(web, " ", 5000, scopes())).rejects.toThrow(/"expression" is required/);
    expect(calls).toEqual([]);
    expect(await evaluateInPage(web, "window.game.ready", 5000, scopes({ screen: "off" }))).toBe("true");
    expect(calls).toEqual(["evaluate window.game.ready 5000"]);
});

test("frame timing answers the percentiles and names the GPU that drew them", async () => {
    const { web, framesAsked } = fakeBrowser();
    const said = await measurePageFrames(web, { count: 5, until: undefined, waitMs: 30_000 }, scopes({ control: "off" }));
    expect(framesAsked).toEqual([{ count: 5, until: undefined, waitMs: 30_000, measureMs: 60_000 }]);
    expect(said.split("\n")).toEqual([
        "5 frames: median 16 ms (63 fps) · p95 50 ms (20 fps) · worst 50 ms (20 fps) · mean 43.5 fps · 1 hitch (frames over twice the median)",
        "Drawn by (the page's own adapter request may differ if it asks for another powerPreference):",
        "  WebGPU adapter: nvidia · lovelace",
        `  WebGL renderer: ${ANGLE} (Google Inc. (NVIDIA))`,
        "Tab visible and focused; viewport 1280×720 CSS pixels at devicePixelRatio 1.5.",
    ]);
});

// The condition is the agent's own expression, run in the page: the same grant as browser_evaluate.
test("waiting on a condition before measuring also needs the control grant", async () => {
    const { web, framesAsked } = fakeBrowser();
    await expect(measurePageFrames(web, { count: 5, until: "game.ready", waitMs: 1000 }, scopes({ control: "off" }))).rejects.toThrow(/mouse and keyboard/);
    await expect(measurePageFrames(web, { count: 5, until: undefined, waitMs: 1000 }, scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    expect(framesAsked).toEqual([]);
});

test("software rendering, a hidden tab and a condition that never came true are each said plainly", async () => {
    const { web } = fakeBrowser({
        frames: rawFrames({
            intervals: [],
            ready: false,
            waitedMs: 30_000,
            untilError: "ReferenceError: game is not defined",
            stalled: true,
            visibility: "hidden",
            focused: false,
            gpu: {
                webgpu: { found: false, why: "requestAdapter() answered null: no usable GPU adapter" },
                webgl: { found: true, vendor: "Google Inc. (Google)", renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" },
            },
        }),
    });
    const said = await measurePageFrames(web, { count: 5, until: "game.ready", waitMs: 30_000 }, scopes());
    expect(said).toContain("No frames were timed.");
    expect(said).toContain("`until` was still not true after 30.0 s, so nothing was measured. It last threw: ReferenceError: game is not defined");
    expect(said).toContain("No animation frame came for 5 s: the tab is hidden");
    expect(said).toContain("WebGPU adapter: requestAdapter() answered null: no usable GPU adapter");
    expect(said).toContain("← software rendering, not the GPU");
    expect(said).toContain("Tab hidden; viewport");
});
