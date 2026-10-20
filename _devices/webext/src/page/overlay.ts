// What the agent shows a person inside the tab: the action banner and the in-page Allow/No question. Injected via
// chrome.scripting.executeScript like everything in driver.ts, so the same rule holds: each helper is nested inside
// the function that uses it, since the function is serialized and re-parsed inside the page, where nothing else in
// this module exists.

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
