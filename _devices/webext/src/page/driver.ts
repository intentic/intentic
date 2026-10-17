// the rule is exactly wrong for this file: every helper
// Each helper is nested inside the function that uses it, since executeScript serializes and re-parses that
// function inside the page, where nothing else in this module exists.
import type { PageElement } from "@intentic/browser/page";

// Runs inside the tab via chrome.scripting.executeScript, in the isolated world: same DOM as the page, separate JS
// heap, so neither side can see the other's variables. Refs live in window.intenticPageRefs, scoped to the
// document and dead on navigation, so a stale ref is refused rather than resolved to whatever now fills that slot.

// Snapshot as it comes back from the tab; mirrors @intentic/browser's RawSnapshot plus `loading`, the one thing
// only a real browser knows (nothing on the page vs. not yet).
export interface DriverSnapshot {
    readonly url: string;
    readonly title: string;
    readonly truncated: boolean;
    readonly loading: boolean;
    readonly elements: PageElement[];
}

// Describes an element before acting on it. `sensitive` is judged locally: this element or its enclosing form
// deals in passwords, money, or deletion.
export interface RefDescription {
    readonly ok: boolean;
    readonly role: string;
    readonly name: string;
    readonly sensitive: boolean;
}

// What an action reports back. `gone` is an element that was there when it was described and is not any more: a
// menu or popover the page closed in between, which the caller tells apart from a ref that never resolved.
export interface ActionResult {
    readonly ok: boolean;
    readonly gone?: boolean;
    readonly message: string;
}

// The slot pinFocusedField holds a field in, on the isolated world's window, where the page's own scripts never see it.
declare global {
    interface Window {
        intenticFocusPin?: { readonly pin: string; readonly el: HTMLElement } | undefined;
    }
}

// The field in focus, before a stored secret is typed into it: whether there is one to type into, and whether it is a
// password input, which the sandbox's guard and its approval card name.
export interface FocusedField {
    readonly ok: boolean;
    readonly field: "password" | "text";
    readonly message: string;
}

/* ---- the injected functions ---- */

