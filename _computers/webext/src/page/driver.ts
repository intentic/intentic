// oxlint-disable unicorn/consistent-function-scoping -- the rule is exactly wrong for this file: every helper
// here is nested INSIDE the function that uses it because these functions are serialized and re-parsed inside a
// page, where nothing else in this module exists. Hoisting one to the outer scope is how this file acquires a
// ReferenceError that only appears on somebody else's website. See the header below.
import type { PageElement } from "@intentic/browser/page";

/* WHAT RUNS INSIDE SOMEBODY'S PAGE.
 *
 * THE RULE FOR EVERY FUNCTION IN THIS FILE, and it is not a style preference: each one is handed to
 * `chrome.scripting.executeScript` as a `func`, which SERIALIZES it with `Function.prototype.toString` and
 * re-parses it in the tab. Nothing it references from this module exists over there. So every helper a function
 * needs is defined INSIDE it, every constant is inlined, and nothing here may be refactored into shared
 * top-level helpers however much it wants to be. A bundler that hoists a shared function would produce code
 * that type-checks, builds, and throws `ReferenceError` on somebody's bank page.
 *
 * They run in the ISOLATED world: the same DOM as the page, a different JavaScript heap. So the page cannot
 * read the ref table or tamper with the banner, and we cannot see the page's own variables — which is the right
 * side of that trade for both parties.
 *
 * THE REF TABLE lives on `window.intenticPageRefs` in that isolated world (an ordinary name, not a
 * `__private` one: nothing else can see this world, so there is nobody to collide with). It survives between calls on the same
 * document and dies with a navigation, which is exactly the lifetime a reference should have: a `[e4]` from
 * before a click that navigated is refused rather than pointing at whatever now sits in slot four.
 *
 * The walk is this package's own rather than the CDP driver's (@intentic/browser), because it can be: it has
 * real DOM types, it pierces shadow roots, and it can ask the page for its own accessible names. What it
 * ANSWERS is the shared vocabulary — same PageElement, same `[e…]` rendering — so an agent that learned to
 * drive one browser has nothing new to learn for the other. */

// The snapshot, as it comes back from the tab. Mirrors @intentic/browser's RawSnapshot, plus the one thing only
// a real browser can tell us: whether the document is still loading, which is the difference between "nothing
// on this page" and "not yet".
export interface DriverSnapshot {
    readonly url: string;
    readonly title: string;
    readonly truncated: boolean;
    readonly loading: boolean;
    readonly elements: PageElement[];
}

// What one element IS, for the moment before acting on it. `sensitive` is the extension's own judgement, made
// where the DOM is: this element, or the form around it, deals in passwords, money or deletion.
export interface RefDescription {
    readonly ok: boolean;
    readonly role: string;
    readonly name: string;
    readonly sensitive: boolean;
}

/* ---- the injected functions ---- */

// Walk the page (piercing shadow roots) and park the ref table. 150 elements, the CDP driver's ceiling, for the
// same reason: past that a model has lost the thread anyway, and silent truncation is worse than a note.
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
            // innerText, then textContent. Not interchangeable: innerText is what a person SEES (it respects
            // display:none and inserts the line breaks the layout implies) and textContent is every character
            // in the subtree, visible or not. The fallback exists because innerText needs a layout engine, so
            // it is undefined in a headless DOM — and a name derived from textContent is worse but not wrong.
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

    // Shadow roots are walked, iframes are not: a cross-document ref could not be acted on from here anyway,
    // and an agent told about elements it cannot click is worse off than one told the frame exists.
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
        // A nameless non-input is something a caller could never ask for by name, so it is noise.
        if (name === "" && role !== "textbox" && role !== "password" && role !== "checkbox" && role !== "file") {
            continue;
        }
        const ref = `e${refs.length}`;
        refs.push(el);
        const value = (el as HTMLInputElement).value;
        const entry: { ref: string; role: string; name: string; value?: string } = { ref, role, name };
        // A password's contents are never reported. The field is listed (an agent has to know the form has one)
        // and what it holds is not this extension's to read back into a transcript.
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

