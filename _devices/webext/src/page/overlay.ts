// What the agent shows a person inside the tab: the action banner and the in-page Allow/No question. Injected via
// chrome.scripting.executeScript like everything in driver.ts, so the same rule holds: each helper is nested inside
// the function that uses it, since the function is serialized and re-parsed inside the page, where nothing else in
// this module exists.

// How both read in a page: the popup's own materials (static/popup.html, which states them from the app), light paper
// or Sanctum by the browser's scheme, and the lotus in ember. Handed to the injected functions as an argument, since
// they are serialized without this module. Adopted as a constructed sheet into each shadow root, which a page's
// style-src CSP does not govern the way it governs a <style> element. The page cannot load the extension's Public
// Sans without the extension exposing its files to every site, so the face falls back to the system's.
export interface OverlayLook {
    readonly css: string;
    readonly mark: readonly { readonly d: string; readonly transform?: string; readonly opacity?: string }[];
}

const SMALL_PETAL = "M16 9.5c2.1 3 3.2 5.7 3.2 8.1 0 2.2-1.1 4.1-3.2 5.6-2.1-1.5-3.2-3.4-3.2-5.6 0-2.4 1.1-5.1 3.2-8.1z";
const MIDDLE_PETAL = "M16 6.4c2.4 3.4 3.6 6.4 3.6 9.1 0 2.5-1.2 4.6-3.6 6.3-2.4-1.7-3.6-3.8-3.6-6.3 0-2.7 1.2-5.7 3.6-9.1z";

export const OVERLAY_LOOK: OverlayLook = {
    // The five petals of _site/site/scripts/lotus.mjs, as the extension's icons draw them (viewBox 7.2 2.6 17.6 20.2).
    mark: [
        { d: SMALL_PETAL, transform: "rotate(-74 16 22.6)", opacity: ".55" },
        { d: SMALL_PETAL, transform: "rotate(74 16 22.6)", opacity: ".55" },
        { d: MIDDLE_PETAL, transform: "rotate(-39 16 21.7)", opacity: ".78" },
        { d: MIDDLE_PETAL, transform: "rotate(39 16 21.7)", opacity: ".78" },
        { d: "M16 3.4c2.8 4 4.2 7.5 4.2 10.6 0 2.9-1.4 5.4-4.2 7.3-2.8-1.9-4.2-4.4-4.2-7.3 0-3.1 1.4-6.6 4.2-10.6z" },
    ],
    css: `
:host {
    all: initial;
    --tint: oklch(80% 0.11 55);
    --card: color-mix(in oklab, oklch(99% 0.002 65) 97%, var(--tint));
    --line: color-mix(in oklab, oklch(87% 0.009 65) 89%, var(--tint));
    --ink: color-mix(in oklab, oklch(23% 0.008 65) 92%, oklch(50% 0.135 48));
    --muted: color-mix(in oklab, oklch(48% 0.011 65) 88%, oklch(33% 0.085 45));
    --heading: var(--muted);
    --link: oklch(50% 0.135 48);
    --accent: oklch(58% 0.16 50);
    --ember: #e07b27;
    --shadow: 0 1px 2px rgb(61 40 22 / 0.1), 0 8px 24px -6px rgb(61 40 22 / 0.22);
    --radius-card: 12px;
    --radius-control: 8px;
    --w-normal: 400;
    --w-medium: 500;
    --w-strong: 600;
    --label-track: 0.05em;
}
@media (prefers-color-scheme: dark) {
    :host {
        --card: oklch(23% 0.008 65);
        --line: rgba(201, 160, 92, 0.26);
        --ink: #efe3cd;
        --muted: #b7a68d;
        --heading: #c9a05c;
        --link: #e5c489;
        --accent: oklch(70% 0.15 55);
        --shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.55), 0 12px 28px -12px rgba(0, 0, 0, 0.6);
        --radius-card: 8px;
        --radius-control: 5px;
        --w-normal: 300;
        --w-medium: 400;
        --w-strong: 500;
        --label-track: 0.15em;
    }
}
.panel {
    all: initial;
    box-sizing: border-box;
    position: fixed;
    z-index: 2147483647;
    right: 16px;
    bottom: 16px;
    display: block;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-card);
    background: var(--card);
    box-shadow: var(--shadow);
    color: var(--ink);
    font: var(--w-normal) 13px/1.45 "Public Sans", system-ui, "Segoe UI", -apple-system, Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    animation: rise 0.18s ease-out;
}
.banner {
    max-width: 340px;
    pointer-events: none;
}
.banner.leaving {
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.2s, transform 0.2s;
}
.ask {
    width: 320px;
    padding: 14px;
}
.eyebrow {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    font-size: 10.5px;
    font-weight: var(--w-strong);
    letter-spacing: var(--label-track);
    text-transform: uppercase;
    color: var(--heading);
}
.eyebrow svg {
    flex: none;
    width: 14px;
    height: 14px;
    fill: var(--ember);
}
.message {
    display: block;
    overflow-wrap: anywhere;
}
.ask .message {
    font-size: 13.5px;
    font-weight: var(--w-medium);
}
.actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    margin-top: 12px;
}
button {
    all: initial;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    color: var(--muted);
    font: var(--w-medium) 12.5px/1 "Public Sans", system-ui, "Segoe UI", -apple-system, Roboto, sans-serif;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s, color 0.15s;
}
button:hover {
    background-color: color-mix(in srgb, var(--ink) 7%, transparent);
    color: var(--ink);
}
button.primary {
    background-color: color-mix(in srgb, var(--accent) 10%, transparent);
    border-color: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--link);
}
button.primary:hover {
    background-color: color-mix(in srgb, var(--accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--accent) 38%, transparent);
}
button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}
@media (prefers-color-scheme: dark) {
    button.primary,
    button.primary:hover {
        border-color: rgba(44, 36, 24, 0.5);
        color: #1d160e;
        font-weight: var(--w-strong);
        text-shadow: 0 1px 0 rgba(255, 250, 238, 0.26);
        box-shadow: inset 0 1px 0 rgba(255, 250, 238, 0.2), 0 1px 0 rgba(0, 0, 0, 0.5), 0 2px 5px -2px rgba(0, 0, 0, 0.6);
    }
    button.primary {
        background-color: #b3a794;
    }
    button.primary:hover {
        background-color: #c1b5a1;
    }
}
@keyframes rise {
    from {
        opacity: 0;
        transform: translateY(6px);
    }
}
@media (prefers-reduced-motion: reduce) {
    .panel,
    .banner.leaving {
        animation: none;
        transition: none;
    }
}
`,
};

