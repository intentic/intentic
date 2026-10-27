import { DEMO_USER } from "./account";

// GOOGLE, AS THE DEMO'S WORLD HAS IT. The editor mints a Google ID token in the browser (client/auth/useGoogleIdentity.ts)
// through Google Identity Services on `window.google.accounts.id`, and only loads Google's script when that global is
// absent. The demo has no Google client to load it for (GIS refuses with "Missing required parameter: client_id" and the
// mint never settles, which left every press that needs a sign-in spinning for good), so this stands in for it on the
// global the app already reads: a demo visitor is signed in to Google as the demo account, a prompt answers at once,
// and a rendered button signs in when pressed. The token is a JWT the editor can read (email, expiry) and the demo's
// daemon and platform accept; nothing else ever sees it.

interface Credential {
    readonly credential: string;
}
interface Moment {
    isSkippedMoment(): boolean;
    isDismissedMoment(): boolean;
    getDismissedReason(): string;
}

// What the editor's slice of GIS reads (useGoogleIdentity.ts `GoogleAccountsId`); a field it never reads is left out.
interface DemoAccountsId {
    initialize(config: { readonly client_id: string; readonly callback: (response: Credential) => void }): void;
    renderButton(parent: HTMLElement, options: { readonly width?: number; readonly text?: string }): void;
    prompt(listener?: (moment: Moment) => void): void;
    disableAutoSelect(): void;
    cancel(): void;
}

// An hour, as Google's own tokens last.
const TOKEN_LIFE_S = 3_600;

const base64Url = (value: Readonly<Record<string, string | number | boolean>>): string => btoa(JSON.stringify(value)).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);

/** A Google-shaped ID token for the demo account: readable claims, a signature nobody checks. */
export const demoIdToken = (clientId: string): string => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: `https://accounts.google.com`,
        aud: clientId === `` ? `demo` : clientId,
        sub: DEMO_USER.id,
        email: DEMO_USER.email,
        email_verified: true,
        name: DEMO_USER.name,
        iat: now,
        exp: now + TOKEN_LIFE_S,
    };
    return `${base64Url({ alg: `RS256`, typ: `JWT`, kid: `demo` })}.${base64Url(claims)}.ZGVtby1zaWduYXR1cmU`;
};

// The moment GIS reports once its prompt handed a credential over: dismissed, for the reason the editor reads as success.
const RETURNED: Moment = { isSkippedMoment: () => false, isDismissedMoment: () => true, getDismissedReason: () => `credential_returned` };

// A plain button in Google's place, styled by the page around it, that signs in as the demo account when pressed.
const drawButton = (parent: HTMLElement, width: number | undefined, press: () => void): void => {
    const button = document.createElement(`button`);
    button.type = `button`;
    button.textContent = `Continue as ${DEMO_USER.email}`;
    button.style.cssText = `width:${width ?? 240}px;height:40px;border-radius:20px;border:1px solid #dadce0;background:#fff;color:#1f1f1f;font:500 14px/1 system-ui,sans-serif;cursor:pointer`;
    button.addEventListener(`click`, press);
    parent.replaceChildren(button);
};

/** Puts the demo's Google on the global the editor reads, before the editor loads. */
export const installIdentity = (): void => {
    let clientId = ``;
    let callback: ((response: Credential) => void) | undefined;
    const answer = (): void => callback?.({ credential: demoIdToken(clientId) });
    const id: DemoAccountsId = {
        initialize: (config) => {
            clientId = config.client_id;
            callback = config.callback;
        },
        renderButton: (parent, options) => drawButton(parent, options.width, answer),
        // Answered on the next task, as Google's own prompt never answers inside the call that asked.
        prompt: (listener) => {
            setTimeout(() => {
                answer();
                listener?.(RETURNED);
            });
        },
        disableAutoSelect: () => undefined,
        cancel: () => undefined,
    };
    // The visitor arrives signed in to Google, as a returning user does: a credential already cached where the editor
    // keeps it (useGoogleIdentity.ts `storageKey`), so a sandbox the visitor makes is reached without a prompt.
    const webClient = window.env.auth.googleClientId;
    localStorage.setItem(`intentic.gid.${webClient}`, demoIdToken(webClient));
    // Defined rather than assigned: `google` is the GIS global the editor types for itself (useGoogleIdentity.ts), and
    // a page that loaded no Google script has none yet.
    Object.defineProperty(window, `google`, { value: { accounts: { id } }, configurable: true, writable: true });
};
