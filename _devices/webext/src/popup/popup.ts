import type { WebExtGrant, WebExtScopes } from "@intentic/sandbox-contract/webext";
import { describeCall } from "../background/activity.js";
import type { PopupState } from "../background/messages.js";
import { originPattern, sandboxOwnOrigin, siteOf } from "../background/policy.js";
import { DEFAULT_SETTINGS } from "../background/settings.js";
import type { ActivityEntry, Asking, PendingAccess } from "../background/store.js";
import { button, byId, h, icon, type IconName, say, send, show } from "./dom.js";
import { renderPasswords } from "./passwords-section.js";
import { agentOf, listed, pairSandbox, renderSandboxes, sandboxLabel, wirePasteForm, wireSandboxes } from "./sandboxes-section.js";
import { renderWorkspace, saveSettings } from "./workspace-section.js";

// Answers, in order: is the agent waiting on me, is it connected, what can it touch, what has it done, how do I stop
// it. Every permission widening happens here, not in the worker: chrome.permissions.request needs a user gesture,
// which only the popup has, so nothing the sandbox says can add to the grant list on its own. That is also why each
// click handler below calls `chrome.permissions.request` before its first await: an await in front of it spends the
// gesture, and Chrome then refuses without asking.

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
const when = (at: number, short: boolean): HTMLTimeElement => {
    // zone-checked: the extension has no kit; this formats per call on the reader's own clock and browser language.
    const node = h("time", { text: ago(at, short), title: new Date(at).toLocaleString() });
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

// Hands the pick to the worker, then asks Chrome. Chrome closes this popup the moment its own dialog takes focus
// (crbug.com/40721470), so nothing after the request is sure to run: the worker files the mode once Chrome holds the
// site (background/site-grants.ts), never before. Sent, not awaited, since an await in front of the request would
// spend the click.
const allow = async (origin: string, mode: WebExtGrant["mode"], error?: HTMLElement): Promise<void> => {
    void send({ type: "allow", origin, mode });
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted && error !== undefined) {
        say(error, `The browser did not allow ${siteOf(origin)}, so nothing changed.`);
    }
    await refresh();
};

// What each choice means, from the switches on this browser's card, so "Read & act" never promises more than
// policy.ts will let through.
// `card` names whose card: "your sandbox" while one is paired, the asking sandbox's name once there are several.
const modeHint = (scopes: WebExtScopes, card: string): string => {
    if (scopes.read !== "on") {
        return `Reading pages is switched off on this browser's card in ${card}, so neither choice does anything until it is on.`;
    }
    if (scopes.act !== "on") {
        return `Clicking and typing is switched off on this browser's card in ${card}, so either choice lets it read only.`;
    }
    const asks =
        scopes.confirm === "always"
            ? `, asking you on the page before every action`
            : scopes.confirm === "sensitive"
              ? `; it still checks with you before passwords, payments or deleting`
              : ``;
    return `Read & act also lets it click and type${asks}.`;
};

// Every paired sandbox's own origin: none is a site to allow, and the tab in front on one is not offered as one.
const sandboxOrigins = (state: PopupState): Set<string> =>
    new Set(
        state.sandboxes.flatMap((sandbox) => {
            const origin = sandboxOwnOrigin(sandbox.url);
            return origin === undefined ? [] : [origin];
        }),
    );

// The state across every paired sandbox, in the header's two words: connected when all are, offline when none is,
// and how many are when it is some.
const linkSummary = (state: PopupState): readonly [className: string, label: string] => {
    const open = state.sandboxes.filter((sandbox) => sandbox.link === "open").length;
    const closed = state.sandboxes.filter((sandbox) => sandbox.link === "closed").length;
    if (open === state.sandboxes.length) {
        return ["mark on", "Connected"];
    }
    if (closed === state.sandboxes.length) {
        return ["mark off", "Offline"];
    }
    if (closed === 0) {
        return ["mark wait", "Connecting…"];
    }
    return ["mark off", `${open} of ${state.sandboxes.length} connected`];
};

