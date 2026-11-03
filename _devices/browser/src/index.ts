import { attach, type CdpSession, listTargets, newTab } from "./cdp.js";
import { ConsoleLog } from "./console.js";
import { framesScript } from "./frames.js";
import { ensureBrowser, ownEndpoint } from "./launch.js";
import { captureScreenshot, evaluateWithin, measureFrames } from "./measure.js";
import { type PageState, type RawSnapshot, refIndex, toPageState } from "./page.js";
import { type PageAnswer, type RunInPage, settleAfterAction, settleAfterOpen } from "./settle.js";
import { SNAPSHOT_SCRIPT } from "./snapshot.js";
import { type Browser, BrowserError } from "./types.js";

export { browserCandidates, ensureBrowser, ownEndpoint, profileDir } from "./launch.js";
export { SNAPSHOT_SCRIPT } from "./snapshot.js";
export { renderPage, refIndex, toPageState, type RawSnapshot, type PageElement, type PageState } from "./page.js";
export { BrowserError, BrowserTimeoutError, type Browser, type PageShot } from "./types.js";
export { CONSOLE_CAP, consoleEntryOf, type ConsoleEntry, type ConsoleLevel, type ConsoleRead } from "./console.js";
export { frameStats, STALL_MS, type FramesOptions, type FrameStats, type GpuInfo, type RawFrames } from "./frames.js";

// Browser as one object a caller holds; keeps at most one CDP session, re-attached on demand so failures surface
// at the request, not later as a stray socket error. Actions go through the page (real click/focus+input events),
// not synthesized mouse coordinates, since only that survives scrolling between snapshot and click.

// The most of a page's text `text()` answers with; beyond it the answer says how much it left out.
const MAX_TEXT = 20_000;

// The keys `press` names that are not a letter.
const NAMED_KEYS = new Map<string, { key: string; code: string; keyCode: number }>([
    ["Return", { key: "Enter", code: "Enter", keyCode: 13 }],
    ["Enter", { key: "Enter", code: "Enter", keyCode: 13 }],
    ["Escape", { key: "Escape", code: "Escape", keyCode: 27 }],
    ["Tab", { key: "Tab", code: "Tab", keyCode: 9 }],
]);

const evaluate = async <T>(session: CdpSession, expression: string): Promise<T> => {
    const result = await session.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) {
        throw new BrowserError(`The page rejected that: ${result.exceptionDetails.text ?? "script error"}`);
    }
    return result.result?.value as T;
};

// What settle.ts runs its waits through.
const inPage =
    (session: CdpSession): RunInPage =>
    async (script) =>
        await evaluate<PageAnswer>(session, script);

// Acting on a ref is always "find it again, then do the thing"; the not-found case is written once, here.
const withElement = (ref: string, body: string): string => {
    const index = refIndex(ref);
    return `(function () {
  var refs = window.__intenticRefs || [];
  var el = refs[${index}];
  if (!el) throw new Error('${ref} is not on this page any more: take a new snapshot; the page has changed since the last one.');
  ${body}
})()`;
};

// Focus the element, put the text in, and fire the events a page's own JavaScript listens for.
const fillScript = (ref: string, text: string, submit: boolean): string => {
    const literal = JSON.stringify(text);
    return withElement(
        ref,
        `el.focus();
  if (el.isContentEditable) { el.textContent = ${literal}; }
  else { el.value = ${literal}; }
  // The events a page's own JavaScript listens for. Setting .value alone updates the DOM and leaves every
  // framework's state untouched, which is how a filled form submits empty.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  ${submit ? "if (el.form) { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); }" : ""}`,
    );
};