// The page as a person reading it would get it. `innerText` rather than `textContent` because it respects
// display:none and line breaks, which is the difference between prose and a wall of concatenated nav labels.
export const readPageText = (): { url: string; title: string; text: string; truncated: boolean } => {
    const LIMIT = 40_000;
    const main = document.querySelector("main") ?? document.querySelector("article") ?? document.body;
    const raw = (main as HTMLElement | null)?.innerText ?? main?.textContent ?? "";
    const text = raw.replace(/\n{3,}/g, "\n\n").trim();
    return { url: location.href, title: document.title, text: text.slice(0, LIMIT), truncated: text.length > LIMIT };
};

// What a ref points at, and whether acting on it deserves a human. The "sensitive" test is deliberately broad
// and cheap: this decides whether to ASK, and the cost of asking too often is a click, while the cost of asking
// too rarely is somebody's money.
export const describeRef = (ref: string): RefDescription => {
    const refs = (window as unknown as { intenticPageRefs?: Element[] }).intenticPageRefs ?? [];
    const index = /^e(\d+)$/.exec(ref.trim());
    const el = index?.[1] === undefined ? undefined : refs[Number(index[1])];
    if (el === undefined || !el.isConnected) {
        return { ok: false, role: "", name: "", sensitive: false };
    }
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? el.getAttribute("value") ?? el.getAttribute("aria-label") ?? "")
        .trim()
        .slice(0, 120);
    /* Two independent tells, and the enclosure one is deliberately SCOPED rather than page-wide. Asking "does
     * this document contain a password field anywhere" would mark every button on any site with a sign-in box
     * in its header, which trains people to click through the prompt — the failure that makes a confirmation
     * worthless. The nearest enclosure that a designer would call one thing is the right unit: a form, a
     * dialog, a section. An element with no enclosure at all is judged on its own words. */
    const scope = el.closest("form, dialog, [role='dialog'], [role='form'], section, article, main");
    const credentials = 'input[type="password"], input[autocomplete*="cc-"], input[name*="card" i], input[autocomplete="one-time-code"]';
    const money = /\b(pay|buy|checkout|order|purchase|donate|transfer|withdraw|subscribe|send money)\b/i;
    const destructive = /\b(delete|remove|deactivate|close account|revoke|wipe|erase|uninstall|terminate)\b/i;
    const sensitive = (scope !== null && scope.querySelector(credentials) !== null) || money.test(text) || destructive.test(text);
    return { ok: true, role: el.tagName.toLowerCase(), name: text, sensitive };
};

// Click, the way a person's click behaves. The pointer/mouse sequence first (frameworks that listen on
// pointerdown never see a bare .click()), then the element's own click(), which is what actually follows a link
// or submits a form.
export const clickRef = (ref: string): { ok: boolean; message: string } => {
    const refs = (window as unknown as { intenticPageRefs?: Element[] }).intenticPageRefs ?? [];
    const index = /^e(\d+)$/.exec(ref.trim());
    const el = index?.[1] === undefined ? undefined : refs[Number(index[1])];
    if (el === undefined) {
        return { ok: false, message: `No element ${ref} on this page: take a fresh snapshot, the page has changed.` };
    }
    if (!el.isConnected) {
        return { ok: false, message: `${ref} is gone from the page: take a fresh snapshot.` };
    }
    el.scrollIntoView?.({ block: "center", inline: "center" });
    const target = el as HTMLElement;
    target.focus?.();
    const rect = el.getBoundingClientRect();
    const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
    };
    target.dispatchEvent(new PointerEvent("pointerdown", init));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new PointerEvent("pointerup", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.click();
    return { ok: true, message: `clicked` };
};

/* Type into a field. The native value setter is the load-bearing part: React (and every framework that tracks
 * an input's value on its own) overrides the `value` property on the element, so assigning `el.value = x`
 * updates what the browser shows and NOT what the framework believes, and the form submits empty. Calling the
 * prototype's setter writes the real one, and the `input` event that follows is what the framework listens for. */
