import type { WebExtGrant, WebExtScopes } from "@intentic/sandbox-contract/webext";
import { describeCall } from "../background/activity.js";
import type { PopupCommand, PopupState } from "../background/messages.js";
import { originPattern, sandboxOwnOrigin, siteOf } from "../background/policy.js";
import type { ActivityEntry, PendingAccess } from "../background/store.js";

// Answers, in order: is the agent waiting on me, is it connected, what can it touch, what has it done, how do I stop
// it. Every permission widening happens here, not in the worker: chrome.permissions.request needs a user gesture,
// which only the popup has, so nothing the sandbox says can add to the grant list on its own. That is also why each
// click handler below calls `chrome.permissions.request` before its first await: an await in front of it spends the
// gesture, and Chrome then refuses without asking.

const send = async <T>(command: PopupCommand): Promise<T> => (await chrome.runtime.sendMessage(command)) as T;

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: { class?: string; text?: string; title?: string } = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (props.class !== undefined) {
        node.className = props.class;
    }
    if (props.text !== undefined) {
        node.textContent = props.text;
    }
    if (props.title !== undefined) {
        node.title = props.title;
    }
    node.append(...children);
    return node;
};

// Stroke icons on a 16-unit grid; `fill` for the one solid shape.
const ICONS = {
    pause: { d: "M5.5 3.5v9M10.5 3.5v9" },
    play: { d: "M5 3.4 12.4 8 5 12.6z", fill: true },
    remove: { d: "M4.5 4.5l7 7M11.5 4.5l-7 7" },
    paused: { d: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 1 0 8 1.8zM6.4 5.6v4.8M9.6 5.6v4.8" },
    offline: { d: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 1 0 8 1.8zM3.6 3.6l8.8 8.8" },
    info: { d: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 1 0 8 1.8zM8 7.3v4M8 4.8v.1" },
} as const;

const icon = (name: keyof typeof ICONS): SVGSVGElement => {
    const spec: { d: string; fill?: boolean } = ICONS[name];
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", spec.d);
    path.setAttribute("fill", spec.fill === true ? "currentColor" : "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.7");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
};

const button = (
    label: string,
    weight: "primary" | "plain" | "quiet",
    onClick: (event: MouseEvent) => void,
    glyph?: keyof typeof ICONS,
): HTMLButtonElement => {
    const node = h("button", { class: weight === "plain" ? "btn" : `btn ${weight}` });
    node.type = "button";
    if (glyph !== undefined) {
        node.append(icon(glyph));
    }
    node.append(label);
    node.addEventListener("click", onClick);
    return node;
};

const modeLabel = (mode: WebExtGrant["mode"]): string => (mode === "act" ? "read and act" : "read only");

// "24s ago" for a sentence, "24s" for the activity column.
const ago = (at: number, short = false): string => {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 5) {
        return short ? "now" : "just now";
    }
    const [value, unit] =
        seconds < 60
            ? [seconds, "s"]
            : seconds < 3600
              ? [Math.round(seconds / 60), short ? "m" : " min"]
              : seconds < 172_800
                ? [Math.round(seconds / 3600), short ? "h" : " h"]
                : [Math.round(seconds / 86_400), short ? "d" : " days"];
    return short ? `${value}${unit}` : `${value}${unit} ago`;
};

// A time that keeps itself current: the tick below rewrites every one of these without redrawing the popup.
const when = (at: number, short: boolean, className?: string): HTMLTimeElement => {
    // zone-checked: the extension has no kit; this formats per call on the reader's own clock and browser language.
    const node = h("time", { text: ago(at, short), title: new Date(at).toLocaleString(), ...(className === undefined ? {} : { class: className }) });
    node.dataset["at"] = String(at);
    node.dataset["short"] = short ? "1" : "";
    return node;
};

// The site's icon from the browser's own favicon cache (the `favicon` permission: nothing is fetched from the site),
// over a letter in a colour of its own until it loads.
const favicon = (origin: string): HTMLElement => {
    const host = siteOf(origin).replace(/^www\./, "");
    const box = h("span", { class: "fav", text: (host[0] ?? "?").toUpperCase() });
    let hue = 7;
    for (const char of host) {
        hue = (hue * 31 + char.charCodeAt(0)) % 360;
    }
    box.style.background = `oklch(58% 0.1 ${hue})`;
    const image = new Image();
    image.alt = "";
    image.addEventListener("load", () => {
        box.style.background = "transparent";
        box.replaceChildren(image);
    });
    image.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(origin.replace(/\/\*$/, "/"))}&size=32`);
    return box;
};

const show = (node: HTMLElement, visible: boolean): void => {
    node.hidden = !visible;
};

// A message under a form or card, cleared by the next attempt.
const say = (node: HTMLElement, message: string | undefined): void => {
    node.textContent = message ?? "";
    show(node, message !== undefined);
};

// Asks Chrome first, then records the mode; the mode is only saved once Chrome's own dialog says yes.
const allow = async (origin: string, mode: WebExtGrant["mode"], error?: HTMLElement): Promise<void> => {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) {
        await send({ type: "allow", origin, mode });
    } else if (error !== undefined) {
        say(error, `The browser did not allow ${siteOf(origin)}, so nothing changed.`);
    }
    await refresh();
};

const pair = async (code: string, url: string): Promise<string | undefined> => {
    // Requests the sandbox's own origin while the triggering click is still on the stack.
    const origin = `${new URL(url).origin}/*`;
    if (!(await chrome.permissions.request({ origins: [origin] }))) {
        return `Without access to ${siteOf(origin)} this extension cannot reach that sandbox.`;
    }
    const result = await send<{ ok: boolean; message: string }>({ type: "pair", code });
    if (!result.ok) {
        return result.message;
    }
    await refresh();
    return undefined;
};

// What each choice means, from the switches on this browser's card, so "Read & act" never promises more than
// policy.ts will let through.
const modeHint = (scopes: WebExtScopes): string => {
    if (scopes.read !== "on") {
        return `Reading pages is switched off on this browser's card in your sandbox, so neither choice does anything until it is on.`;
    }
    if (scopes.act !== "on") {
        return `Clicking and typing is switched off on this browser's card in your sandbox, so either choice lets it read only.`;
    }
    const asks =
        scopes.confirm === "always"
            ? `, asking you on the page before every action`
            : scopes.confirm === "sensitive"
              ? `; it still checks with you before passwords, payments or deleting`
              : ``;
    return `Read & act also lets it click and type${asks}.`;
};

const renderHeader = (state: PopupState): void => {
    const pill = byId("pill");
    const [className, label] =
        state.sandbox === undefined
            ? ["pill", "Not connected"]
            : state.paused
              ? ["pill held", "Paused"]
              : state.link === "open"
                ? ["pill on", "Connected"]
                : state.link === "connecting"
                  ? ["pill wait", "Connecting"]
                  : ["pill off", "Offline"];
    pill.className = className;
    byId("pill-text").textContent = label;
    const where = byId("where");
    where.textContent = state.sandbox === undefined ? "Your agent, in your browser" : siteOf(state.sandbox.url);
    where.title = state.sandbox?.url ?? "";
    const pause = byId<HTMLButtonElement>("pause");
    show(pause, state.sandbox !== undefined);
    pause.className = state.paused ? "btn primary" : "btn";
    pause.replaceChildren(icon(state.paused ? "play" : "pause"), state.paused ? "Resume" : "Pause");
    pause.title = state.paused ? "Let the agent work in this browser again" : "Stop the agent from doing anything in this browser";
};

const askCard = (pending: PendingAccess, scopes: WebExtScopes): HTMLElement => {
    const error = h("div", { class: "error" });
    show(error, false);
    return h(
        "div",
        { class: "card ask" },
        h("div", { class: "eyebrow" }, h("span", { class: "beacon" }), "Your agent is asking", when(pending.at, false, "when")),
        h("div", { class: "title" }, favicon(pending.origin), h("span", { text: siteOf(pending.origin), title: pending.origin })),
        h("p", { class: "reason", text: pending.reason === "" ? "It gave no reason." : `“${pending.reason}”` }),
        h(
            "div",
            { class: "actions" },
            button("Decline", "quiet", () => void send({ type: "decline" }).then(refresh)),
            h("span", { class: "spacer" }),
            button("Read only", "plain", () => void allow(pending.origin, "read", error)),
            button("Read & act", "primary", () => void allow(pending.origin, "act", error)),
        ),
        error,
        h("p", { class: "hint", text: modeHint(scopes) }),
    );
};

const offerCard = (offered: NonNullable<PopupState["offered"]>): HTMLElement => {
    const error = h("div", { class: "error" });
    show(error, false);
    return h(
        "div",
        { class: "card ask" },
        h("div", { class: "eyebrow" }, h("span", { class: "beacon" }), "A sandbox wants to connect"),
        h("div", { class: "title" }, favicon(`${new URL(offered.url).origin}/*`), h("span", { text: siteOf(offered.url), title: offered.url })),
        h("p", {
            class: "hint",
            text: "Its agent will work in this browser only on the sites you allow here, and you can pause or disconnect it at any time.",
        }),
        h(
            "div",
            { class: "actions" },
            button("Not now", "quiet", () => void send({ type: "dismiss-offer" }).then(refresh)),
            h("span", { class: "spacer" }),
            button("Connect", "primary", () => {
                // Re-encodes the two parked fields into the format `pair` expects.
                const code = btoa(JSON.stringify({ url: offered.url, token: offered.token }))
                    .replaceAll("+", "-")
                    .replaceAll("/", "_")
                    .replaceAll("=", "");
                void pair(code, offered.url).then((message) => say(error, message));
            }),
        ),
        error,
    );
};

const notice = (kind: "paused" | "offline" | "info", glyph: keyof typeof ICONS, title: string, body: string): HTMLElement =>
    h(
        "div",
        { class: `notice ${kind}` },
        icon(glyph),
        h("div", { class: "grow" }, h("strong", { text: title }), h("span", { class: "muted", text: body })),
    );

const renderAlerts = (state: PopupState): void => {
    const node = byId("alerts");
    const items: HTMLElement[] = [];
    if (state.sandbox === undefined && state.offered !== undefined) {
        items.push(offerCard(state.offered));
    }
    if (state.sandbox !== undefined && state.pending !== undefined) {
        items.push(askCard(state.pending, state.scopes));
    }
    if (state.sandbox !== undefined && state.paused) {
        items.push(notice("paused", "paused", "Paused", "Every tool call the agent makes is refused until you resume."));
    } else if (state.sandbox !== undefined && state.link === "closed") {
        items.push(notice("offline", "offline", "Can't reach your sandbox", "It reconnects by itself once the sandbox is running again."));
    }
    node.replaceChildren(...items);
    show(node, items.length > 0);
};

const renderWelcome = (state: PopupState): void => {
    show(byId("welcome"), state.sandbox === undefined && state.offered === undefined);
};

const segment = (grant: WebExtGrant): HTMLElement => {
    const group = h("span", { class: "seg" });
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", `What it may do on ${siteOf(grant.origin)}`);
    for (const [mode, label, title] of [
        ["read", "Read", "It can look at pages here"],
        ["act", "Read & act", "It can also click and type here"],
    ] as const) {
        const option = h("button", { class: mode, text: label, title });
        option.type = "button";
        option.setAttribute("role", "radio");
        option.setAttribute("aria-checked", String(grant.mode === mode));
        option.addEventListener("click", () => {
            if (grant.mode !== mode) {
                void send({ type: "mode", origin: grant.origin, mode }).then(refresh);
            }
        });
        group.append(option);
    }
    return group;
};

const renderSites = (state: PopupState, here: string | undefined): void => {
    const section = byId("sites");
    show(section, state.sandbox !== undefined || state.grants.length > 0);
    const grants = state.grants.toSorted((a, b) => siteOf(a.origin).localeCompare(siteOf(b.origin)));
    byId("sites-count").textContent = grants.length === 0 ? "" : String(grants.length);

    // The tab in front, when it is a site nobody allowed yet: the quickest way to allow one is to be on it.
    const card = byId("here");
    // Left out while a request is waiting: that card is the decision in front of the person, and one is enough.
    const offerHere = here !== undefined && state.pending === undefined && !grants.some((grant) => grant.origin === here);
    const error = byId("add-error");
    card.replaceChildren();
    if (offerHere) {
        card.className = "here";
        card.append(
            favicon(here),
            h(
                "div",
                { class: "host" },
                h("span", { class: "name", text: siteOf(here), title: here }),
                h("span", { class: "muted", text: "This tab · allow it to" }),
            ),
            h(
                "div",
                { class: "buttons" },
                button("Read", "plain", () => void allow(here, "read", error)),
                button("Read & act", "primary", () => void allow(here, "act", error)),
            ),
        );
    }
    show(card, offerHere);

    const list = byId("site-list");
    const rows: HTMLElement[] = [];
    if (state.sandbox !== undefined && state.scopes.read !== "on") {
        rows.push(
            notice(
                "info",
                "info",
                "Reading pages is off",
                "It is switched off on this browser's card in your sandbox, so the sites below do nothing until it is on.",
            ),
        );
    } else if (state.sandbox !== undefined && state.scopes.act !== "on" && grants.some((grant) => grant.mode === "act")) {
        rows.push(
            notice(
                "info",
                "info",
                "Clicking and typing is off",
                "It is switched off on this browser's card in your sandbox, so every site works as read only for now.",
            ),
        );
    }
    for (const grant of grants) {
        const remove = h("button", { class: "icon-btn", title: `Remove ${siteOf(grant.origin)}` }, icon("remove"));
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${siteOf(grant.origin)}`);
        remove.addEventListener("click", () => void send({ type: "revoke", origin: grant.origin }).then(refresh));
        const host = h("span", { class: "host" }, h("span", { text: siteOf(grant.origin), title: `${grant.origin} — ${modeLabel(grant.mode)}` }));
        if (grant.origin === here) {
            host.append(h("span", { class: "tag", text: "this tab" }));
        }
        rows.push(h("div", { class: "site" }, favicon(grant.origin), host, segment(grant), remove));
    }
    if (grants.length === 0) {
        rows.push(
            h("p", {
                class: "empty",
                text: offerHere
                    ? "None yet. Allow this tab above, or your agent will ask when it needs a site."
                    : "None yet. Your agent asks when it needs a site, or open one and allow it here.",
            }),
        );
    }
    list.replaceChildren(...rows);
};

const LOG_SHORT = 5;
const LOG_LONG = 60;
let logExpanded = false;

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// An entry as a sentence. Entries written before activity.ts hold the call's JSON and its failure in one string,
// `{"ref":"e9"} — refused: …`, cut at 300 characters; those are read back through the same sentences when they parse.
const sentence = (entry: ActivityEntry): { text: string; note: string | undefined; raw: boolean } => {
    if (entry.tool === "owner") {
        return { text: `You ${lowerFirst(entry.detail)}`, note: undefined, raw: false };
    }
    if (entry.note !== undefined || !entry.detail.startsWith("{")) {
        return { text: upperFirst(entry.detail), note: entry.note, raw: false };
    }
    const cut = entry.detail.indexOf("} — ");
    const json = cut === -1 ? entry.detail : entry.detail.slice(0, cut + 1);
    const note = cut === -1 ? undefined : entry.detail.slice(cut + 4);
    try {
        const args = JSON.parse(json) as Record<string, unknown>;
        // The old record kept a fill's length as "<86 characters>"; describeCall counts the text it is given.
        const typed = /^<(\d+) characters>$/.exec(String(args["text"] ?? ""));
        return { text: describeCall(entry.tool, typed === null ? args : { ...args, text: "x".repeat(Number(typed[1])) }), note, raw: false };
    } catch {
        // Cut mid-value at 300 characters, so it no longer parses: shown as it was written, which is what it said.
        return { text: `${entry.tool} ${json}`, note, raw: true };
    }
};

const renderActivity = (state: PopupState): void => {
    const section = byId("activity");
    show(section, state.sandbox !== undefined || state.log.length > 0);
    const shown = state.log.slice(0, logExpanded ? LOG_LONG : LOG_SHORT);
    const rows = shown.map((entry) => {
        const { text, note, raw } = sentence(entry);
        const kind = entry.tool === "owner" ? "you" : entry.tool === "connection" ? "sys" : entry.ok ? "ok" : "bad";
        const sign = kind === "ok" ? "✓" : kind === "bad" ? "✕" : "•";
        const row = h(
            "li",
            { class: kind },
            h("span", { class: "sign", text: sign }),
            h("span", { class: raw ? "text raw" : "text", text, title: text }),
            when(entry.at, true),
        );
        if (!entry.ok && note !== undefined && note !== "") {
            // The refusal's first sentence is the fact ("Not allowed on mail.google.com."); the rest is advice written
            // for the agent, kept in the tooltip.
            row.append(h("span", { class: "note", text: upperFirst(note.split(/(?<=\.)\s/)[0] ?? note), title: note }));
        }
        return row;
    });
    if (rows.length === 0) {
        rows.push(
            h(
                "li",
                { class: "sys" },
                h("span", { class: "sign", text: "•" }),
                h("span", { class: "text", text: "Nothing yet. What the agent does here shows up as it happens." }),
            ),
        );
    }
    byId("log").replaceChildren(...rows);
    byId("activity-count").textContent = state.log.length === 0 ? "" : `last ${Math.min(state.log.length, LOG_LONG)}`;
    const more = byId<HTMLButtonElement>("log-more");
    const hiddenCount = Math.min(state.log.length, LOG_LONG) - shown.length;
    show(more, logExpanded || hiddenCount > 0);
    more.textContent = logExpanded ? "Show less" : `Show ${hiddenCount} more`;
};

let disarm: ReturnType<typeof setTimeout> | undefined;

const renderFooter = (state: PopupState): void => {
    show(byId("footer"), state.sandbox !== undefined);
    byId<HTMLInputElement>("open-on-ask").checked = state.settings.openOnAsk;
    show(byId("unpair"), state.sandbox !== undefined);
};

let current: PopupState | undefined;
let drawn = "";
let busy: Promise<void> | undefined;
let again = false;

// The site of the tab in front, when Chrome names it: `activeTab` does once the person clicks the toolbar icon, and
// a popup that opened by itself (an agent's request) gets nothing, which simply leaves the "this tab" card out.
const tabInFront = async (own: string | undefined): Promise<string | undefined> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pattern = originPattern(tab?.url);
    return pattern === own ? undefined : pattern;
};

const draw = async (): Promise<void> => {
    const state = await send<PopupState>({ type: "state" });
    const here = await tabInFront(sandboxOwnOrigin(state.sandbox?.url));
    current = state;
    // Redraws only when something changed: replacing a button under a pointer mid-click loses the click.
    const key = JSON.stringify([state, here, logExpanded]);
    if (key !== drawn) {
        drawn = key;
        renderHeader(state);
        renderAlerts(state);
        renderWelcome(state);
        renderSites(state, here);
        renderActivity(state);
        renderFooter(state);
    }
    for (const node of document.querySelectorAll<HTMLElement>("time[data-at]")) {
        node.textContent = ago(Number(node.dataset["at"]), node.dataset["short"] === "1");
    }
};

// One draw at a time; a change that lands mid-draw asks for one more rather than racing it.
const refresh = async (): Promise<void> => {
    if (busy !== undefined) {
        again = true;
        return await busy;
    }
    busy = (async () => {
        do {
            again = false;
            await draw();
        } while (again);
    })();
    try {
        await busy;
    } finally {
        busy = undefined;
    }
};

const wire = (): void => {
    byId<HTMLFormElement>("pair-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const error = byId("pair-error");
        const code = byId<HTMLInputElement>("pair-code").value.trim();
        let url: string;
        try {
            const decoded = JSON.parse(
                atob(
                    code
                        .replace(/^ixb1_/, "")
                        .replaceAll("-", "+")
                        .replaceAll("_", "/"),
                ),
            ) as { url?: unknown };
            url = new URL(String(decoded.url)).href;
        } catch {
            // What was pasted is the whole story here, and the message says what to paste instead.
            say(error, `That does not look like a connection code. Copy it again from your sandbox.`);
            return;
        }
        say(error, undefined);
        void pair(code, url).then((message) => say(error, message));
    });

    byId<HTMLButtonElement>("pause").addEventListener("click", () => {
        if (current !== undefined) {
            void send({ type: "pause", value: !current.paused }).then(refresh);
        }
    });

    const addForm = byId<HTMLFormElement>("add-form");
    const addInput = byId<HTMLInputElement>("add-site");
    const addOpen = byId<HTMLButtonElement>("add-open");
    addOpen.addEventListener("click", () => {
        const opening = addForm.hidden !== false;
        show(addForm, opening);
        if (opening) {
            addInput.focus();
        }
    });
    addForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const error = byId("add-error");
        const typed = addInput.value.trim();
        const origin = originPattern(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
        const site = origin === undefined ? "" : siteOf(origin);
        if (typed === "" || origin === undefined || (!site.includes(".") && !site.startsWith("localhost"))) {
            say(error, `Type a site like github.com or https://example.com.`);
            return;
        }
        if (origin === sandboxOwnOrigin(current?.sandbox?.url)) {
            say(error, `That is your sandbox itself, which the agent never works on.`);
            return;
        }
        say(error, undefined);
        void allow(origin, "read", error).then(() => {
            if (current?.grants.some((grant) => grant.origin === origin) === true) {
                addInput.value = "";
                show(addForm, false);
            }
        });
    });

    byId<HTMLButtonElement>("log-more").addEventListener("click", () => {
        logExpanded = !logExpanded;
        void refresh();
    });

    byId<HTMLInputElement>("open-on-ask").addEventListener("change", (event) => {
        const openOnAsk = (event.target as HTMLInputElement).checked;
        void send({ type: "settings", settings: { ...(current?.settings ?? { openOnAsk }), openOnAsk } }).then(refresh);
    });

    // Two clicks, since disconnecting means pairing again from the sandbox: the first arms, the second does it.
    const unpair = byId<HTMLButtonElement>("unpair");
    unpair.addEventListener("click", () => {
        if (!unpair.classList.contains("armed")) {
            unpair.classList.add("armed");
            unpair.textContent = "Really disconnect?";
            disarm = setTimeout(() => {
                unpair.classList.remove("armed");
                unpair.textContent = "Disconnect";
            }, 3500);
            return;
        }
        clearTimeout(disarm);
        unpair.classList.remove("armed");
        unpair.textContent = "Disconnect";
        void send({ type: "unpair" }).then(refresh);
    });

    // Follows the worker while open: a request arriving, the agent's next call, a pause from another window.
    chrome.storage.onChanged.addListener(() => void refresh());
    // The link's state lives in the worker, not in storage, and the "ago" times age.
    setInterval(() => void refresh(), 2500);
};

wire();
void refresh().then(() => byId("root").focus({ preventScroll: true }));