// Key events go through CDP; a page won't believe a synthetic KeyboardEvent it didn't get from the browser.
const pressCombo = async (live: CdpSession, combo: string): Promise<void> => {
    const key = combo.split("+").pop() ?? combo;
    const descriptor = NAMED_KEYS.get(key) ?? { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
    const modifiers = (combo.includes("ctrl") ? 2 : 0) | (combo.includes("shift") ? 8 : 0) | (combo.includes("alt") ? 1 : 0);
    for (const type of ["keyDown", "keyUp"] as const) {
        await live.send("Input.dispatchKeyEvent", { type, ...descriptor, windowsVirtualKeyCode: descriptor.keyCode, modifiers });
    }
};

export const browser = (): Browser => {
    let session: CdpSession | undefined;
    let targetId: string | undefined;
    // The console of the tab the session is attached to; a new session (another tab, a reconnect) starts a new one, and
    // Chrome's replay on Runtime.enable refills it with what that page logged before.
    let consoleLog = new ConsoleLog();

    // This package's own browser's debugging port, found again whenever it is needed without a session: the browser may
    // have been restarted on another port since, and whatever else answers on some port is never driven (launch.ts).
    const endpoint = async (): Promise<number> => {
        const port = await ownEndpoint();
        if (port === undefined) {
            throw new BrowserError("No browser of this agent's is open.", "Open a page first: that starts one.");
        }
        return port;
    };

    const connect = async (preferred?: string): Promise<CdpSession> => {
        if (session !== undefined && (preferred === undefined || preferred === targetId)) {
            return session;
        }
        const targets = await listTargets(await endpoint());
        const target = preferred === undefined ? targets[0] : targets.find((candidate) => candidate.id === preferred);
        if (target?.webSocketDebuggerUrl === undefined) {
            throw new BrowserError(preferred === undefined ? "The browser has no open page." : `There is no tab "${preferred}" any more.`);
        }
        session?.close();
        const log = new ConsoleLog();
        session = await attach(target.webSocketDebuggerUrl, (method, params) => log.take(method, params));
        consoleLog = log;
        targetId = target.id;
        // allow(silent-catch): without these the console stays empty, which browser_console says; every other action still works
        await Promise.all([session.send("Runtime.enable"), session.send("Log.enable")]).catch(() => undefined);
        return session;
    };

    const snapshot = async (): Promise<PageState> => {
        const raw = await evaluate<RawSnapshot>(await connect(targetId), SNAPSHOT_SCRIPT);
        return toPageState(raw ?? {});
    };

    return {
        open: async (url) => {
            const { port } = await ensureBrowser(url);
            if (url !== undefined) {
                // Fresh tab rather than navigating what's in front: the agent's page and the user's page must differ.
                const target = await newTab(port, url);
                targetId = target.id;
                session?.close();
                session = undefined;
                // Until the new document has parsed, within the beat this used to sleep (settle.ts).
                await settleAfterOpen(inPage(await connect(targetId)));
            }
            return await snapshot();
        },

        snapshot,

        click: async (ref) => {
            await evaluate(await connect(targetId), withElement(ref, "el.scrollIntoView({block: 'center'}); el.click();"));
        },

        fill: async (ref, text, submit) => {
            await evaluate(await connect(targetId), fillScript(ref, text, submit === true));
        },

        press: async (combo) => await pressCombo(await connect(targetId), combo),

        text: async () => {
            const body = ((await evaluate<string>(await connect(targetId), "document.body ? document.body.innerText : ''")) ?? "").replace(/\n{3,}/g, "\n\n");
            // A page's innerText can be enormous; what a caller wants is the readable part, not a novel, and told so.
            return body.length <= MAX_TEXT ? body : `${body.slice(0, MAX_TEXT)}\n\n(Cut here: the page's text goes on for ${body.length - MAX_TEXT} more characters.)`;
        },

        screenshot: async (selector) => await captureScreenshot(await connect(targetId), selector),

        console: async () => {
            await connect(targetId);
            return consoleLog.read();
        },

        evaluate: async (expression, timeoutMs) => await evaluateWithin(await connect(targetId), expression, timeoutMs),

        frames: async (options) => {
            const live = await connect(targetId);
            // A background tab gets no animation frames at all: the one being measured has to be the one in front.
            // allow(silent-catch): a browser that will not bring it forward is measured as it stands, and the answer says it is hidden
            await live.send("Page.bringToFront").catch(() => undefined);
            return await measureFrames(live, framesScript(options), options);
        },

        tabs: async () =>
            (await listTargets(await endpoint())).map((target) => ({ id: target.id, title: target.title, url: target.url, active: target.id === targetId })),

        selectTab: async (id) => {
            await connect(id);
            // Bring it to the front too: the user watching should see what the agent is working on.
            await session?.send("Page.bringToFront").catch(() => undefined);
            return await snapshot();
        },

        settleAfterAction: async () => await settleAfterAction(inPage(await connect(targetId))),

        disconnect: async () => {
            session?.close();
            session = undefined;
            targetId = undefined;
        },
    };
};