// Flashes a message in the corner of the tab so actions are visible, not silent: the mark and who is acting, then
// what it did. In a shadow root whose host is reset with `all: initial`, so the page's styles can't hide or restyle it.
export const flashBanner = (message: string, look: OverlayLook): void => {
    const ID = "intentic-agent-banner";
    // Applies the look to a shadow root: a constructed sheet where the browser has them, else a <style> element.
    const dress = (root: ShadowRoot): void => {
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(look.css);
            root.adoptedStyleSheets = [sheet];
        } catch {
            const style = document.createElement("style");
            style.textContent = look.css;
            root.append(style);
        }
    };
    const eyebrow = (label: string): HTMLElement => {
        const SVG = "http://www.w3.org/2000/svg";
        const row = document.createElement("span");
        row.className = "eyebrow";
        const svg = document.createElementNS(SVG, "svg");
        svg.setAttribute("viewBox", "7.2 2.6 17.6 20.2");
        svg.setAttribute("aria-hidden", "true");
        for (const petal of look.mark) {
            const path = document.createElementNS(SVG, "path");
            path.setAttribute("d", petal.d);
            if (petal.transform !== undefined) {
                path.setAttribute("transform", petal.transform);
            }
            if (petal.opacity !== undefined) {
                path.setAttribute("opacity", petal.opacity);
            }
            svg.append(path);
        }
        const text = document.createElement("span");
        text.textContent = label;
        row.append(svg, text);
        return row;
    };
    // Replaces rather than updates, so the timeouts below always own exactly one banner.
    document.getElementById(ID)?.remove();
    const host = document.createElement("div");
    host.id = ID;
    host.setAttribute("style", "all: initial");
    const root = host.attachShadow({ mode: "open" });
    dress(root);
    const panel = document.createElement("div");
    panel.className = "panel banner";
    panel.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = "message";
    text.textContent = message;
    panel.append(eyebrow("Intentic agent"), text);
    root.append(panel);
    document.documentElement.append(host);
    setTimeout(() => panel.classList.add("leaving"), 3800);
    setTimeout(() => host.remove(), 4000);
};

