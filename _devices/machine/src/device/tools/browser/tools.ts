import type { Browser } from "@intentic/browser";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import {
    clickElement,
    DEFAULT_CONSOLE_LIMIT,
    DEFAULT_FRAMES,
    DEFAULT_FRAMES_WAIT_MS,
    evaluateInPage,
    fillElement,
    listTabs,
    measurePageFrames,
    openPage,
    pressKey,
    readConsole,
    readPage,
    screenshotPage,
    selectTab,
    snapshotPage,
} from "./browser.js";

// The browser tools as the device serves them: their schemas and the descriptions that carry the judgement calls; what
// each is allowed to do is browser.ts's. `web` hands over the process's one browser handle, refused before sign-in.

const NO_ARGS = z.object({});
const required = z.string().min(1);

// Opening a page, reading it and acting on it by element reference.
const pageTools = (web: () => Browser): McpTool<DeviceScopes>[] => [
    tool({
        name: "browser_open",
        description:
            "Open a page in a browser on this device and answer with what is on it: the page's title, its URL, and every element you can click or type into, each with a reference like [e12]. THIS IS THE RIGHT WAY TO USE A WEBSITE, act on elements by reference, never by clicking pixels, because references survive scrolling, resizing and re-rendering. The browser is a separate instance with its own profile, so the user's own tabs and session are untouched; the first time it opens they may need to sign in. Requires the 'Run commands' permission.",
        effect: "write",
        input: z.object({ url: required.describe("The page to open. A bare host like example.com is fine.") }),
        run: async ({ url }, scopes) => textResult(await openPage(web(), url, scopes)),
    }),
    tool({
        name: "browser_snapshot",
        description:
            "What the current page shows right now, with fresh [e…] references. Take one after anything that might have changed the page: references from an older snapshot are refused rather than clicking the wrong thing. Requires the 'See the screen' permission.",
        effect: "read",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await snapshotPage(web(), scopes)),
    }),
    tool({
        name: "browser_read",
        description:
            "The current page as readable text: what a person would get by selecting all of it. Use this to ANSWER QUESTIONS about a page; use browser_snapshot when you intend to act on it. Requires the 'See the screen' permission.",
        effect: "read",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await readPage(web(), scopes)),
    }),
    tool({
        name: "browser_click",
        description:
            "Click an element by its [e…] reference from the last snapshot. Answers with the page as it stands afterwards, so you see the result without asking. Requires the 'Use the mouse and keyboard' permission.",
        // A click can buy, send or delete on any site the owner signed into in that browser.
        effect: "destructive",
        input: z.object({ ref: required }),
        run: async ({ ref }, scopes) => textResult(await clickElement(web(), ref, scopes)),
    }),
    tool({
        name: "browser_fill",
        description:
            "Type into a field by its [e…] reference: replaces what is there, and fires the events a page's own JavaScript listens for (setting a value without them is how a filled form submits empty). Set submit to press Enter afterwards. Requires the 'Use the mouse and keyboard' permission.",
        // Replaces what the field held, and `submit` sends the form.
        effect: "destructive",
        input: z.object({
            ref: required,
            text: z.string(),
            submit: z.boolean().default(false).describe("Submit the form after typing. Default false."),
        }),
        run: async ({ ref, text, submit }, scopes) => textResult(await fillElement(web(), ref, text, submit, scopes)),
    }),
    tool({
        name: "browser_key",
        description:
            'Press a key on the page as a whole: "Return", "Escape", "Tab". For typing into a field use browser_fill. Requires the \'Use the mouse and keyboard\' permission.',
        // Enter submits and Delete deletes, whatever has focus.
        effect: "destructive",
        input: z.object({ key: required }),
        run: async ({ key }, scopes) => textResult(await pressKey(web(), key, scopes)),
    }),
    tool({
        name: "browser_tabs",
        description:
            "Every tab open in that browser, and which one these tools are acting on. Pass an id to `select` to switch. Reading the list needs 'See the screen'; switching needs 'Use the mouse and keyboard'.",
        // Listing reads, but `select` switches the tab every other browser tool acts on.
        effect: "write",
        input: z.object({ select: required.optional().describe("The id of the tab to switch to. Omit to just list them.") }),
        run: async ({ select }, scopes) => textResult(select === undefined ? await listTabs(web(), scopes) : await selectTab(web(), select, scopes)),
    }),
];

