import { sleep } from "@intentic/base/async";
import { attach, type CdpSession, listTargets, newTab } from "./cdp.js";
import { DEFAULT_PORT, ensureBrowser } from "./launch.js";
import { type PageState, type RawSnapshot, refIndex, toPageState } from "./page.js";
import { SNAPSHOT_SCRIPT } from "./snapshot.js";
import { type Browser, BrowserError } from "./types.js";

export { DEFAULT_PORT, browserCandidates, ensureBrowser, profileDir } from "./launch.js";
export { SNAPSHOT_SCRIPT } from "./snapshot.js";
export { renderPage, refIndex, toPageState, type RawSnapshot, type PageElement, type PageState } from "./page.js";
export { BrowserError, type Browser } from "./types.js";

// Browser as one object a caller holds; keeps at most one CDP session, re-attached on demand so failures surface
// at the request, not later as a stray socket error. Actions go through the page (real click/focus+input events),
// not synthesized mouse coordinates, since only that survives scrolling between snapshot and click.

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

export const browser = (port: number = DEFAULT_PORT): Browser => {
    let session: CdpSession | undefined;
    let targetId: string | undefined;

    const connect = async (preferred?: string): Promise<CdpSession> => {
        if (session !== undefined && (preferred === undefined || preferred === targetId)) {
            return session;
        }
        const targets = await listTargets(port);
        const target = preferred === undefined ? targets[0] : targets.find((candidate) => candidate.id === preferred);
        if (target?.webSocketDebuggerUrl === undefined) {
            throw new BrowserError(preferred === undefined ? "The browser has no open page." : `There is no tab "${preferred}" any more.`);
        }
        session?.close();
        session = await attach(target.webSocketDebuggerUrl);
        targetId = target.id;
        return session;
    };

    const snapshot = async (): Promise<PageState> => {
        const raw = await evaluate<RawSnapshot>(await connect(targetId), SNAPSHOT_SCRIPT);
        return toPageState(raw ?? {});
    };

    return {
        open: async (url) => {
            await ensureBrowser(port, url);
            if (url !== undefined) {
                // Fresh tab rather than navigating what's in front: the agent's page and the user's page must differ.
                const target = await newTab(port, url);
                targetId = target.id;
                session?.close();
                session = undefined;
                // Give the navigation a moment to produce a document worth snapshotting.
                await sleep(600);
            }
            return await snapshot();
        },

        snapshot,

        click: async (ref) => {
            await evaluate(await connect(targetId), withElement(ref, "el.scrollIntoView({block: 'center'}); el.click();"));
        },

        fill: async (ref, text, submit) => {
            const literal = JSON.stringify(text);
            await evaluate(
                await connect(targetId),
                withElement(
                    ref,
                    `el.focus();
  if (el.isContentEditable) { el.textContent = ${literal}; }
  else { el.value = ${literal}; }
  // The events a page's own JavaScript listens for. Setting .value alone updates the DOM and leaves every
  // framework's state untouched, which is how a filled form submits empty.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  ${submit === true ? "if (el.form) { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); }" : ""}`,
                ),
            );
        },

        // Key events go through CDP; a page won't believe a synthetic KeyboardEvent it didn't get from the browser.
        press: async (combo) => {
            const live = await connect(targetId);
            const key = combo.split("+").pop() ?? combo;
            const named: Record<string, { key: string; code: string; keyCode: number }> = {
                Return: { key: "Enter", code: "Enter", keyCode: 13 },
                Enter: { key: "Enter", code: "Enter", keyCode: 13 },
                Escape: { key: "Escape", code: "Escape", keyCode: 27 },
                Tab: { key: "Tab", code: "Tab", keyCode: 9 },
            };
            const descriptor = named[key] ?? { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
            const modifiers = (combo.includes("ctrl") ? 2 : 0) | (combo.includes("shift") ? 8 : 0) | (combo.includes("alt") ? 1 : 0);
            for (const type of ["keyDown", "keyUp"] as const) {
                await live.send("Input.dispatchKeyEvent", { type, ...descriptor, windowsVirtualKeyCode: descriptor.keyCode, modifiers });
            }
        },

        text: async () => {
            const body = await evaluate<string>(await connect(targetId), "document.body ? document.body.innerText : ''");
            // A page's innerText can be enormous; what a caller wants is the readable part, not a novel.
            return (body ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 20_000);
        },

        screenshot: async () => {
            const shot = await (await connect(targetId)).send<{ data: string }>("Page.captureScreenshot", { format: "png" });
            return Buffer.from(shot.data, "base64");
        },

        tabs: async () =>
            (await listTargets(port)).map((target) => ({ id: target.id, title: target.title, url: target.url, active: target.id === targetId })),

        selectTab: async (id) => {
            await connect(id);
            // Bring it to the front too: the user watching should see what the agent is working on.
            await session?.send("Page.bringToFront").catch(() => undefined);
            return await snapshot();
        },

        disconnect: async () => {
            session?.close();
            session = undefined;
            targetId = undefined;
        },
    };
};
