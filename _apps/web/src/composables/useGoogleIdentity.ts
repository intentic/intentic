import { ref } from "vue";
import { environment } from "../environments/environment";

// The slim slice of Google Identity Services (accounts.google.com/gsi/client) we use to mint an ID token in
// the browser. The token is a Google-signed JWT (audience = our web client id) — the sandbox daemon verifies
// it against Google's JWKS, so the platform never holds or forges this credential.
interface GoogleIdConfig {
    readonly client_id: string;
    readonly callback: (response: { readonly credential: string }) => void;
    // Silent re-auth: a returning user with one approved Google session gets a credential without interaction.
    readonly auto_select?: boolean;
}
// The FedCM-era prompt moment surface — display/not-displayed moments no longer fire; skip and dismissal are
// all a listener can observe (dismissal reason `credential_returned` means success, not a dismissal to act on).
interface PromptMoment {
    isSkippedMoment(): boolean;
    isDismissedMoment(): boolean;
    getDismissedReason(): string;
}
interface GsiButtonConfig {
    readonly type?: "standard" | "icon";
    readonly theme?: "outline" | "filled_blue" | "filled_black";
    readonly size?: "large" | "medium" | "small";
    readonly text?: "signin_with" | "signup_with" | "continue_with" | "signin";
    readonly shape?: "rectangular" | "pill" | "circle" | "square";
    readonly logo_alignment?: "left" | "center";
}
interface GoogleAccountsId {
    initialize(config: GoogleIdConfig): void;
    renderButton(parent: HTMLElement, options: GsiButtonConfig): void;
    prompt(momentListener?: (moment: PromptMoment) => void): void;
    disableAutoSelect?(): void;
    cancel?(): void;
}
declare global {
    interface Window {
        google?: { accounts?: { id?: GoogleAccountsId } };
    }
}

// Read a JWT's `exp` (epoch ms); falls back to a conservative 30-minute window if it can't be parsed.
const idTokenExpiry = (jwt: string): number => {
    try {
        const payload = jwt.split(`.`)[1] ?? ``;
        const decoded = JSON.parse(atob(payload.replace(/-/g, `+`).replace(/_/g, `/`))) as { exp?: number };
        return typeof decoded.exp === `number` ? decoded.exp * 1000 : Date.now() + 30 * 60_000;
    } catch {
        return Date.now() + 30 * 60_000;
    }
};

// Read a JWT's `email` claim, or undefined when absent/unparsable.
const idTokenEmail = (jwt: string): string | undefined => {
    try {
        const payload = jwt.split(`.`)[1] ?? ``;
        const decoded = JSON.parse(atob(payload.replace(/-/g, `+`).replace(/_/g, `/`))) as { email?: unknown };
        return typeof decoded.email === `string` ? decoded.email : undefined;
    } catch {
        return undefined;
    }
};

// Persisted in localStorage so the credential survives tab close and reopen (like intentic.activeSandboxId).
// The exposure is bounded: it's a ~1h Google-signed JWT whose expiry the daemon re-verifies, so a stale entry
// is just dead weight. Keyed by client id so a client-id change can't surface a stale token.
const storageKey = (clientId: string): string => `intentic.gid.${clientId}`;

/* Mints + caches a Google ID token for the configured web client, as a module-level singleton. The persisted
 * token is the steady-state fast-path: a valid one means no prompt at all (across refreshes and tab closes).
 * When none is valid, minting tries FedCM One Tap / auto re-authentication first — a returning user renews
 * silently — and only when that is skipped, dismissed, or blocked does `needsSignIn` raise the gate: a real
 * rendered "Sign in with Google" button, the surface for first-ever sign-ins and fallback. Both surfaces feed
 * the same credential callback. The sandbox daemon is the verifier; this never touches the platform.
 *
 * `warmIdToken` is that same first step with the fallback deliberately cut off — a prefetch for a screen that
 * would LIKE the credential but has no standing to demand it. Raising a full-screen gate is an answer to the
 * user asking for something; a prefetch is nobody asking, so it takes a silent renewal if Google offers one
 * and otherwise leaves the sign-in to whichever call actually needs it. */

// True when a token is needed — the workspace shell shows the sign-in gate (a rendered Google button) in
// response, and flips back once the credential arrives.
const needsSignIn = ref(false);
// The email inside the current credential — who the sandbox daemon sees. Set whenever a token materializes
// (mint or restore), cleared with it; the "no access" gate names it so the user knows WHICH account was denied.
const signedInEmail = ref<string | undefined>();

let token: string | undefined;
let expiresAt = 0;
let initialized = false;
// The single in-flight mint, so concurrent sandbox calls share one prompt/gate instead of racing for it.
let inflight: Promise<string | undefined> | undefined;
// Resolves the in-flight mint — called by the credential callback (rendered button) and by cancelSignIn (with
// undefined when the user dismisses the gate).
let settle: ((token: string | undefined) => void) | undefined;

// Hydrate the cached token from localStorage (after a refresh, a reopened tab, or a renewal in another tab).
// Returns undefined and clears the slot if the stored token is missing or already past its near-expiry guard,
// so callers mint anew.
const restore = (): string | undefined => {
    const key = storageKey(environment.auth.googleClientId);
    const stored = localStorage.getItem(key) ?? undefined;
    if (stored === undefined) {
        return undefined;
    }
    expiresAt = idTokenExpiry(stored);
    if (Date.now() >= expiresAt - 60_000) {
        localStorage.removeItem(key);
        return undefined;
    }
    signedInEmail.value = idTokenEmail(stored);
    return stored;
};