// What the page looks like and how fast it draws on this device's own GPU (2026-11-03): see browser.ts.
const renderTools = (web: () => Browser): McpTool<DeviceScopes>[] => [
    tool({
        name: "browser_screenshot",
        description:
            "A picture of the current page in that browser, or of one element of it (`selector`, e.g. \"canvas\"), as this device's GPU drew it: captured from the browser's own compositor, so a WebGL or WebGPU canvas shows what it really rendered (a black square on this GPU is a black square here). Only the agent's own tab, never the rest of the desktop; the tab is brought to the front first. Shrunk to what you read whole; a selector looks closer. Requires the 'See the screen' permission.",
        effect: "read",
        input: z.object({ selector: required.optional().describe('A CSS selector for one element to capture, e.g. "canvas" or "#game". Omit for the visible page.') }),
        run: async ({ selector }, scopes) => {
            const { said, png } = await screenshotPage(web(), selector, scopes);
            return { content: [{ type: "text", text: said }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }], isError: false };
        },
    }),
    tool({
        name: "browser_console",
        description:
            "What the current page logged (console.*), threw (uncaught errors and rejections, with stacks) and had the browser log about it (failed requests, WebGL and WebGPU warnings), since these tools attached to its tab, oldest first. Where a page that renders wrong usually says why. Requires the 'See the screen' permission.",
        effect: "read",
        input: z.object({
            limit: z.number().int().min(1).max(1000).default(DEFAULT_CONSOLE_LIMIT).describe(`The newest this many messages. Default ${DEFAULT_CONSOLE_LIMIT}.`),
            errorsOnly: z.boolean().default(false).describe("Only errors and warnings. Default false."),
        }),
        run: async ({ limit, errorsOnly }, scopes) => textResult(await readConsole(web(), limit, errorsOnly, scopes)),
    }),
    tool({
        name: "browser_evaluate",
        description:
            "Run a JavaScript expression in the current page and get its value back as JSON; a promise is awaited. Stopped at `timeoutMs`. A DOM node or a function does not serialise: return the properties you need instead. For reading what a page's own state says (a game's scene, its loaded flag, a WebGPU device's limits); it can do anything the page can, so it needs the 'Use the mouse and keyboard' permission.",
        // Any script in a page the owner may be signed into: it can click, submit and send as they would.
        effect: "destructive",
        input: z.object({
            expression: required.describe('A JavaScript expression, e.g. "document.title" or "(async () => (await navigator.gpu.requestAdapter()).limits.maxTextureDimension2D)()".'),
            timeoutMs: z.number().int().min(1000).max(120_000).default(10_000).describe("How long it may run. Default 10000, at most 120000."),
        }),
        run: async ({ expression, timeoutMs }, scopes) => textResult(await evaluateInPage(web(), expression, timeoutMs, scopes)),
    }),
    tool({
        name: "browser_frames",
        description:
            "Measure how the current page really renders on this device's GPU: time `count` animation frames and answer the median, p95 and worst frame times with their fps, the hitches, and which GPU drew them (the WebGPU adapter and the WebGL renderer, so a software fallback shows). `until` waits for a condition first (\"window.game?.ready\"), polled once a frame for up to `waitMs`. The tab is brought to the front: a hidden tab draws nothing. Requires 'See the screen', and 'Use the mouse and keyboard' too when you pass `until`, which runs your expression in the page.",
        // Brings the tab to the front, and `until` is the agent's own script in the page.
        effect: "write",
        input: z.object({
            count: z.number().int().min(10).max(1000).default(DEFAULT_FRAMES).describe(`Frames to time. Default ${DEFAULT_FRAMES}; the timing stops after a minute regardless.`),
            until: required.optional().describe("A JavaScript expression that is true once the page is ready to measure. Omit to measure at once."),
            waitMs: z.number().int().min(0).max(120_000).default(DEFAULT_FRAMES_WAIT_MS).describe(`How long \`until\` may take to come true. Default ${DEFAULT_FRAMES_WAIT_MS}, at most 120000.`),
        }),
        run: async ({ count, until, waitMs }, scopes) => textResult(await measurePageFrames(web(), { count, until, waitMs }, scopes)),
    }),
];

export const browserTools = (web: () => Browser): McpTool<DeviceScopes>[] => [...pageTools(web), ...renderTools(web)];
