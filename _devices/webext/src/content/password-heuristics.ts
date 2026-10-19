// Field and form judgements for the passwords content script. Kept free of Chrome APIs so the same rules are tested
// against small HTML fixtures with jsdom.

export type PasswordFormKind = "login" | "signup" | "change";

export interface PasswordFieldSet {
    readonly kind: PasswordFormKind;
    readonly password: HTMLInputElement;
    readonly username?: HTMLInputElement;
    /** For change-password flows, the value to save is the new password field. */
    readonly capturePassword: HTMLInputElement;
}

const USERNAME_AUTOCOMPLETE = new Set(["username", "email", "account"]);

const USERNAME_NAME = /\b(user(name)?|login|email|account|identifier)\b/i;

const CARD_AUTOCOMPLETE = /^cc-/;
const CARD_NAME = /\b(card|cvc|cvv|ccv|pan|iban)\b/i;

export const isIncognitoContext = (): boolean =>
    typeof chrome !== "undefined" && "extension" in chrome && (chrome as { extension?: { inIncognitoContext?: boolean } }).extension?.inIncognitoContext === true;

export const isPasswordInput = (el: HTMLInputElement): boolean => {
    const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    if (ac === "one-time-code") {
        return false;
    }
    if (ac === "current-password" || ac === "new-password") {
        return true;
    }
    return el.type === "password";
};

export const shouldSkipField = (el: HTMLInputElement): boolean => {
    const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    if (ac === "one-time-code") {
        return true;
    }
    if (CARD_AUTOCOMPLETE.test(ac)) {
        return true;
    }
    const name = `${el.name} ${el.id} ${labelText(el)}`.toLowerCase();
    if (CARD_NAME.test(name)) {
        return true;
    }
    if (!isPasswordInput(el)) {
        return false;
    }
    if (looksLikeOtp(el)) {
        return true;
    }
    return false;
};

const labelText = (el: HTMLInputElement): string => {
    const id = el.id;
    if (id !== "") {
        const safe = typeof CSS !== "undefined" && "escape" in CSS ? CSS.escape(id) : id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const label = el.ownerDocument.querySelector(`label[for="${safe}"]`);
        if (label?.textContent) {
            return label.textContent;
        }
    }
    const parentLabel = el.closest("label");
    return parentLabel?.textContent ?? "";
};

const looksLikeOtp = (el: HTMLInputElement): boolean => {
    if (el.type === "password") {
        return false;
    }
    const max = el.maxLength;
    if (max >= 4 && max <= 8 && el.type === "tel") {
        return true;
    }
    const val = el.value.trim();
    if (/^\d{4,8}$/.test(val) && el.type !== "password") {
        return true;
    }
    const hint = `${el.name} ${el.id} ${el.getAttribute("autocomplete") ?? ""} ${labelText(el)}`.toLowerCase();
    return /\botp\b|one[- ]time|verification code|2fa|mfa/.test(hint);
};

const isUsernameField = (el: HTMLInputElement): boolean => {
    if (el.type === "password" || el.type === "hidden" || el.disabled || el.readOnly) {
        return false;
    }
    const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    if (USERNAME_AUTOCOMPLETE.has(ac)) {
        return true;
    }
    if (el.type === "email") {
        return true;
    }
    const blob = `${el.name} ${el.id} ${labelText(el)}`;
    return USERNAME_NAME.test(blob);
};

const visiblePasswordFields = (root: Document | Element): HTMLInputElement[] => {
    const out: HTMLInputElement[] = [];
    for (const el of root.querySelectorAll("input")) {
        if (!(el instanceof HTMLInputElement)) {
            continue;
        }
        if (!isPasswordInput(el) || shouldSkipField(el)) {
            continue;
        }
        if (el.offsetParent === null && el.type !== "hidden") {
            // display:none or not laid out; jsdom tests stub layout so offsetParent may be null — still count in tests.
            if (typeof el.getBoundingClientRect === "function") {
                const box = el.getBoundingClientRect();
                if (box.width === 0 && box.height === 0) {
                    continue;
                }
            }
        }
        out.push(el);
    }
    return out;
};

export const classifyPasswordFields = (passwords: HTMLInputElement[]): PasswordFormKind => {
    const ac = (p: HTMLInputElement) => (p.getAttribute("autocomplete") ?? "").toLowerCase();
    const newFields = passwords.filter((p) => ac(p) === "new-password");
    const currentFields = passwords.filter((p) => ac(p) === "current-password");
    if (newFields.length > 0 && currentFields.length > 0) {
        return "change";
    }
    if (newFields.length >= 2) {
        return "signup";
    }
    if (passwords.length >= 3) {
        return "change";
    }
    if (passwords.length === 2) {
        return "signup";
    }
    return "login";
};

const pickCapturePassword = (passwords: HTMLInputElement[], kind: PasswordFormKind): HTMLInputElement => {
    if (kind === "change" || kind === "signup") {
        const byAc = passwords.find((p) => (p.getAttribute("autocomplete") ?? "").toLowerCase() === "new-password");
        if (byAc !== undefined) {
            return byAc;
        }
        // SAFETY: callers pass the form's password fields, never an empty list (a form without one is no capture).
        return passwords.at(-1) as HTMLInputElement;
    }
    // SAFETY: as above, the list holds at least one field.
    return passwords[0] as HTMLInputElement;
};

export const findUsernameNear = (password: HTMLInputElement, root: Document | Element): HTMLInputElement | undefined => {
    const candidates: HTMLInputElement[] = [];
    for (const el of root.querySelectorAll("input")) {
        if (el instanceof HTMLInputElement && isUsernameField(el)) {
            candidates.push(el);
        }
    }
    if (candidates.length === 0) {
        return undefined;
    }
    const form = password.form;
    const inForm = form === null ? candidates : candidates.filter((c) => c.form === form);
    const pool = inForm.length > 0 ? inForm : candidates;
    let best: HTMLInputElement | undefined;
    let bestDist = Infinity;
    for (const c of pool) {
        const pos = c.compareDocumentPosition(password);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
            const dist = documentPositionDistance(c, password);
            if (dist < bestDist) {
                bestDist = dist;
                best = c;
            }
        }
    }
    return best ?? pool[0];
};

const documentPositionDistance = (before: Element, after: Element): number => {
    let n = 0;
    let cur: Element | null = before;
    while (cur !== null && cur !== after) {
        cur = cur.nextElementSibling;
        n += 1;
        if (n > 500) {
            break;
        }
    }
    return n;
};

export const detectPasswordForm = (doc: Document = document): PasswordFieldSet | undefined => {
    const passwords = visiblePasswordFields(doc);
    if (passwords.length === 0) {
        return undefined;
    }
    const kind = classifyPasswordFields(passwords);
    const capturePassword = pickCapturePassword(passwords, kind);
    const username = findUsernameNear(capturePassword, doc);
    return username === undefined
        ? { kind, password: passwords[0]!, capturePassword }
        : { kind, password: passwords[0]!, username, capturePassword };
};

export const pageTitleForCapture = (doc: Document = document): string | undefined => {
    const og = doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim();
    if (og !== undefined && og !== "") {
        return og.slice(0, 200);
    }
    const title = doc.title.trim();
    return title === "" ? undefined : title.slice(0, 200);
};

export const hostFromLocation = (loc: Location): string => {
    return loc.hostname;
};

/** Fill like driver.fillRef: native setter plus input/change events, never submit. */
export const fillInputValue = (el: HTMLInputElement, text: string): void => {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter === undefined) {
        el.value = text;
    } else {
        setter.call(el, text);
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
};
