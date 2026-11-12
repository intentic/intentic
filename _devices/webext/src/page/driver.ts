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
    // Something about an action that did land that the agent should know: a field the page reformatted.
    readonly note?: string;
}

// The slot pinFocusedField holds a field in, on the isolated world's window, where the page's own scripts never see it.
declare global {
    interface Window {
        intenticFocusPin?: { readonly pin: string; readonly el: HTMLElement } | undefined;
        // markDocument's mark: present for as long as this document is.
        intenticDocumentMark?: string;
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

    // What a person calls an element: its own role when it states one, else its tag's, an input's by its type.
    const TAG_ROLES = new Map(Object.entries({ a: "link", button: "button", select: "combobox", textarea: "textbox" }));
    const INPUT_ROLES = new Map(Object.entries({ submit: "button", button: "button", reset: "button", checkbox: "checkbox", radio: "radio" }));
    for (const role of ["file", "password"]) {
        INPUT_ROLES.set(role, role);
    }
    const roleOf = (el: Element): string => {
        const explicit = el.getAttribute("role");
        const tag = el.tagName.toLowerCase();
        if (explicit !== null && explicit !== "") {
            return explicit;
        }
        if (tag === "input") {
            return INPUT_ROLES.get((el.getAttribute("type") ?? "text").toLowerCase()) ?? "textbox";
        }
        return /^h[1-6]$/.test(tag) ? "heading" : (TAG_ROLES.get(tag) ?? ((el as HTMLElement).isContentEditable ? "textbox" : "element"));
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

    // Pictures, videos, sounds and drawings a person sees as content, so save_media has a ref to aim at: undefined for
    // anything else, null for decoration (an empty alt, aria-hidden, role presentation, or drawn under 64 px either way).
    // The size is the file's own pixels once loaded, else as drawn; a sound has none, and is listed only with its player.
    const MEDIA_TAGS = new Set(["img", "video", "audio", "canvas"]);
    const decorative = (el: Element): boolean =>
        el.getAttribute("aria-hidden") === "true" || ["presentation", "none"].includes(el.getAttribute("role") ?? "") || (el.tagName === "IMG" && el.getAttribute("alt") === "");
    // An img's natural size, a video's frame, a canvas's bitmap; as drawn while none of those is known yet.
    const sizeOf = (el: Element, box: DOMRect): string => {
        const own = el as Partial<HTMLImageElement & HTMLVideoElement>;
        const [width, height] = [own.naturalWidth ?? own.videoWidth ?? own.width ?? 0, own.naturalHeight ?? own.videoHeight ?? own.height ?? 0];
        return width > 0 && height > 0 ? `${width}×${height}` : `${Math.round(box.width)}×${Math.round(box.height)}`;
    };
    const mediaOf = (el: Element): { readonly role: string; readonly size: string } | null | undefined => {
        const tag = el.tagName.toLowerCase();
        const box = el.getBoundingClientRect();
        if (!MEDIA_TAGS.has(tag)) {
            return undefined;
        }
        if (decorative(el) || (tag === "audio" && !el.hasAttribute("controls"))) {
            return null;
        }
        if (tag === "audio") {
            return { role: "audio", size: "" };
        }
        return box.width < 64 || box.height < 64 ? null : { role: tag, size: sizeOf(el, box) };
    };
    // A password's value is never reported, only that the field exists; a box says whether it is ticked.
    const valueOf = (el: Element, role: string): string | undefined => {
        const input = el as HTMLInputElement;
        if (role === "checkbox" || role === "radio") {
            return input.checked ? "checked" : "unchecked";
        }
        return role === "password" || role === "button" || typeof input.value !== "string" || input.value === "" ? undefined : input.value.slice(0, 120);
    };
    // Roles listed even with no name, since they are aimed at by ref; past the cap, media is still listed, this many more,
    // since a sidebar that fills the list (ChatGPT's chat history) would otherwise hide the picture the agent came for.
    const NAMELESS = new Set(["textbox", "password", "checkbox", "file"]);
    const MEDIA_BEYOND = 20;

    // Shadow roots are walked; iframes are not, since a cross-document ref couldn't be acted on from here.
    const selector =
        'a[href], button, input, textarea, select, summary, [role], [onclick], [contenteditable=""], [contenteditable="true"], h1, h2, h3, img, video, audio, canvas';
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
    let beyond = 0;
    for (const el of found) {
        const full = elements.length >= MAX;
        // Once full, only media is looked at at all, and only so many more.
        const media = full && (beyond >= MEDIA_BEYOND || !MEDIA_TAGS.has(el.tagName.toLowerCase())) ? null : visible(el) ? mediaOf(el) : null;
        const role = media?.role ?? roleOf(el);
        const name = media === null ? "" : nameOf(el);
        if (media === null || (name === "" && media === undefined && !NAMELESS.has(role))) {
            continue;
        }
        beyond += full ? 1 : 0;
        elements.push({ ref: `e${refs.length}`, role, name, value: valueOf(el, role), size: media?.size === "" ? undefined : media?.size });
        refs.push(el);
    }
    return {
        url: location.href,
        title: document.title,
        truncated: found.length > 0 && elements.length - beyond >= MAX,
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
export const selectRef = (ref: string, values: string[]): ActionResult => {
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

// A key for the page as a whole, sent to whatever has focus (inside a shadow root too), with the legacy keyCode and
// which beside key and code: plenty of pages and editors still read `keyCode === 13` for Enter. keypress only for a
// key that types something or is Enter, as a browser sends it.
export const pressKeyOnPage = (key: string): ActionResult => {
    const CODES = new Map([
        ["Enter", 13],
        ["Escape", 27],
        ["Tab", 9],
        ["Backspace", 8],
        ["Delete", 46],
        [" ", 32],
        ["ArrowLeft", 37],
        ["ArrowUp", 38],
        ["ArrowRight", 39],
        ["ArrowDown", 40],
        ["PageUp", 33],
        ["PageDown", 34],
        ["Home", 36],
        ["End", 35],
    ]);
    let focused: Element | null = document.activeElement;
    while (focused?.shadowRoot?.activeElement != null) {
        focused = focused.shadowRoot.activeElement;
    }
    const target = focused ?? document.body;
    const single = key.length === 1;
    // A letter's or digit's keyCode is its capital's char code; punctuation's depends on the layout, and its char code
    // is another key's keyCode ("." is 46, Delete; "(" is 40, ArrowDown), so it gets none rather than a wrong one.
    const keyCode = CODES.get(key) ?? (single && /[a-z\d]/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0);
    const code = key === " " ? "Space" : single && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : single && /\d/.test(key) ? `Digit${key}` : key;
    const init = { bubbles: true, cancelable: true, composed: true, key, code, keyCode, which: keyCode };
    const down = target.dispatchEvent(new KeyboardEvent("keydown", init));
    if (down && (single || key === "Enter")) {
        target.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: single ? key.charCodeAt(0) : 13 }));
    }
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true, message: `pressed ${key}` };
};

// Marks the document an action is about to run in, and says where it is. The mark lives on the isolated world's
// window, which dies with the document, so the same mark read back after the action means the same document (a
// single-page app's route change keeps it), and another one means the page was replaced. An existing mark is kept,
// so two looks at one document always agree.
export interface DocumentMark {
    readonly url: string;
    readonly mark: string;
}

export const markDocument = (mark: string): DocumentMark => {
    window.intenticDocumentMark ??= mark;
    return { url: location.href, mark: window.intenticDocumentMark };
};

export const scrollPage = (direction: string, amount: number): { ok: boolean; message: string } => {
    const step = Math.round(window.innerHeight * 0.8) * Math.max(1, amount);
    const by = direction === "up" ? { top: -step } : direction === "left" ? { left: -step } : direction === "right" ? { left: step } : { top: step };
    window.scrollBy({ ...by, behavior: "instant" as ScrollBehavior });
    return { ok: true, message: `scrolled ${direction}` };
};
