import {
    detectPasswordForm,
    fillInputValue,
    hostFromLocation,
    isIncognitoContext,
    pageTitleForCapture,
} from "./password-heuristics.js";

type BgCaptureResult =
    | { ok: true; type: "capture"; outcome: "saved" | "updated"; name?: string; title?: string; at: number }
    | { ok: false; code: string; refusal: string };

type BgCandidates = { ok: true; type: "candidates"; items: { name: string; title: string; username?: string }[] } | { ok: false };

type BgFill =
    | { ok: true; type: "fill"; username?: string; password: string }
    | { ok: false; code: string; refusal: string };

const send = async <T>(message: Record<string, unknown>): Promise<T> => (await chrome.runtime.sendMessage(message)) as T;

const neverHosts = new Set<string>();
void send<string[]>({ channel: "passwords", type: "never-list" }).then((list) => {
    for (const h of list ?? []) {
        neverHosts.add(h);
    }
});

chrome.runtime.onMessage.addListener((message) => {
    if (typeof message === "object" && message !== null && (message as { channel?: string }).channel === "passwords") {
        const host = (message as { host?: string }).host;
        if (host !== undefined) {
            neverHosts.add(host);
        }
    }
});

let lastCapture: { host: string; username: string; at: number } | undefined;
let hadPasswordFilled = false;

const captureFailedFlag = (): boolean => {
    if (lastCapture === undefined || lastCapture.host !== hostFromLocation(location)) {
        return false;
    }
    if (Date.now() - lastCapture.at > 20_000) {
        return false;
    }
    const form = detectPasswordForm(document);
    if (form === undefined || form.kind !== "login") {
        return false;
    }
    const user = form.username?.value.trim() ?? "";
    return user === lastCapture.username;
};

const captureFromPage = async (): Promise<void> => {
    if (isIncognitoContext()) {
        return;
    }
    const host = hostFromLocation(location);
    if (neverHosts.has(host)) {
        return;
    }
    const form = detectPasswordForm(document);
    if (form === undefined) {
        return;
    }
    const password = form.capturePassword.value;
    if (password.trim() === "") {
        return;
    }
    const username = form.username?.value.trim();
    const title = pageTitleForCapture();
    const failed = captureFailedFlag();
    const response = await send<BgCaptureResult>({
        channel: "passwords",
        type: "capture",
        username: username === "" ? undefined : username,
        password,
        title,
        failed: failed ? true : undefined,
    });
    form.capturePassword.value = "";
    if (response.ok && (response.outcome === "saved" || response.outcome === "updated")) {
        lastCapture = { host, username: username ?? "", at: Date.now() };
        showToast(host, username, response);
    }
};