// The header's first line is the state itself, which is the one thing a glance at the popup is for. Before any
// sandbox is paired there is no state to report, so it names the product instead.
const renderHeader = (state: PopupState): void => {
    const paired = state.sandboxes.length > 0;
    const [className, label] = !paired ? ["mark", "Intentic"] : state.paused ? ["mark held", "Paused"] : linkSummary(state);
    byId("status").className = className;
    byId("status-text").textContent = label;
    const where = byId("where");
    where.textContent = paired ? listed(state.sandboxes.map((sandbox) => sandbox.name)) : "Your agent, in your browser";
    where.title = state.sandboxes.map((sandbox) => sandbox.url).join("\n");
    const pause = byId<HTMLButtonElement>("pause");
    show(pause, paired);
    pause.className = state.paused ? "btn primary small" : "btn small";
    pause.replaceChildren(icon(state.paused ? "play" : "pause"), state.paused ? "Resume" : "Pause");
    pause.title = state.paused
        ? "Let the agents work in this browser again"
        : state.sandboxes.length > 1
          ? "Stop every sandbox's agent from doing anything in this browser"
          : "Stop the agent from doing anything in this browser";
};

const askCard = (pending: PendingAccess, scopes: WebExtScopes | undefined, who: string, card: string): HTMLElement => {
    const error = h("div", { class: "error" });
    show(error, false);
    return h(
        "div",
        { class: "card ask" },
        h("div", { class: "eyebrow" }, h("span", { text: `${who} is asking for` }), when(pending.at, false)),
        h("div", { class: "title" }, favicon(pending.origin), h("span", { text: siteOf(pending.origin), title: pending.origin })),
        h("p", {
            class: pending.reason === "" ? "reason muted" : "reason",
            text: pending.reason === "" ? "It gave no reason." : `“${pending.reason}”`,
        }),
        h(
            "div",
            { class: "actions" },
            button("Decline", "quiet", () => void send({ type: "decline", sandbox: pending.sandbox }).then(refresh)),
            h("span", { class: "spacer" }),
            button("Read only", "plain", () => void allow(pending.origin, "read", error)),
            button("Read & act", "primary", () => void allow(pending.origin, "act", error)),
        ),
        error,
        ...(scopes === undefined ? [] : [h("p", { class: "hint", text: modeHint(scopes, card) })]),
    );
};

// A question the agent is waiting on, asked on a page that may be in its own window behind theirs: answered here, the
// panel on the page is taken down (background/asking.ts); "Show me" brings that page in front instead.
const askingCard = (asking: Asking, who: string): HTMLElement =>
    h(
        "div",
        { class: "card ask" },
        h("div", { class: "eyebrow" }, h("span", { text: `${who} is asking` }), when(asking.at, false)),
        h("div", { class: "title" }, favicon(asking.origin), h("span", { text: siteOf(asking.origin), title: asking.origin })),
        h("p", { class: "reason", text: asking.question }),
        h(
            "div",
            { class: "actions" },
            button("No", "quiet", () => void send({ type: "answer", id: asking.id, allow: false }).then(refresh)),
            h("span", { class: "spacer" }),
            button("Show me", "plain", () => void send({ type: "show", tabId: asking.tabId })),
            button("Allow", "primary", () => void send({ type: "answer", id: asking.id, allow: true }).then(refresh)),
        ),
        h("p", { class: "hint", text: "It is asked on the page too: answer whichever is nearer." }),
    );

// What connecting the offered sandbox means, said against what is already here: nothing, a renewal of the same
// sandbox, or one more beside the others.
const offerReason = (state: PopupState, offered: NonNullable<PopupState["offered"]>): string => {
    if (offered.paired) {
        return "It is connected already. Connecting again gives it a fresh key; nothing else changes.";
    }
    const others = state.sandboxes.map((sandbox) => sandbox.name);
    return others.length === 0
        ? "Its agent will work in this browser only on the sites you allow here, and you can pause or disconnect it at any time."
        : `It joins ${listed(others)}: its agent works on the same sites you allow here, under the switches on its own card, in a window of its own.`;
};