export const fillRef = (ref: string, text: string, submit: boolean): { ok: boolean; message: string } => {
    const refs = (window as unknown as { intenticPageRefs?: Element[] }).intenticPageRefs ?? [];
    const index = /^e(\d+)$/.exec(ref.trim());
    const el = index?.[1] === undefined ? undefined : refs[Number(index[1])];
    if (el === undefined || !el.isConnected) {
        return { ok: false, message: `No element ${ref} on this page: take a fresh snapshot.` };
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
        // A form whose only submit path is the button (no default submission) still needs one: requestSubmit
        // runs validation and fires `submit`, where form.submit() would skip both.
        const form = el.closest("form");
        if (form !== null) {
            form.requestSubmit();
        }
    }
    return { ok: true, message: submit ? `typed and submitted` : `typed` };
};

// Choose in a <select>. By VALUE or by visible label, because a model reading a snapshot has the label and
// rarely the value, and refusing the thing it can actually see would be a puzzle rather than a control.
export const selectRef = (ref: string, values: string[]): { ok: boolean; message: string } => {
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

/* Wait for the page to say something (or stop saying it). Poll rather than MutationObserver: the condition is
 * "does this text appear anywhere", which an observer would re-derive on every mutation of a busy page anyway,
 * and a 200ms poll is invisible next to the network wait it is standing in for. The deadline is passed in
 * rather than hardcoded because the caller is the one holding a tool-call timeout. */
export const waitForText = async (needle: string, gone: boolean, deadlineMs: number): Promise<{ ok: boolean; message: string }> => {
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
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
};

/* THE THING THE PERSON SEES. Every action this extension takes flashes a line in the corner of the tab it
 * happened in, which is the whole difference between an agent using your browser and an agent using your
 * browser behind your back. It is a shadow root with `all: initial` for the widget's reason: a host page's
 * stylesheet must not be able to hide it, restyle it into invisibility, or inherit its font. */
export const flashBanner = (message: string): void => {
    const ID = "intentic-agent-banner";
    // Replaced rather than updated: an element is cheap, and rebuilding is what keeps the timeout below owning
    // exactly one banner instead of racing a previous action's disappearance.
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
            "background: #12121a",
            "color: #f4f4f8",
            "font: 13px/1.4 system-ui, sans-serif",
            "box-shadow: 0 6px 24px rgba(0,0,0,.28)",
            "border-left: 3px solid #7c5cff",
            "pointer-events: none",
        ].join(";"),
    );
    root.append(panel);
    setTimeout(() => host.remove(), 4000);
};

/* THE HUMAN IN THE LOOP, rendered in the page the action is about to happen on — not in the popup, and not as
 * a `window.confirm`. In the page, because that is where the person is looking and where the context is: the
 * question is about THIS button on THIS page. Not `confirm()`, because it blocks the page's own event loop and
 * a blocked page cannot finish loading the thing being confirmed.
 *
 * Resolves false on timeout. A question nobody answered is a no. */
export const askConfirm = async (question: string, timeoutMs: number): Promise<boolean> => {
    return await new Promise<boolean>((resolve) => {
        const host = document.createElement("div");
        host.attachShadow({ mode: "open" });
        document.documentElement.append(host);
        const root = host.shadowRoot as ShadowRoot;
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
                "background: #12121a",
                "color: #f4f4f8",
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
                    primary ? "background: #7c5cff; color: #fff" : "background: transparent; color: #aaa; border: 1px solid #333",
                ].join(";"),
            );
            return element;
        };
        const no = button("No", false);
        const yes = button("Allow", true);
        const finish = (answer: boolean): void => {
            clearTimeout(timer);
            host.remove();
            resolve(answer);
        };
        no.addEventListener("click", () => finish(false));
        yes.addEventListener("click", () => finish(true));
        row.append(no, yes);
        panel.append(text, row);
        root.append(panel);
        const timer = setTimeout(() => finish(false), timeoutMs);
    });
};