// The gsi/client script loads async (see index.html); poll briefly for it.
const waitForGis = async (): Promise<GoogleAccountsId> => {
    for (let attempt = 0; attempt < 50; attempt++) {
        const id = window.google?.accounts?.id;
        if (id !== undefined) {
            return id;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Google Identity Services failed to load`);
};

const ensureInitialized = async (): Promise<void> => {
    const id = await waitForGis();
    if (!initialized) {
        id.initialize({
            client_id: environment.auth.googleClientId,
            auto_select: true,
            callback: (response) => {
                token = response.credential;
                expiresAt = idTokenExpiry(response.credential);
                signedInEmail.value = idTokenEmail(response.credential);
                try {
                    localStorage.setItem(storageKey(environment.auth.googleClientId), response.credential);
                } catch {
                    // Storage may be unavailable (private mode); the in-memory token still serves this session.
                }
                needsSignIn.value = false;
                settle?.(response.credential);
            },
        });
        initialized = true;
    }
};

// If the silent attempt reports nothing by then (FedCM removed the "not displayed" moment; some browsers
// block the FedCM UI without any moment firing), raise the button gate. Benign if it fires mid-One-Tap —
// both surfaces feed the same credential callback.
const SILENT_GUARD_MS = 5000;

// First attempt of a mint: FedCM One Tap / auto re-authentication (auto_select). Raise the rendered-button
// gate when the prompt is skipped (cooldown / no session), dismissed without a credential, or silent past the
// guard. Returns the guard timer so mint() clears it once the credential (or a cancel) settles.
const trySilent = (): ReturnType<typeof setTimeout> => {
    const raiseGate = (): void => {
        if (settle !== undefined) {
            needsSignIn.value = true;
        }
    };
    const guard = setTimeout(raiseGate, SILENT_GUARD_MS);
    window.google?.accounts?.id?.prompt((moment) => {
        if (moment.isSkippedMoment() || (moment.isDismissedMoment() && moment.getDismissedReason() !== `credential_returned`)) {
            clearTimeout(guard);
            raiseGate();
        }
    });
    return guard;
};

// One mint: init GIS (wires the shared credential callback + the gate's rendered button), try the silent
// prompt, fall back to the gate, and wait for the credential — from either surface — via `settle`.
const mint = async (): Promise<string | undefined> => {
    try {
        await ensureInitialized();
    } catch {
        inflight = undefined;
        return undefined;
    }
    const minted = new Promise<string | undefined>((resolve) => {
        settle = resolve;
    });
    const guard = trySilent();
    const result = await minted;
    clearTimeout(guard);
    settle = undefined;
    inflight = undefined;
    needsSignIn.value = false;
    return result;
};

// The cached credential while it is still valid past the near-expiry guard, re-reading storage first when the
// in-memory copy is missing or near expiry — another tab may have renewed it. Undefined means a mint is due.
const cached = (): string | undefined => {
    if (token === undefined || Date.now() >= expiresAt - 60_000) {
        token = restore();
    }
    return token !== undefined && Date.now() < expiresAt - 60_000 ? token : undefined;
};

// A valid (not near-expiry) Google ID token, or undefined if GIS is unavailable or the user dismisses the
// sign-in gate. Never hangs on a suppressed prompt — the guard surfaces the gate and waits for a real click.
const getIdToken = async (): Promise<string | undefined> => {
    const valid = cached();
    if (valid !== undefined) {
        return valid;
    }
    inflight ??= mint();
    return inflight;
};

// Prefetch the credential: fire the silent prompt and let the shared callback cache whatever comes back. No
// `settle`, no guard timer and nothing to await — a returning Google session renews in the background, and a
// browser that would need UI for it is simply left alone. That absence is the point: with no caller waiting
// there is nothing for a gate to unblock, so the gate would only be interrupting the screen.
// A mint already in flight has a real caller behind it and will populate the same cache — leave it to it.
const warmIdToken = async (): Promise<void> => {
    if (cached() !== undefined || inflight !== undefined) {
        return;
    }
    try {
        await ensureInitialized();
    } catch {
        // GIS never loaded. A prefetch has nobody to report that to; the next real mint surfaces it.
        return;
    }
    window.google?.accounts?.id?.prompt();
};

// Platform sign-out must also forget the browser→sandbox Google credential. This keeps the sandbox URL binding
// intact while making the next signed-in platform session pass through the sandbox Google gate again.
const clearCredential = (): void => {
    localStorage.removeItem(storageKey(environment.auth.googleClientId));
    token = undefined;
    expiresAt = 0;
    signedInEmail.value = undefined;
    needsSignIn.value = false;
    settle?.(undefined);
    settle = undefined;
    inflight = undefined;
    // Kill a pending silent prompt (a late credential must not repopulate the cache) and stop auto_select from
    // silently re-signing the account the user just signed out of — the next mint shows a chooser or the gate.
    window.google?.accounts?.id?.cancel?.();
    window.google?.accounts?.id?.disableAutoSelect?.();
};

// Render the real Google button into the gate's container; a click fires the shared callback above, which
// caches the credential and resolves the waiting getIdToken(). `dark` picks the filled-black theme so the
// button matches the app's dark surfaces instead of showing as a white card.
const renderButton = (parent: HTMLElement, dark: boolean): void => {
    window.google?.accounts?.id?.renderButton(parent, {
        type: `standard`,
        theme: dark ? `filled_black` : `outline`,
        size: `large`,
        text: `continue_with`,
        shape: `pill`,
        logo_alignment: `center`,
    });
};

// User dismissed the gate without signing in: let the awaiting call resolve undefined (the caller surfaces
// "sign in to reach your sandbox"), so nothing is trapped behind a modal.
const cancelSignIn = (): void => {
    needsSignIn.value = false;
    settle?.(undefined);
};

export function useGoogleIdentity() {
    return { needsSignIn, signedInEmail, getIdToken, warmIdToken, clearCredential, renderButton, cancelSignIn };
}