const offerCard = (state: PopupState, offered: NonNullable<PopupState["offered"]>): HTMLElement => {
    const error = h("div", { class: "error" });
    show(error, false);
    return h(
        "div",
        { class: "card ask" },
        h("div", { class: "eyebrow" }, h("span", { text: offered.paired ? "Your sandbox wants to connect again" : "A sandbox wants to connect" })),
        h("div", { class: "title" }, favicon(`${new URL(offered.url).origin}/*`), h("span", { text: offered.name, title: offered.url })),
        h("p", { class: "reason muted", text: offerReason(state, offered) }),
        h(
            "div",
            { class: "actions" },
            button("Not now", "quiet", () => void send({ type: "dismiss-offer" }).then(refresh)),
            h("span", { class: "spacer" }),
            // The worker redeems what it parked: the popup never holds the code's token.
            button("Connect", "primary", () => void pairSandbox(offered.url, undefined, refresh).then((message) => say(error, message))),
        ),
        error,
    );
};

// A line with its icon in the icon column: the header already says the state, this says what it means for you.
const notice = (kind: "paused" | "offline" | "info", glyph: IconName, title: string, body: string): HTMLElement =>
    h("div", { class: `note ${kind}` }, icon(glyph), h("p", {}, h("strong", { text: title }), ` ${body}`));

// A sandbox's switches by its key; none for one no longer paired, whose request is about to go with it.
const scopesOf = (state: PopupState, sandbox: string): WebExtScopes | undefined => state.sandboxes.find((each) => each.url === sandbox)?.scopes;

// Paused or unreachable, said once for the whole browser. One sandbox of several offline is said on its own row.
const stateNotice = (state: PopupState): HTMLElement | undefined => {
    const several = state.sandboxes.length > 1;
    if (state.paused) {
        return notice(
            "paused",
            "paused",
            several ? "No agent can do anything here." : "Your agent can't do anything here.",
            "Everything it asks for is refused until you resume.",
        );
    }
    if (state.sandboxes.length > 0 && state.sandboxes.every((sandbox) => sandbox.link === "closed")) {
        return notice(
            "offline",
            "offline",
            several ? "Can't reach your sandboxes." : "Can't reach your sandbox.",
            "It reconnects by itself once the sandbox is running again.",
        );
    }
    return undefined;
};

const renderAlerts = (state: PopupState): void => {
    const node = byId("alerts");
    const items: HTMLElement[] = [];
    if (state.offered !== undefined) {
        items.push(offerCard(state, state.offered));
    }
    for (const asking of state.asking) {
        items.push(askingCard(asking, agentOf(state, asking.sandbox)));
    }
    for (const pending of state.pending) {
        const card = state.sandboxes.length > 1 ? sandboxLabel(state, pending.sandbox) : "your sandbox";
        items.push(askCard(pending, scopesOf(state, pending.sandbox), agentOf(state, pending.sandbox), card));
    }
    const said = stateNotice(state);
    if (said !== undefined) {
        items.push(said);
    }
    node.replaceChildren(...items);
    show(node, items.length > 0);
};

