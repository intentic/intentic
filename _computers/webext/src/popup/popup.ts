import type { WebExtGrant } from "@intentic/sandbox-contract";
import type { PopupCommand, PopupState } from "../background/messages.js";

/* THE 340 PIXELS THAT MAKE THIS INSTALLABLE.
 *
 * A person opens this to answer one of three questions, and it is laid out in that order: is it connected,
 * what can it touch, and how do I stop it. Everything else — the activity list, the pairing box — sits below.
 *
 * THE POPUP IS ALSO WHERE PERMISSION ACTUALLY HAPPENS. `chrome.permissions.request` resolves true only when a
 * user gesture is on the stack, and a service worker has no gestures, so every widening of what this extension
 * may reach is a click in HERE: allowing a site the agent asked for, and allowing the sandbox's own origin
 * while pairing. The worker is told afterwards. That is not a workaround — it is the property that makes the
 * grant list trustworthy, since nothing the sandbox says can add to it. */

const send = async <T>(command: PopupCommand): Promise<T> => (await chrome.runtime.sendMessage(command)) as T;

const site = (origin: string): string => origin.replace(/^https?:\/\//, "").replace(/\/\*?$/, "");

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, options: { text?: string; className?: string } = {}): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (options.text !== undefined) {
        node.textContent = options.text;
    }
    if (options.className !== undefined) {
        node.className = options.className;
    }
    return node;
};

const button = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
    const node = el("button", { text: label });
    if (primary) {
        node.className = "primary";
    }
    node.addEventListener("click", onClick);
    return node;
};

const row = (...children: (Node | string)[]): HTMLDivElement => {
    const node = el("div", { className: "row" });
    node.append(...children);
    return node;
};

const section = (id: string): HTMLElement => {
    const node = document.getElementById(id) as HTMLElement;
    node.replaceChildren();
    return node;
};

const ago = (at: number): string => {
    const seconds = Math.max(1, Math.round((Date.now() - at) / 1000));
    return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
};

/* Ask the browser for a site, then tell the worker which mode the person picked. The order matters: Chrome's
 * dialog is the decision, and the mode is only recorded once it said yes. */
const allow = async (origin: string, mode: WebExtGrant["mode"]): Promise<void> => {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) {
        await send({ type: "allow", origin, mode });
    }
    await render();
};

const pair = async (code: string, url: string): Promise<HTMLElement | undefined> => {
    // The sandbox's own origin, so this extension may `fetch` it at all. Asked here, with the click that got
    // us here still on the stack.
    const origin = `${new URL(url).origin}/*`;
    if (!(await chrome.permissions.request({ origins: [origin] }))) {
        return el("div", { className: "muted", text: `Without access to ${site(origin)} this extension cannot reach that sandbox.` });
    }
    const result = await send<{ ok: boolean; message: string }>({ type: "pair", code });
    if (!result.ok) {
        return el("div", { className: "muted", text: result.message });
    }
    await render();
    return undefined;
};

const renderStatus = (state: PopupState): void => {
    const node = section("status");
    node.append(el("h1", { text: "Intentic" }));
    if (state.sandbox === undefined) {
        node.append(el("div", { className: "muted", text: "Not connected to a sandbox yet." }));
        return;
    }
    const dot = el("span", { className: `dot ${state.link === "open" ? "on" : "off"}` });
    const label = el("span", {
        className: "site",
        text:
            state.link === "open"
                ? site(state.sandbox.url)
                : state.link === "connecting"
                  ? `${site(state.sandbox.url)} — connecting…`
                  : `${site(state.sandbox.url)} — offline`,
    });
    const left = el("div");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.style.gap = "8px";
    left.style.minWidth = "0";
    left.append(dot, label);
    node.append(
        row(
            left,
            button(state.paused ? "Resume" : "Pause", state.paused, () => {
                void send({ type: "pause", value: !state.paused }).then(render);
            }),
        ),
    );
    if (state.paused) {
        node.append(el("div", { className: "muted", text: "Paused: every tool the agent calls is refused until you resume." }));
    }
    node.append(
        row(
            el("span", { className: "muted", text: "Disconnect this browser from the sandbox" }),
            button("Unpair", false, () => {
                void send({ type: "unpair" }).then(render);
            }),
        ),
    );
};