// Asks in the page itself, beside what it is about, rather than in the popup or window.confirm() (which blocks the
// page's event agent), and without becoming part of the page. A person's click on a panel in the page used to
// reach the page too, as a click outside whatever menu or popover the agent had opened, and the page closed it
// (PrimeVue's menus hide on any document click outside them), so the click they allowed had nothing left to land
// on. Every event aimed at the panel is stopped at the window, ahead of the page's own listeners on the document and
// below, and pressing a button does not move focus. The shadow root is closed and only a trusted click answers: a
// snapshot cannot list these buttons, and neither the agent's own click nor the page's script can say yes for the
// person. Resolves false on timeout: an unanswered question is a no. `id` marks the panel so the extension can take it
// down once the person answered from the popup instead (dismissConfirm); the page can take it down too, which only
// ever answers no.
export const askConfirm = async (question: string, timeoutMs: number, id: string, look: OverlayLook): Promise<boolean> => {
    // Everything a pointer, a finger or a key sends; listening on the window in the capture phase runs ahead of every
    // listener the page put on its document or elements (only one it put on the window earlier still sees these).
    const POINTER = ["pointerdown", "pointerup", "pointerover", "pointerout", "pointermove", "touchstart", "touchend"];
    const MOUSE = ["mousedown", "mouseup", "mouseover", "mouseout", "mousemove", "click", "dblclick", "auxclick", "contextmenu"];
    const EVENTS = [...POINTER, ...MOUSE, "focusin", "focusout", "keydown", "keyup", "keypress"];
    // The same look and eyebrow as flashBanner's, repeated because each function travels into the page alone.
    const dress = (root: ShadowRoot): void => {
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(look.css);
            root.adoptedStyleSheets = [sheet];
        } catch {
            const style = document.createElement("style");
            style.textContent = look.css;
            root.append(style);
        }
    };
    const eyebrow = (label: string): HTMLElement => {
        const SVG = "http://www.w3.org/2000/svg";
        const row = document.createElement("span");
        row.className = "eyebrow";
        const svg = document.createElementNS(SVG, "svg");
        svg.setAttribute("viewBox", "7.2 2.6 17.6 20.2");
        svg.setAttribute("aria-hidden", "true");
        for (const petal of look.mark) {
            const path = document.createElementNS(SVG, "path");
            path.setAttribute("d", petal.d);
            if (petal.transform !== undefined) {
                path.setAttribute("transform", petal.transform);
            }
            if (petal.opacity !== undefined) {
                path.setAttribute("opacity", petal.opacity);
            }
            svg.append(path);
        }
        const text = document.createElement("span");
        text.textContent = label;
        row.append(svg, text);
        return row;
    };
    return await new Promise<boolean>((resolve) => {
        const host = document.createElement("div");
        host.setAttribute("style", "all: initial");
        const root = host.attachShadow({ mode: "closed" });
        dress(root);
        const panel = document.createElement("div");
        panel.className = "panel ask";
        panel.setAttribute("role", "alertdialog");
        const text = document.createElement("span");
        text.className = "message";
        text.textContent = question;
        const row = document.createElement("div");
        row.className = "actions";
        const button = (label: string, primary: boolean): HTMLButtonElement => {
            const element = document.createElement("button");
            element.type = "button";
            element.textContent = label;
            if (primary) {
                element.className = "primary";
            }
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
        host.setAttribute("data-intentic-ask", id);
        host.addEventListener("intentic-dismiss", () => finish(false));
        row.append(no, yes);
        panel.append(eyebrow("Intentic agent asks"), text, row);
        root.append(panel);
        document.documentElement.append(host);
        const timer = setTimeout(() => finish(false), timeoutMs);
    });
};

// Takes down the question `id` once it was answered elsewhere (background/asking.ts): the person said yes or no in the
// popup, and a panel still asking on the page would be a second answer to a question already closed.
export const dismissConfirm = (id: string): boolean => {
    for (const host of document.querySelectorAll("[data-intentic-ask]")) {
        if (host.getAttribute("data-intentic-ask") === id) {
            host.dispatchEvent(new Event("intentic-dismiss"));
        }
    }
    return true;
};