const renderWelcome = (state: PopupState): void => {
    show(byId("welcome"), state.sandboxes.length === 0 && state.offered === undefined);
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

// What a switch on a sandbox's card does to the list, said above it rather than inside it. The sites are the same for
// every sandbox, the switches are each sandbox's own, so with several the note names the ones it is true of.
const siteNotes = (state: PopupState): HTMLElement[] => {
    const readOff = state.sandboxes.filter((sandbox) => sandbox.scopes.read !== "on");
    const actOff = state.sandboxes.filter((sandbox) => sandbox.scopes.read === "on" && sandbox.scopes.act !== "on");
    const one = state.sandboxes.length === 1;
    const notes: HTMLElement[] = [];
    if (readOff.length > 0) {
        notes.push(
            notice(
                "info",
                "info",
                one ? "Reading pages is off." : `Reading pages is off in ${listed(readOff.map((sandbox) => sandbox.name))}.`,
                one
                    ? "It is switched off on this browser's card in your sandbox, so these sites do nothing until it is on."
                    : "It is switched off on this browser's card there, so these sites do nothing for that agent until it is on.",
            ),
        );
    }
    if (actOff.length > 0 && state.grants.some((grant) => grant.mode === "act")) {
        notes.push(
            notice(
                "info",
                "info",
                one ? "Clicking and typing is off." : `Clicking and typing is off in ${listed(actOff.map((sandbox) => sandbox.name))}.`,
                one
                    ? "It is switched off on this browser's card in your sandbox, so every site works as read only for now."
                    : "It is switched off on this browser's card there, so every site works as read only for that agent for now.",
            ),
        );
    }
    return notes;
};

const renderSites = (state: PopupState, here: string | undefined): void => {
    const section = byId("sites");
    show(section, state.sandboxes.length > 0 || state.grants.length > 0);
    const grants = state.grants.toSorted((a, b) => siteOf(a.origin).localeCompare(siteOf(b.origin)));

    // The tab in front, when it is a site nobody allowed yet: the quickest way to allow one is to be on it.
    const card = byId("here");
    // Left out while a request is waiting: that card is the decision in front of the person, and one is enough.
    const offerHere = here !== undefined && state.pending.length === 0 && !grants.some((grant) => grant.origin === here);
    const error = byId("add-error");
    card.replaceChildren();
    if (offerHere) {
        // Two equal choices: this is a suggestion, and the popup's one loud surface is the agent's own request.
        card.append(
            h(
                "div",
                { class: "offer" },
                favicon(here),
                h("span", { class: "name", text: siteOf(here), title: here }),
                h("span", { class: "sub", text: "This tab isn't allowed" }),
                h(
                    "div",
                    { class: "buttons" },
                    button("Read", "plain", () => void allow(here, "read", error), "small"),
                    button("Read & act", "plain", () => void allow(here, "act", error), "small"),
                ),
            ),
        );
    }
    show(card, offerHere);

    byId("site-notes").replaceChildren(...siteNotes(state));

    const rows: HTMLElement[] = [];
    for (const grant of grants) {
        const remove = h("button", { class: "icon-btn", title: `Remove ${siteOf(grant.origin)}` }, icon("remove"));
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${siteOf(grant.origin)}`);
        remove.addEventListener("click", () => void send({ type: "revoke", origin: grant.origin }).then(refresh));
        const host = h(
            "div",
            { class: "host" },
            h("span", { class: "name", text: siteOf(grant.origin), title: `${grant.origin} — ${modeLabel(grant.mode)}` }),
        );
        if (grant.origin === here) {
            host.append(h("span", { class: "sub here", text: "This tab" }));
        }
        rows.push(h("div", { class: "row" }, favicon(grant.origin), host, segment(grant), remove));
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
    byId("site-list").replaceChildren(...rows);
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

// The line's words, led by whose agent it was once several sandboxes share this browser. A connection's line names its
// sandbox already.
const entryText = (state: PopupState, entry: ActivityEntry, text: string, raw: boolean): HTMLElement => {
    const line = h("span", { class: raw ? "text raw" : "text", title: text });
    if (state.sandboxes.length > 1 && entry.sandbox !== undefined && entry.tool !== "connection") {
        const from = sandboxLabel(state, entry.sandbox);
        line.title = `${from}: ${text}`;
        line.append(h("span", { class: "from", text: from }), " ");
    }
    line.append(text);
    return line;
};

const renderActivity = (state: PopupState): void => {
    const section = byId("activity");
    show(section, state.sandboxes.length > 0 || state.log.length > 0);
    const shown = state.log.slice(0, logExpanded ? LOG_LONG : LOG_SHORT);
    const rows = shown.map((entry) => {
        const { text, note, raw } = sentence(entry);
        const kind = entry.tool === "owner" ? "you" : entry.tool === "connection" ? "sys" : entry.ok ? "ok" : "bad";
        // A tick for a call that worked, a cross for one that did not, and a dot for what you or the link did.
        const sign = kind === "ok" ? icon("done") : kind === "bad" ? icon("failed") : h("span", { class: "pip" });
        const row = h("li", { class: kind }, h("span", { class: "sign" }, sign), entryText(state, entry, text, raw), when(entry.at, true));
        if (!entry.ok && note !== undefined && note !== "") {
            // The refusal's first sentence is the fact ("Not allowed on mail.google.com."); the rest is advice written
            // for the agent, kept in the tooltip.
            row.append(h("span", { class: "note-line", text: upperFirst(note.split(/(?<=\.)\s/)[0] ?? note), title: note }));
        }
        return row;
    });
    if (rows.length === 0) {
        rows.push(
            h(
                "li",
                { class: "sys" },
                h("span", { class: "sign" }, h("span", { class: "pip" })),
                h("span", { class: "text", text: "Nothing yet. What the agent does here shows up as it happens." }),
            ),
        );
    }
    byId("log").replaceChildren(...rows);
    const more = byId<HTMLButtonElement>("log-more");
    const hiddenCount = Math.min(state.log.length, LOG_LONG) - shown.length;
    show(more, logExpanded || hiddenCount > 0);
    more.textContent = logExpanded ? "Show less" : `Show ${hiddenCount} more`;
};

const renderFooter = (state: PopupState): void => {
    show(byId("footer"), state.sandboxes.length > 0);
    byId<HTMLInputElement>("open-on-ask").checked = state.settings.openOnAsk;
};

let current: PopupState | undefined;
let drawn = "";
let busy: Promise<void> | undefined;
let again = false;

// The site of the tab in front, when Chrome names it: `activeTab` does once the person clicks the toolbar icon, and
// a popup that opened by itself (an agent's request) gets nothing, which simply leaves the "this tab" card out.
const tabInFront = async (sandboxes: ReadonlySet<string>): Promise<string | undefined> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pattern = originPattern(tab?.url);
    return pattern === undefined || sandboxes.has(pattern) ? undefined : pattern;
};

const draw = async (): Promise<void> => {
    const state = await send<PopupState>({ type: "state" });
    const here = await tabInFront(sandboxOrigins(state));
    current = state;
    // Redraws only when something changed: replacing a button under a pointer mid-click loses the click.
    const key = JSON.stringify([state, here, logExpanded]);
    if (key !== drawn) {
        drawn = key;
        renderHeader(state);
        renderAlerts(state);
        renderWelcome(state);
        renderPasswords(state, refresh);
        renderSites(state, here);
        renderWorkspace(state, refresh);
        renderSandboxes(state, refresh);
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
    wirePasteForm("pair-form", "pair-code", "pair-error", refresh);

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
        if (current !== undefined && sandboxOrigins(current).has(origin)) {
            say(error, `That is one of your sandboxes itself, which no agent works on.`);
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
        void saveSettings(current?.settings ?? DEFAULT_SETTINGS, { openOnAsk: (event.target as HTMLInputElement).checked }, refresh);
    });

    // The header only needs an edge once something has scrolled under it.
    const header = byId("header");
    const edge = (): void => {
        header.classList.toggle("scrolled", window.scrollY > 0);
    };
    window.addEventListener("scroll", edge, { passive: true });

    // Follows the worker while open: a request arriving, the agent's next call, a pause from another window.
    chrome.storage.onChanged.addListener(() => void refresh());
    // The link's state lives in the worker, not in storage, and the "ago" times age.
    setInterval(() => void refresh(), 2500);
};

wire();
wireSandboxes(refresh);
void refresh().then(() => byId("root").focus({ preventScroll: true }));