const renderPending = (state: PopupState): void => {
    const node = section("pending");
    // A pairing a sandbox page offered. One click finishes it, which is the whole point of the handoff.
    if (state.offered !== undefined && state.sandbox === undefined) {
        node.append(el("h1", { text: "A sandbox wants to connect" }));
        node.append(el("div", { className: "site", text: site(state.offered.url) }));
        const offered = state.offered;
        node.append(
            row(
                el("span", { className: "muted", text: "It will be able to work on the sites you allow below." }),
                button("Connect", true, () => {
                    void pair(
                        // Re-encoded rather than stored raw: the worker parked the two fields, and this is the
                        // one place that turns them back into what `pair` takes.
                        btoa(JSON.stringify({ url: offered.url, token: offered.token }))
                            .replaceAll("+", "-")
                            .replaceAll("/", "_")
                            .replaceAll("=", ""),
                        offered.url,
                    ).then((error) => {
                        if (error !== undefined) {
                            node.append(error);
                        }
                    });
                }),
            ),
        );
        return;
    }
    if (state.pending === undefined) {
        return;
    }
    // A site the agent asked for. The reason it gave is shown verbatim, because that is what the person is
    // deciding about — and because an agent that has to justify itself in one sentence asks for less.
    node.append(el("h1", { text: "Your agent is asking" }));
    node.append(el("div", { className: "site", text: site(state.pending.origin) }));
    node.append(el("div", { className: "muted", text: state.pending.reason }));
    const pending = state.pending;
    const buttons = el("div");
    buttons.style.display = "flex";
    buttons.style.gap = "6px";
    buttons.append(
        button("Read only", false, () => void allow(pending.origin, "read")),
        button("Read and act", true, () => void allow(pending.origin, "act")),
    );
    node.append(row(el("span", { className: "muted", text: `asked ${ago(pending.at)} ago` }), buttons));
};

const renderSites = (state: PopupState): void => {
    const node = section("sites");
    node.append(el("h1", { text: `Sites it may work on` }));
    if (state.grants.length === 0) {
        node.append(el("div", { className: "muted", text: "None yet. Your agent will ask when it needs one, or add the site you are on below." }));
    }
    for (const grant of state.grants) {
        const toggle = button(grant.mode === "act" ? "read and act" : "read only", false, () => {
            void send({ type: "mode", origin: grant.origin, mode: grant.mode === "act" ? "read" : "act" }).then(render);
        });
        const drop = button("×", false, () => {
            void send({ type: "revoke", origin: grant.origin }).then(render);
        });
        const controls = el("div");
        controls.style.display = "flex";
        controls.style.gap = "6px";
        controls.append(toggle, drop);
        node.append(row(el("span", { className: "site", text: site(grant.origin) }), controls));
    }
    // Adding the tab you are on: the other half of `ask_access`, for when the person gets there first.
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
        const url = tabs[0]?.url;
        if (url === undefined || !/^https?:/.test(url)) {
            return;
        }
        const origin = `${new URL(url).origin}/*`;
        if (state.grants.some((grant) => grant.origin === origin)) {
            return;
        }
        node.append(
            row(
                el("span", { className: "site", text: site(origin) }),
                button("Allow this site", true, () => void allow(origin, "act")),
            ),
        );
    });
};

const renderActivity = (state: PopupState): void => {
    const node = section("activity");
    if (state.sandbox === undefined) {
        node.append(el("h1", { text: "Connect" }));
        node.append(el("div", { className: "muted", text: "Paste the code from your sandbox's browser card." }));
        const input = el("input");
        input.placeholder = "ixb1_…";
        const message = el("div", { className: "muted" });
        node.append(input);
        node.append(
            row(
                message,
                button("Connect", true, () => {
                    const code = input.value.trim();
                    let url: string;
                    try {
                        url = JSON.parse(
                            atob(
                                code
                                    .replace(/^ixb1_/, "")
                                    .replaceAll("-", "+")
                                    .replaceAll("_", "/"),
                            ),
                        )["url"] as string;
                    } catch {
                        message.textContent = `That does not look like a connection code.`;
                        return;
                    }
                    void pair(code, url).then((error) => {
                        if (error !== undefined) {
                            message.textContent = error.textContent;
                        }
                    });
                }),
            ),
        );
        return;
    }
    node.append(el("h1", { text: "Recent activity" }));
    if (state.log.length === 0) {
        node.append(el("div", { className: "muted", text: "Nothing yet." }));
        return;
    }
    const log = el("div", { className: "log" });
    for (const entry of state.log.slice(0, 40)) {
        log.append(el("div", { text: `${ago(entry.at)}  ${entry.ok ? "" : "✗ "}${entry.tool} ${entry.detail}` }));
    }
    node.append(log);
};

const render = async (): Promise<void> => {
    const state = await send<PopupState>({ type: "state" });
    renderStatus(state);
    renderPending(state);
    renderSites(state);
    renderActivity(state);
};

void render();
