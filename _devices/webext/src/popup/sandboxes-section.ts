import { parseWebextPairingCode } from "@intentic/sandbox-contract/webext-links";
import type { PopupState, SandboxState } from "../background/messages.js";
import { button, byId, h, say, send, show } from "./dom.js";

// The popup's "Sandboxes": every sandbox this browser is paired with, whether its socket is up, its agent's own window,
// and the way to end that one connection without touching the others. Below them, "Connect another sandbox", since
// one extension serves every sandbox the person has (2026-10-28; before, pairing a second replaced the first).

// Pairs a sandbox: asks Chrome for its origin while the click that started this is still on the stack (an await in
// front of the request would spend it), then has the worker redeem the code, or the parked offer when no code is
// given. Answers the sentence to show, or nothing when it worked.
export const pairSandbox = async (url: string, code: string | undefined, refresh: () => Promise<void>): Promise<string | undefined> => {
    const origin = `${new URL(url).origin}/*`;
    if (!(await chrome.permissions.request({ origins: [origin] }))) {
        return `Without access to ${new URL(url).host} this extension cannot reach that sandbox.`;
    }
    const result = await send<{ ok: boolean; message: string }>(code === undefined ? { type: "accept-offer" } : { type: "pair", code });
    if (!result.ok) {
        return result.message;
    }
    await refresh();
    return undefined;
};

// A pasted code's sandbox address, or the sentence why it is not a code.
const pastedSandbox = (code: string): { readonly url: string } | { readonly error: string } => {
    const pairing = parseWebextPairingCode(code);
    return pairing === undefined ? { error: `That does not look like a connection code. Copy it again from your sandbox.` } : { url: pairing.url };
};

// Wires a paste form (the welcome's, or the one under the list) to pair what is pasted into it.
export const wirePasteForm = (form: string, input: string, error: string, refresh: () => Promise<void>, done?: () => void): void => {
    byId<HTMLFormElement>(form).addEventListener("submit", (event) => {
        event.preventDefault();
        const field = byId<HTMLInputElement>(input);
        const note = byId(error);
        const code = field.value.trim();
        const pasted = pastedSandbox(code);
        if ("error" in pasted) {
            say(note, pasted.error);
            return;
        }
        say(note, undefined);
        void pairSandbox(pasted.url, code, refresh).then((message) => {
            say(note, message);
            if (message === undefined) {
                field.value = "";
                done?.();
            }
        });
    });
};

// Who is asking, as the popup says it: "Your agent" while one sandbox is paired, and which sandbox's once there are
// several, since each agent's request is that sandbox's alone.
export const agentOf = (state: PopupState, sandbox: string): string => {
    if (state.sandboxes.length <= 1) {
        return "Your agent";
    }
    const name = state.sandboxes.find((each) => each.url === sandbox)?.name;
    return name === undefined ? "An agent" : `Your agent in ${name}`;
};

// A sandbox's name for a sentence, by its key: the name it was paired with, or its host once it is no longer paired.
export const sandboxLabel = (state: PopupState, sandbox: string): string => {
    const found = state.sandboxes.find((each) => each.url === sandbox);
    if (found !== undefined) {
        return found.name;
    }
    try {
        return new URL(sandbox).host;
    } catch {
        return sandbox;
    }
};

// "intentic", "intentic and marketing", "intentic, marketing and video".
export const listed = (names: readonly string[]): string =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

const LINK_WORDS = {
    open: ["dot on", "Connected"],
    connecting: ["dot wait", "Connecting…"],
    closed: ["dot off", "Offline, reconnects by itself"],
} as const satisfies Record<SandboxState["link"], readonly [dot: string, words: string]>;

// Two clicks, since disconnecting means pairing again from that sandbox: the first arms, the second does it.
const disconnect = (sandbox: SandboxState, refresh: () => Promise<void>): HTMLButtonElement => {
    const node = button("Disconnect", "quiet", () => undefined, "small");
    node.title = `Disconnect ${sandbox.name}. Its agent can no longer work here until you connect it again.`;
    let disarm: ReturnType<typeof setTimeout> | undefined;
    node.addEventListener("click", () => {
        if (!node.classList.contains("armed")) {
            node.classList.add("armed");
            node.textContent = "Really disconnect?";
            disarm = setTimeout(() => {
                node.classList.remove("armed");
                node.textContent = "Disconnect";
            }, 3500);
            return;
        }
        clearTimeout(disarm);
        void send({ type: "unpair", sandbox: sandbox.url }).then(refresh);
    });
    return node;
};

const sandboxRow = (sandbox: SandboxState, paused: boolean, refresh: () => Promise<void>): HTMLElement => {
    const [dot, words] = paused ? (["dot held", "Paused"] as const) : LINK_WORDS[sandbox.link];
    const sub = h("span", { class: "sub", text: words });
    if (sandbox.agentWindowOpen) {
        const showWindow = h("button", { class: "link", text: "Show its window", title: `Bring ${sandbox.name}'s agent window in front of you` });
        showWindow.type = "button";
        showWindow.addEventListener("click", () => void send({ type: "show", sandbox: sandbox.url }));
        sub.append(" · ", showWindow);
    }
    return h(
        "div",
        { class: "row" },
        h("span", { class: dot }),
        h("div", { class: "host" }, h("span", { class: "name", text: sandbox.name, title: sandbox.url }), sub),
        disconnect(sandbox, refresh),
    );
};

export const renderSandboxes = (state: PopupState, refresh: () => Promise<void>): void => {
    show(byId("sandboxes"), state.sandboxes.length > 0);
    byId("sandbox-list").replaceChildren(...state.sandboxes.map((sandbox) => sandboxRow(sandbox, state.paused, refresh)));
};

// Once, when the popup opens: the render above runs on every redraw.
export const wireSandboxes = (refresh: () => Promise<void>): void => {
    const more = byId("connect-more");
    const open = byId<HTMLButtonElement>("connect-open");
    open.addEventListener("click", () => {
        const opening = more.hidden !== false;
        show(more, opening);
        open.setAttribute("aria-expanded", String(opening));
        if (opening) {
            byId<HTMLInputElement>("connect-code").focus();
        }
    });
    wirePasteForm("connect-form", "connect-code", "connect-error", refresh, () => {
        show(more, false);
        open.setAttribute("aria-expanded", "false");
    });
};