// Walks the page (piercing shadow roots), parks the ref table, and caps at 150 elements — matching the CDP
// driver's ceiling — noting truncation rather than silently dropping it.
export const collectPage = (): DriverSnapshot => {
    const MAX = 150;
    const refs: Element[] = [];
    (window as unknown as { intenticPageRefs?: Element[] }).intenticPageRefs = refs;

    const visible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }
        const style = window.getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };

    const roleOf = (el: Element): string => {
        const explicit = el.getAttribute("role");
        if (explicit !== null && explicit !== "") {
            return explicit;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === "a") {
            return "link";
        }
        if (tag === "button") {
            return "button";
        }
        if (tag === "select") {
            return "combobox";
        }
        if (tag === "textarea") {
            return "textbox";
        }
        if (/^h[1-6]$/.test(tag)) {
            return "heading";
        }
        if (tag === "input") {
            const type = (el.getAttribute("type") ?? "text").toLowerCase();
            if (type === "submit" || type === "button" || type === "reset") {
                return "button";
            }
            if (type === "checkbox") {
                return "checkbox";
            }
            if (type === "radio") {
                return "radio";
            }
            if (type === "file") {
                return "file";
            }
            if (type === "password") {
                return "password";
            }
            return "textbox";
        }
        if ((el as HTMLElement).isContentEditable) {
            return "textbox";
        }
        return "element";
    };

    const nameOf = (el: Element): string => {
        const labelled = el.getAttribute("aria-labelledby");
        const byId = labelled === null ? null : document.getElementById(labelled.split(/\s+/)[0] ?? "");
        const candidates = [
            el.getAttribute("aria-label"),
            byId?.textContent ?? null,
            el.getAttribute("alt"),
            el.getAttribute("placeholder"),
            el.getAttribute("title"),
            el.getAttribute("name"),
            // innerText (what's visible) falls back to textContent (headless DOM has no layout, so innerText is
            // undefined).
            (el as HTMLElement).innerText ?? el.textContent ?? "",
            (el as HTMLInputElement).value ?? "",
        ];
        for (const candidate of candidates) {
            if (typeof candidate === "string" && candidate.trim() !== "") {
                return candidate.trim().replace(/\s+/g, " ").slice(0, 120);
            }
        }
        return "";
    };

    // Shadow roots are walked; iframes are not, since a cross-document ref couldn't be acted on from here.
    const selector =
        'a[href], button, input, textarea, select, summary, [role], [onclick], [contenteditable=""], [contenteditable="true"], h1, h2, h3';
    const found: Element[] = [];
    const walk = (root: Document | ShadowRoot): void => {
        for (const el of Array.from(root.querySelectorAll("*"))) {
            if (el.matches(selector)) {
                found.push(el);
            }
            const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
            if (shadow != null) {
                walk(shadow);
            }
        }
    };
    walk(document);

    const elements: PageElement[] = [];
    for (const el of found) {
        if (elements.length >= MAX) {
            break;
        }
        if (!visible(el)) {
            continue;
        }
        const role = roleOf(el);
        const name = nameOf(el);
        // A nameless non-input can't be asked for by name, so it's skipped.
        if (name === "" && role !== "textbox" && role !== "password" && role !== "checkbox" && role !== "file") {
            continue;
        }
        const ref = `e${refs.length}`;
        refs.push(el);
        const value = (el as HTMLInputElement).value;
        const entry: { ref: string; role: string; name: string; value?: string } = { ref, role, name };
        // A password's value is never reported; only that the field exists.
        if (role !== "password" && typeof value === "string" && value !== "" && role !== "button") {
            entry.value = value.slice(0, 120);
        }
        if (role === "checkbox" || role === "radio") {
            entry.value = (el as HTMLInputElement).checked ? "checked" : "unchecked";
        }
        elements.push(entry);
    }
    return {
        url: location.href,
        title: document.title,
        truncated: found.length > 0 && elements.length >= MAX,
        loading: document.readyState !== "complete",
        elements,
    };
};

// Reads the page as a person would see it: innerText (not textContent) respects display:none and line breaks,
// avoiding a wall of concatenated nav labels.
export const readPageText = (): { url: string; title: string; text: string; truncated: boolean } => {
    const LIMIT = 40_000;
    const main = document.querySelector("main") ?? document.querySelector("article") ?? document.body;
    const raw = (main as HTMLElement | null)?.innerText ?? main?.textContent ?? "";
    const text = raw.replace(/\n{3,}/g, "\n\n").trim();
    return { url: location.href, title: document.title, text: text.slice(0, LIMIT), truncated: text.length > LIMIT };
};

