import { errorMessage } from "@intentic/base/errors";
import type { PopupState, ScriptRequestView, ScriptRow } from "../background/messages.js";
import { siteOf } from "../background/policy.js";
import { button, byId, h, icon, say, send, show } from "./dom.js";
import { aroundChanges, lineDiff } from "./line-diff.js";

// The popup's say over user scripts: the one-time turning on (the optional permission, then the browser's own switch),
// the scripts an agent is waiting on the person to install, as a card with everything there is to decide on, and every
// installed script with its switch. A script installs only from a click here: nothing an agent sends reaches the list
// without one.

const RUN_AT = new Map([
    ["document_start", "before the page's own scripts"],
    ["document_end", "once the page's markup is in"],
    ["document_idle", "once the page has loaded"],
]);

const hosts = (sources: readonly string[]): string => sources.map((source) => source.replace(/^https:\/\//, "")).join(", ");
const lineCount = (source: string): number => source.split("\n").length;
const size = (source: string): string => (source.length < 1000 ? `${source.length} bytes` : `${(source.length / 1000).toFixed(1)} kB`);

const fact = (label: string, value: string, warn = false): HTMLElement =>
    h("div", { class: warn ? "fact warn" : "fact" }, h("span", { class: "fact-label", text: label }), h("span", { text: value }));

const codeBlock = (source: string): HTMLElement => h("pre", { class: "code", text: source });

// An update's changes, or the whole new code when the two are too long to compare here.
const diffBlock = (previous: string, next: string): HTMLElement => {
    const lines = lineDiff(previous, next);
    if (lines === undefined) {
        return codeBlock(next);
    }
    const pre = h("pre", { class: "code diff" });
    for (const line of aroundChanges(lines)) {
        pre.append(
            line === "fold"
                ? h("span", { class: "fold", text: "…\n" })
                : h("span", { class: line.kind, text: `${line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}${line.text}\n` }),
        );
    }
    return pre;
};

const disclosure = (summary: string, body: HTMLElement, open: boolean): HTMLElement => {
    const details = h("details", { class: "code-box" }, h("summary", { text: summary }), body);
    details.open = open;
    return details;
};

export const scriptRequestCard = (request: ScriptRequestView, who: string, refresh: () => Promise<void>): HTMLElement => {
    const error = h("div", { class: "error" });
    show(error, false);
    const update = request.kind === "update";
    const autoUpdate = h("input");
    autoUpdate.type = "checkbox";
    const answer = (accept: boolean): void => {
        void send<{ ok: boolean }>({ type: "script-answer", id: request.id, accept, autoUpdate: autoUpdate.checked })
            .then(async (result) => {
                say(error, result.ok ? undefined : "That request is gone: it was answered already, or its sandbox disconnected.");
                await refresh();
            })
            .catch((cause: unknown) => say(error, errorMessage(cause)));
    };
    const facts = [
        fact("Runs on", request.sites.map(siteOf).join(", ")),
        fact("Also reaches", request.connects.length === 0 ? "nothing beyond those sites" : hosts(request.connects)),
        ...(request.newConnects.length === 0 ? [] : [fact("New here", hosts(request.newConnects), true)]),
        fact("Starts", RUN_AT.get(request.runAt) ?? request.runAt),
        fact("Code", `${lineCount(request.source)} lines · ${size(request.source)} · ${request.hash.slice(0, 12)}${request.from === undefined ? "" : ` · ${request.from}`}`),
    ];
    return h(
        "div",
        { class: "card ask script-ask" },
        h("div", { class: "eyebrow" }, h("span", { text: `${who} wants to ${update ? "update" : "install"} a script` })),
        h("div", { class: "title" }, h("span", { text: `${request.name}${request.version === "" ? "" : ` ${request.version}`}` })),
        h("p", { class: request.description === "" ? "reason muted" : "reason", text: request.description === "" ? "It gave no description." : request.description }),
        h("div", { class: "facts" }, ...facts),
        update && request.previous !== undefined
            ? disclosure("What changes", diffBlock(request.previous, request.source), true)
            : disclosure("Read the code", codeBlock(request.source), false),
        h("label", { class: "switch auto-update" }, autoUpdate, h("span", { text: "Let it change this script's code without asking, while its sites and hosts stay the same" })),
        h(
            "div",
            { class: "actions" },
            button("Decline", "quiet", () => answer(false)),
            h("span", { class: "spacer" }),
            button(update ? "Update" : "Install", "primary", () => answer(true)),
        ),
        error,
        h("p", { class: "hint", text: "It runs on every visit to these sites, also while your sandbox is offline, until you turn it off here." }),
    );
};

// Two clicks, as with disconnecting a sandbox: the first arms, the second removes.
const removeButton = (row: ScriptRow, refresh: () => Promise<void>): HTMLButtonElement => {
    const node = h("button", { class: "icon-btn", title: `Remove ${row.name}` }, icon("remove"));
    node.type = "button";
    node.setAttribute("aria-label", `Remove ${row.name}`);
    let disarm: ReturnType<typeof setTimeout> | undefined;
    node.addEventListener("click", () => {
        if (!node.classList.contains("armed")) {
            node.classList.add("armed");
            node.title = "Click again to remove it";
            disarm = setTimeout(() => {
                node.classList.remove("armed");
                node.title = `Remove ${row.name}`;
            }, 3500);
            return;
        }
        clearTimeout(disarm);
        void send({ type: "script-remove", id: row.id }).then(refresh);
    });
    return node;
};

const onSwitch = (row: ScriptRow, refresh: () => Promise<void>): HTMLElement => {
    const input = h("input", { title: row.on ? `Turn ${row.name} off` : `Turn ${row.name} on` });
    input.type = "checkbox";
    input.checked = row.on;
    input.setAttribute("aria-label", `${row.name} runs`);
    input.addEventListener("change", () => void send({ type: "script-toggle", id: row.id, on: input.checked }).then(refresh));
    return h("label", { class: "switch" }, input);
};

// Which rows are open, by script id, across redraws.
const opened = new Set<string>();

const details = (row: ScriptRow, refresh: () => Promise<void>): HTMLElement => {
    const auto = h("input");
    auto.type = "checkbox";
    auto.checked = row.autoUpdate;
    auto.addEventListener("change", () => void send({ type: "script-auto-update", id: row.id, on: auto.checked }).then(refresh));
    const code = h("div");
    const view = h("button", { class: "link", text: "Read the code" });
    view.type = "button";
    view.addEventListener("click", () => {
        void send<{ source: string }>({ type: "script-source", id: row.id }).then(({ source }) => {
            code.replaceChildren(codeBlock(source));
            show(view, false);
        });
    });
    return h(
        "div",
        { class: "script-details" },
        ...(row.description === "" ? [] : [h("p", { class: "muted", text: row.description })]),
        fact("Also reaches", row.connects.length === 0 ? "nothing beyond its sites" : hosts(row.connects)),
        fact("From", `${row.by}${row.from === undefined ? "" : `, ${row.from}`}`),
        ...(row.lastError === undefined ? [] : [fact("Last error", row.lastError, true)]),
        h("label", { class: "switch auto-update" }, auto, h("span", { text: "Let its agent change the code without asking, while its sites and hosts stay the same" })),
        view,
        code,
    );
};

const scriptRow = (row: ScriptRow, refresh: () => Promise<void>): HTMLElement => {
    const sub = row.stopped ?? (row.errors > 0 ? `${row.errors} error${row.errors === 1 ? "" : "s"} · ${row.sites.map(siteOf).join(", ")}` : row.sites.map(siteOf).join(", "));
    const name = h("button", { class: "name script-name", text: row.name, title: `${row.name} — ${row.on ? "on" : "off"}` });
    name.type = "button";
    name.setAttribute("aria-expanded", String(opened.has(row.id)));
    name.addEventListener("click", () => {
        if (opened.has(row.id)) {
            opened.delete(row.id);
        } else {
            opened.add(row.id);
        }
        void refresh();
    });
    const head = h(
        "div",
        { class: "row" },
        h("div", { class: "host" }, name, h("span", { class: row.stopped !== undefined || row.errors > 0 ? "sub warn" : "sub", text: sub })),
        onSwitch(row, refresh),
        removeButton(row, refresh),
    );
    return h("div", { class: "script" }, head, ...(opened.has(row.id) ? [details(row, refresh)] : []));
};

// The one-time turning on, said for where this browser is: the extension's own permission first, then the browser's.
const turnOn = (state: PopupState, refresh: () => Promise<void>): HTMLElement | undefined => {
    const error = h("div", { class: "error" });
    show(error, false);
    switch (state.scripts.availability) {
        case "ready":
            return undefined;
        case "old":
            return h("p", { class: "empty", text: "Scripts need Chrome 135 or later. Update this browser to use them." });
        case "permission":
            return h(
                "div",
                { class: "turn-on" },
                h("p", { text: "Let your agent write scripts that change the sites you allow, for good. Each one is shown to you before it runs." }),
                button("Turn on scripts", "primary", () => {
                    // Asked before any await, while the click still counts as the person's (popup.ts says why).
                    void chrome.permissions
                        .request({ permissions: ["userScripts"] })
                        .then(async (granted) => {
                            if (!granted) {
                                say(error, "The browser did not allow it, so nothing changed.");
                                return;
                            }
                            await send({ type: "scripts-enabled" });
                            await refresh();
                        })
                        .catch((cause: unknown) => say(error, errorMessage(cause)));
                }),
                error,
            );
        case "toggle":
            return h(
                "div",
                { class: "turn-on" },
                h("p", {}, "One more switch, in the browser itself: on this extension's details page, turn on ", h("b", { text: state.scripts.toggle.replaceAll('"', "") }), "."),
                button("Open the details page", "plain", () => void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })),
            );
    }
};

export const renderScripts = (state: PopupState, refresh: () => Promise<void>): void => {
    const wanted = state.sandboxes.some((sandbox) => sandbox.scopes.scripts === "on");
    const { rows } = state.scripts;
    show(byId("scripts"), wanted || rows.length > 0);
    const intro = turnOn(state, refresh);
    const list: HTMLElement[] = rows.map((row) => scriptRow(row, refresh));
    if (rows.length === 0 && intro === undefined) {
        list.push(h("p", { class: "empty", text: "None yet. When your agent writes one, it asks you here first." }));
    }
    byId("script-list").replaceChildren(...(intro === undefined ? [] : [intro]), ...list);
};