const showToast = (host: string, username: string | undefined, saved: BgCaptureResult & { ok: true }): void => {
    const root = document.createElement("div");
    root.setAttribute("role", "status");
    const shadow = root.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
:host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; font: 13px/1.4 system-ui, sans-serif; }
.panel {
  max-width: 320px; padding: 10px 12px; border-radius: 10px;
  background: light-dark(#fff, #1e1e1e); color: light-dark(#1a1a1a, #efe3cd);
  box-shadow: 0 4px 20px rgb(0 0 0 / 0.18);
}
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.btn { border: 0; background: transparent; color: light-dark(#005cc5, #e5c489); cursor: pointer; font: inherit; padding: 0; }
.btn:hover { text-decoration: underline; }
@media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
`;
    const panel = document.createElement("div");
    panel.className = "panel";
    const userBit = username !== undefined && username !== "" ? ` · ${username}` : "";
    panel.append(document.createTextNode(`Saved ${host}${userBit} `));
    const undo = document.createElement("button");
    undo.className = "btn";
    undo.type = "button";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => {
        if (saved.name !== undefined) {
            void send({ channel: "passwords", type: "undo", name: saved.name, at: saved.at });
        }
        root.remove();
    });
    const never = document.createElement("button");
    never.className = "btn";
    never.type = "button";
    never.textContent = "Never for this site";
    never.addEventListener("click", () => {
        neverHosts.add(host);
        void send({ channel: "passwords", type: "never" });
        root.remove();
    });
    const row = document.createElement("div");
    row.className = "row";
    row.append(undo, never);
    panel.append(row);
    shadow.append(style, panel);
    document.documentElement.append(root);
    setTimeout(() => root.remove(), 8000);
};

const isSubmitLike = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) {
        return false;
    }
    if (el.matches('button[type="submit"], input[type="submit"]')) {
        return true;
    }
    const role = el.getAttribute("role");
    if (role === "button" && /\b(sign in|log in|continue|submit|register|create account)\b/i.test(el.textContent ?? "")) {
        return true;
    }
    return false;
};

const nearPassword = (el: Element): boolean => {
    const form = detectPasswordForm(document);
    if (form === undefined) {
        return false;
    }
    const container = form.password.closest("form") ?? form.password.parentElement;
    return container !== null && (container === el || container.contains(el));
};

document.addEventListener(
    "submit",
    (event) => {
        const target = event.target;
        if (!(target instanceof HTMLFormElement)) {
            return;
        }
        if (target.querySelector('input[type="password"], input[autocomplete*="password"]') === null) {
            return;
        }
        void captureFromPage();
    },
    true,
);

document.addEventListener(
    "click",
    (event) => {
        const el = event.target;
        if (!(el instanceof Element)) {
            return;
        }
        const button = el.closest("button, input[type=submit]");
        if (button === null || !isSubmitLike(button) || !nearPassword(button)) {
            return;
        }
        void captureFromPage();
    },
    true,
);

document.addEventListener(
    "input",
    (event) => {
        const t = event.target;
        if (t instanceof HTMLInputElement && t.type === "password" && t.value.length > 0) {
            hadPasswordFilled = true;
        }
    },
    true,
);

window.addEventListener("pagehide", () => {
    if (hadPasswordFilled) {
        hadPasswordFilled = false;
        void captureFromPage();
    }
});

let fillRoot: HTMLElement | undefined;

const closeFillUi = (): void => {
    fillRoot?.remove();
    fillRoot = undefined;
};

const openFillUi = (anchor: HTMLInputElement, items: { name: string; title: string; username?: string }[]): void => {
    closeFillUi();
    if (items.length === 0) {
        return;
    }
    fillRoot = document.createElement("div");
    const shadow = fillRoot.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
:host { all: initial; position: absolute; z-index: 2147483645; font: 12px/1.3 system-ui, sans-serif; }
.menu {
  min-width: 200px; margin-top: 4px; padding: 4px 0; border-radius: 8px;
  background: light-dark(#fff, #1e1e1e); color: light-dark(#1a1a1a, #efe3cd);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
}
.item { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 8px 12px; cursor: pointer; font: inherit; }
.item:hover { background: light-dark(rgb(0 0 0 / 0.06), rgb(255 255 255 / 0.08)); }
`;
    const rect = anchor.getBoundingClientRect();
    fillRoot.style.left = `${rect.left + window.scrollX}px`;
    fillRoot.style.top = `${rect.bottom + window.scrollY}px`;
    const menu = document.createElement("div");
    menu.className = "menu";
    for (const item of items) {
        const user = item.username ?? item.title;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "item";
        btn.textContent = `Fill with Intentic · ${user}`;
        btn.addEventListener("click", () => {
            void pickFill(item.name, anchor);
        });
        menu.append(btn);
    }
    shadow.append(style, menu);
    document.documentElement.append(fillRoot);
};

const pickFill = async (name: string, anchor: HTMLInputElement): Promise<void> => {
    closeFillUi();
    const wait = document.createElement("div");
    wait.setAttribute("role", "status");
    wait.textContent = "Confirm on your computer…";
    wait.style.cssText =
        "position:fixed;bottom:16px;right:16px;z-index:2147483647;padding:10px 14px;border-radius:8px;background:#111;color:#fff;font:13px system-ui;";
    document.documentElement.append(wait);
    const response = await send<BgFill>({ channel: "passwords", type: "fill", name });
    wait.remove();
    if (!response.ok) {
        return;
    }
    const form = detectPasswordForm(document);
    if (form?.username !== undefined && response.username !== undefined) {
        fillInputValue(form.username, response.username);
    }
    const passField = form?.capturePassword ?? (anchor.type === "password" ? anchor : undefined);
    if (passField !== undefined) {
        fillInputValue(passField, response.password);
    } else if (anchor.type === "password") {
        fillInputValue(anchor, response.password);
    }
};

document.addEventListener(
    "focusin",
    (event) => {
        const t = event.target;
        if (!(t instanceof HTMLInputElement)) {
            return;
        }
        if (t.type !== "password" && t.type !== "email" && t.type !== "text") {
            return;
        }
        void (async () => {
            const response = await send<BgCandidates>({ channel: "passwords", type: "candidates" });
            if (!response.ok || response.items.length === 0) {
                return;
            }
            openFillUi(t, response.items);
        })();
    },
    true,
);

document.addEventListener("click", (e) => {
    if (fillRoot !== undefined && e.target instanceof Node && !fillRoot.contains(e.target)) {
        closeFillUi();
    }
});