// Resolves what a ref points at and whether acting on it needs confirmation. The sensitivity test is broad and
// cheap: over-asking costs a click, under-asking costs money. `pin` holds on to the element itself for the action
// that follows, since a snapshot taken while the person decides renumbers every ref, and the yes was for this
// element, not for whatever its ref names by then. One slot: actions run one at a time.
export const describeRef = (ref: string, pin?: string): RefDescription => {
    const refs = (window as unknown as { intenticPageRefs?: Element[] }).intenticPageRefs ?? [];
    const index = /^e(\d+)$/.exec(ref.trim());
    const el = index?.[1] === undefined ? undefined : refs[Number(index[1])];
    if (el === undefined || !el.isConnected) {
        return { ok: false, role: "", name: "", sensitive: false };
    }
    if (pin !== undefined) {
        (window as unknown as { intenticPinned?: { pin: string; el: Element } }).intenticPinned = { pin, el };
    }
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? el.getAttribute("value") ?? el.getAttribute("aria-label") ?? "")
        .trim()
        .slice(0, 120);
    // Credential check is scoped to the nearest enclosing form/dialog/section, not page-wide, and to the form a control
    // names with `form=` from outside it. The markup says it in any language: a card number is `autocomplete="cc-…"`.
    const named = el.getAttribute("form");
    const scopes = [el.closest("form, dialog, [role='dialog'], [role='form'], section, article, main"), named === null ? null : document.getElementById(named)];
    const credentials = 'input[type="password"], input[autocomplete*="cc-"], input[name*="card" i], input[autocomplete="one-time-code"]';
    // What the element says, including what an icon button or an <input type=submit> says only in its attributes.
    const button = el.matches('input[type="submit" i], input[type="button" i], input[type="image" i]');
    const said = [text, el.getAttribute("aria-label"), el.getAttribute("title"), button ? el.getAttribute("value") : null, button ? el.getAttribute("alt") : null]
        .filter((part) => part !== null)
        .join(" ");
    // Words, in English and in Polish (the owner's own UI language), each starting at a word's edge. Polish stems stay
    // open at the end so every inflection matches (zapłać, zapłacić, zapłata). `\b` is ASCII-only even under /u, so a
    // Polish letter would read as an edge; the edges are spelled as "no letter or digit" instead.
    // allow(dependency-text): pages' own button wording; an unmatched one is clicked unasked, so the lists err broad.
    const edge = (words: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})`, "iu");
    const money = edge(
        [
            "(?:pay|buy|checkout|order|purchase|donate|transfer|withdraw|subscribe|send money)(?![\\p{L}\\p{N}])",
            // zapłać, opłać, wpłać, wypłać, dopłać, płacę; płatność, płatny; zapłata, wpłata, wypłata.
            "(?:za|o|do|w|wy)?pła[cć]",
            "(?:za|o|do|w|wy)pla[cć]",
            "płatn",
            "(?:za|w|wy)płat",
            // kup, kupuję, kupić, zakup, dokup, wykup; not a kupon (coupon).
            "(?:za|do|wy)?kup(?!on)",
            // zamów, zamówienie, zamawiam.
            "zam[óo]w",
            "zamaw",
            "przele[wj]",
            "subskry[bp]",
            "darowizn",
            "wesprz",
            "doład",
            "pieni[ąa]dz",
            "pieni[ęe]dz",
            "do\\s+kasy",
        ].join("|"),
    );
    const destructive = edge(
        [
            "(?:delete|remove|deactivate|close account|revoke|wipe|erase|uninstall|terminate)(?![\\p{L}\\p{N}])",
            // usuń, usunąć, usuwam, usunięcie.
            "usu[nńw]",
            "s?kas(?:uj|ow)",
            "dezaktyw",
            "unieważ",
            "uniewaz",
            "wyczy[śs]",
            "wyma[żz]",
            "odinstal",
            "opróżn",
            // Only with what they end: a bare "Zamknij", "Anuluj", "Cofnij" or "Zakończ" closes a dialog or a wizard.
            "zamk\\p{L}*\\s+kont",
            "(?:cofn|odbier|odebr)\\p{L}*\\s+dostęp",
            "(?:zakończ|anuluj|wypowi|rozwiąż)\\p{L}*\\s+(?:subskrypc|członkostw|umow|abonament|kont|plan)",
        ].join("|"),
    );
    const sensitive = scopes.some((scope) => scope !== null && scope.querySelector(credentials) !== null) || money.test(said) || destructive.test(said);
    return { ok: true, role: el.tagName.toLowerCase(), name: text, sensitive };
};

// Clicks like a person would: dispatches the pointer/mouse sequence first (some frameworks listen on pointerdown,
// not .click()), then calls click(). With `pin` (describeRef) it clicks the element the person was asked about.
export const clickRef = (ref: string, pin?: string): ActionResult => {
    const resolve = (): Element | undefined => {
        const holder = window as unknown as { intenticPageRefs?: Element[]; intenticPinned?: { pin: string; el: Element } | undefined };
        const pinned = holder.intenticPinned;
        holder.intenticPinned = undefined;
        if (pin !== undefined) {
            return pinned?.pin === pin ? pinned.el : undefined;
        }
        const index = /^e(\d+)$/.exec(ref.trim());
        return index?.[1] === undefined ? undefined : holder.intenticPageRefs?.[Number(index[1])];
    };
    // The events go to what a person's pointer would land on, the innermost element at the centre, so they bubble
    // through every listener between it and the ref: PrimeVue's menus listen on a div INSIDE the li[role=menuitem]
    // a snapshot names, and a click dispatched on the li itself never reaches it (the tool said "clicked" and the
    // menu's command never ran). Anything else on top (an overlay, a backdrop) is not what was asked for: the ref
    // itself gets the click, as before.
    const landsOn = (el: Element, x: number, y: number): Element => {
        let hit = document.elementFromPoint?.(x, y) ?? null;
        while (hit?.shadowRoot) {
            const inner = hit.shadowRoot.elementFromPoint(x, y);
            if (inner === null || inner === hit) {
                break;
            }
            hit = inner;
        }
        for (let at: Node | null = hit; at !== null; at = at.parentNode ?? (at instanceof ShadowRoot ? at.host : null)) {
            if (at === el) {
                return hit ?? el;
            }
        }
        return el;
    };
    const el = resolve();
    if (el === undefined) {
        return { ok: false, message: `No element ${ref} on this page: take a fresh snapshot, the page has changed.` };
    }
    // No box is gone too: a menu hidden rather than removed still holds its items, and a click on one is a click on
    // nothing the person can see.
    const box = el.isConnected ? el.getBoundingClientRect() : undefined;
    if (box === undefined || box.width <= 0 || box.height <= 0) {
        return { ok: false, gone: true, message: `${ref} is gone from the page: take a fresh snapshot.` };
    }
    el.scrollIntoView?.({ block: "center", inline: "center" });
    (el as HTMLElement).focus?.();
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const target = landsOn(el, x, y);
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
    target.dispatchEvent(new PointerEvent("pointerdown", init));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new PointerEvent("pointerup", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    (target as HTMLElement).click();
    return { ok: true, message: `clicked` };
};

// Types into a field via the prototype's native value setter, not `el.value =`: frameworks like React override
// that property, so a direct assign updates the display but not what the framework tracks.
// `pin` as in clickRef: the field the person was asked about, not whatever its ref names by now.
export const fillRef = (ref: string, text: string, submit: boolean, pin?: string): ActionResult => {
    const resolve = (): Element | undefined => {
        const holder = window as unknown as { intenticPageRefs?: Element[]; intenticPinned?: { pin: string; el: Element } | undefined };
        const pinned = holder.intenticPinned;
        holder.intenticPinned = undefined;
        if (pin !== undefined) {
            return pinned?.pin === pin ? pinned.el : undefined;
        }
        const index = /^e(\d+)$/.exec(ref.trim());
        return index?.[1] === undefined ? undefined : holder.intenticPageRefs?.[Number(index[1])];
    };
    const el = resolve();
    if (el === undefined) {
        return { ok: false, message: `No element ${ref} on this page: take a fresh snapshot.` };
    }
    if (!el.isConnected) {
        return { ok: false, gone: true, message: `${ref} is gone from the page: take a fresh snapshot.` };
    }
    const target = el as HTMLElement;
    target.scrollIntoView?.({ block: "center" });
    target.focus();
    if (target.isContentEditable) {
        target.textContent = text;
        target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    } else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter === undefined) {
            return { ok: false, message: `${ref} is a ${el.tagName.toLowerCase()}, which cannot be typed into.` };
        }
        setter.call(el, text);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (submit) {
        const key = { bubbles: true, cancelable: true, composed: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
        target.dispatchEvent(new KeyboardEvent("keydown", key));
        target.dispatchEvent(new KeyboardEvent("keyup", key));
        // requestSubmit (not form.submit()) runs validation and fires the submit event.
        const form = el.closest("form");
        if (form !== null) {
            form.requestSubmit();
        }
    }
    return { ok: true, message: submit ? `typed and submitted` : `typed` };
};

// The field a stored secret is about to be typed into: the one in focus, held by `pin` for typeSecretInto, since the
// sandbox's release of the value can wait minutes on a person and focus can wander meanwhile. Its own slot, apart
// from describeRef's, so a click while the secret is released cannot repoint it. Only the page's own document: a
// field inside a frame is refused by name, since the page tools never reach into frames either.
export const pinFocusedField = (pin: string): FocusedField => {
    window.intenticFocusPin = undefined;
    // Focus inside a shadow root shows on the document as its host; the field itself is further down.
    let el: Element | null = document.activeElement;
    while (el?.shadowRoot?.activeElement !== undefined && el.shadowRoot.activeElement !== null) {
        el = el.shadowRoot.activeElement;
    }
    if (el instanceof HTMLIFrameElement) {
        return { ok: false, field: "text", message: `The focused field is inside a frame of this page, where a secret cannot be typed.` };
    }
    // Text-like inputs only: a number or date input would mangle a secret, and a checkbox has nowhere to put one.
    const typeable = new Set(["text", "password", "email", "search", "tel", "url"]);
    const editable = (field: HTMLElement): boolean =>
        field instanceof HTMLInputElement
            ? typeable.has(field.type) && !field.disabled && !field.readOnly
            : field instanceof HTMLTextAreaElement
              ? !field.disabled && !field.readOnly
              : field.isContentEditable;
    if (!(el instanceof HTMLElement) || !editable(el)) {
        return { ok: false, field: "text", message: `No text field is focused on this page: click the field first, then type the secret again.` };
    }
    window.intenticFocusPin = { pin, el };
    return { ok: true, field: el instanceof HTMLInputElement && el.type === "password" ? "password" : "text", message: "" };
};

// Types a released secret into the field pinFocusedField held, as fillRef types (the native setter, then the events a
// framework listens for), and never submits: what happens to the form next is the agent's own, visible step. Refused
// when the page left the site the secret was released for, or the field left the page; the slot is emptied either way,
// so a pin is good for one value.
export const typeSecretInto = (pin: string, value: string, origin: string): ActionResult => {
    const pinned = window.intenticFocusPin;
    window.intenticFocusPin = undefined;
    if (location.origin !== origin) {
        return { ok: false, message: `The page moved to another site while the secret was being released, so nothing was typed.` };
    }
    if (pinned?.pin !== pin || !pinned.el.isConnected) {
        return {
            ok: false,
            gone: true,
            message: `The field that was focused left the page while the secret was being released, so nothing was typed. Click the field again, then type the secret again.`,
        };
    }
    const target = pinned.el;
    target.focus();
    if (target.isContentEditable) {
        target.textContent = value;
        target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        return { ok: true, message: `typed` };
    }
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter === undefined) {
        return { ok: false, message: `That field cannot be typed into, so nothing was typed.` };
    }
    setter.call(target, value);
    target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, message: `typed` };
};

// Selects by value or by visible label, since a model reading a snapshot usually has the label, not the value.
export const selectRef =(ref: string, values: string[]): { ok: boolean; message: string } => {
    const refs = (window as unknown as { intenticPageRefs?: Element[] }).intenticPageRefs ?? [];
    const index = /^e(\d+)$/.exec(ref.trim());
    const el = index?.[1] === undefined ? undefined : refs[Number(index[1])];
    if (!(el instanceof HTMLSelectElement)) {
        return { ok: false, message: `${ref} is not a dropdown.` };
    }
    const wanted = new Set(values.map((value) => value.trim().toLowerCase()));
    let matched = 0;
    for (const option of Array.from(el.options)) {
        const hit = wanted.has(option.value.trim().toLowerCase()) || wanted.has(option.text.trim().toLowerCase());
        option.selected = hit;
        matched += hit ? 1 : 0;
    }
    if (matched === 0) {
        return {
            ok: false,
            message: `None of those are options here. This one offers: ${Array.from(el.options)
                .map((option) => option.text)
                .join(", ")}`,
        };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, message: `selected ${matched} option${matched === 1 ? "" : "s"}` };
};

// A key for the page as a whole, sent to whatever has focus.
export const pressKeyOnPage = (key: string): { ok: boolean; message: string } => {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    const init = { bubbles: true, cancelable: true, composed: true, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keypress", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true, message: `pressed ${key}` };
};

export const scrollPage = (direction: string, amount: number): { ok: boolean; message: string } => {
    const step = Math.round(window.innerHeight * 0.8) * Math.max(1, amount);
    const by = direction === "up" ? { top: -step } : direction === "left" ? { left: -step } : direction === "right" ? { left: step } : { top: step };
    window.scrollBy({ ...by, behavior: "instant" as ScrollBehavior });
    return { ok: true, message: `scrolled ${direction}` };
};

// Polls for text rather than using MutationObserver, since the condition would be re-derived on every mutation
// anyway. Deadline is passed in by the caller, which owns the tool-call timeout.
// The pause between looks is spelled out here rather than imported: an imported `sleep` is a name of this module, and
// the page has no such name, so the first look that missed threw there and the tool read the empty answer as a crash
// ("Cannot read properties of null").
export const waitForText = async (needle: string, gone: boolean, deadlineMs: number): Promise<{ ok: boolean; message: string }> => {
    const pause = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms));
    const started = Date.now();
    const present = (): boolean => (document.body.innerText ?? document.body.textContent ?? "").includes(needle);
    for (;;) {
        if (present() !== gone) {
            return { ok: true, message: gone ? `"${needle}" is gone` : `"${needle}" appeared` };
        }
        if (Date.now() - started > deadlineMs) {
            return {
                ok: false,
                message: gone
                    ? `"${needle}" is still on the page after ${Math.round(deadlineMs / 1000)}s.`
                    : `"${needle}" never appeared (waited ${Math.round(deadlineMs / 1000)}s).`,
            };
        }
        await pause(200);
    }
};

// Flashes a message in the corner of the tab so actions are visible, not silent. Uses a shadow root with
// `all: initial` so the host page's styles can't hide or restyle it.
export const flashBanner = (message: string): void => {
    const ID = "intentic-agent-banner";
    // Replaces rather than updates, so the timeout below always owns exactly one banner.
    document.getElementById(ID)?.remove();
    const host = document.createElement("div");
    host.id = ID;
    const root = host.attachShadow({ mode: "open" });
    document.documentElement.append(host);
    const panel = document.createElement("div");
    panel.textContent = message;
    panel.setAttribute(
        "style",
        [
            "all: initial",
            "position: fixed",
            "z-index: 2147483647",
            "right: 14px",
            "bottom: 14px",
            "max-width: 320px",
            "padding: 9px 12px",
            "border-radius: 10px",
            "background: #15100b",
            "color: #efe3cd",
            "font: 13px/1.4 system-ui, sans-serif",
            "box-shadow: 0 6px 24px rgba(0,0,0,.28)",
            "border-left: 3px solid #e07b27",
            "pointer-events: none",
        ].join(";"),
    );
    root.append(panel);
    setTimeout(() => host.remove(), 4000);
};

// Asks in the page itself, beside what it is about, rather than in the popup or window.confirm() (which blocks the
// page's event agent), and without becoming part of the page. A person's click on a panel in the page used to
// reach the page too, as a click outside whatever menu or popover the agent had opened, and the page closed it
// (PrimeVue's menus hide on any document click outside them), so the click they allowed had nothing left to land
// on. Every event aimed at the panel is stopped at the window, ahead of the page's own listeners on the document and
// below, and pressing a button does not move focus. The shadow root is closed and only a trusted click answers: a
// snapshot cannot list these buttons, and neither the agent's own click nor the page's script can say yes for the
// person. Resolves false on timeout: an unanswered question is a no.
export const askConfirm = async (question: string, timeoutMs: number): Promise<boolean> => {
    // Everything a pointer, a finger or a key sends; listening on the window in the capture phase runs ahead of every
    // listener the page put on its document or elements (only one it put on the window earlier still sees these).
    const EVENTS = [
        "pointerdown",
        "pointerup",
        "pointerover",
        "pointerout",
        "pointermove",
        "mousedown",
        "mouseup",
        "mouseover",
        "mouseout",
        "mousemove",
        "click",
        "dblclick",
        "auxclick",
        "contextmenu",
        "touchstart",
        "touchend",
        "focusin",
        "focusout",
        "keydown",
        "keyup",
        "keypress",
    ];
    return await new Promise<boolean>((resolve) => {
        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "closed" });
        const panel = document.createElement("div");
        panel.setAttribute(
            "style",
            [
                "all: initial",
                "position: fixed",
                "z-index: 2147483647",
                "right: 14px",
                "bottom: 14px",
                "width: 320px",
                "padding: 14px",
                "border-radius: 12px",
                "background: #15100b",
                "color: #efe3cd",
                "font: 13px/1.45 system-ui, sans-serif",
                "box-shadow: 0 8px 32px rgba(0,0,0,.36)",
            ].join(";"),
        );
        const text = document.createElement("div");
        text.textContent = question;
        const row = document.createElement("div");
        row.setAttribute("style", "all: initial; display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end");
        const button = (label: string, primary: boolean): HTMLButtonElement => {
            const element = document.createElement("button");
            element.textContent = label;
            element.setAttribute(
                "style",
                [
                    "all: initial",
                    "cursor: pointer",
                    "padding: 5px 12px",
                    "border-radius: 7px",
                    "font: 13px system-ui, sans-serif",
                    primary
                        ? "background: #e07b27; color: #15100b"
                        : "background: transparent; color: #b7a68d; border: 1px solid rgba(201,160,92,.3)",
                ].join(";"),
            );
            return element;
        };
        const no = button("No", false);
        const yes = button("Allow", true);
        // Which button a click chose. The listener sits outside a closed root, so the event's path stops at the host;
        // the pointer's position says which button it was on, and a click from the keyboard (detail 0, no position)
        // lands on the one with focus.
        const chosen = (event: MouseEvent): boolean | undefined => {
            const on = (element: Element): boolean => {
                const box = element.getBoundingClientRect();
                return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
            };
            const picked = event.detail === 0 ? root.activeElement : [no, yes].find(on);
            return picked === yes ? true : picked === no ? false : undefined;
        };
        const swallow = (event: Event): void => {
            if (event.target !== host) {
                return;
            }
            event.stopImmediatePropagation();
            // A press's default is to focus what it lands on, which would take focus from the menu the agent opened.
            if (event.type === "mousedown") {
                event.preventDefault();
            }
            // SAFETY: only a "click" is read, and every click is a MouseEvent.
            const answer = event.isTrusted && event.type === "click" ? chosen(event as MouseEvent) : undefined;
            if (answer !== undefined) {
                finish(answer);
            }
        };
        const finish = (answer: boolean): void => {
            clearTimeout(timer);
            for (const type of EVENTS) {
                window.removeEventListener(type, swallow, true);
            }
            host.remove();
            resolve(answer);
        };
        for (const type of EVENTS) {
            window.addEventListener(type, swallow, true);
        }
        row.append(no, yes);
        panel.append(text, row);
        root.append(panel);
        document.documentElement.append(host);
        const timer = setTimeout(() => finish(false), timeoutMs);
    });
};
