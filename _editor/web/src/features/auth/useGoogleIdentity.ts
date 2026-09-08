import { pollUntil } from "@intentic/base/async";
import { ref } from "vue";
import { desktopVersion } from "../../app/environments/desktop";
import { environment } from "../../app/environments/environment";
import { removeStoredValue, storedValue, storeValue } from "../../lib/browserStorage";
import { idTokenClaims } from "./googleToken";

// Slim slice of Google Identity Services used to mint an ID token in the browser: a Google-signed JWT (audience =
// the web client id) the sandbox daemon verifies against Google's JWKS. The platform never holds or forges it.
interface GoogleIdConfig {
    readonly client_id: string;
    readonly callback: (response: { readonly credential: string }) => void;
    // Silent re-auth: a returning user with one approved Google session gets a credential without interaction.
    readonly auto_select?: boolean;
}
// FedCM-era prompt surface: display/not-displayed moments no longer fire. Skip and dismissal are all a listener
// sees; dismissal reason `credential_returned` means success, not something to act on.
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
    /** Rendered width in px; Google accepts 200-400 and shortens its own label to fit. */
    readonly width?: number;
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

// Persisted in localStorage so the credential survives tab close/reopen; a stale entry is harmless since expiry is
// re-verified. Keyed by client id, so a client-id change can't surface a stale token.
const storageKey = (clientId: string): string => `intentic.gid.${clientId}`;

// Mints and caches a Google ID token for the configured web client, module-level singleton. A valid persisted
// token is the fast path; otherwise FedCM One Tap tries silently first, and only when skipped, dismissed, or
// blocked does `needsSignIn` raise a real button, the surface for first-time sign-ins and fallback. `warmIdToken`
// only hydrates the persisted fast path; `prompt()` shows UI and is reserved for a caller actually waiting.

// True when a token is needed; the workspace shell shows the sign-in gate and flips back once a credential arrives.
const needsSignIn = ref(false);
// Email in the current credential; set when a token materializes, cleared with it, so a denial names the account.
const signedInEmail = ref<string | undefined>();

let token: string | undefined;
let expiresAt = 0;
let initialized = false;
// The single in-flight mint, so concurrent callers share one prompt/gate instead of racing for it.
let inflight: Promise<string | undefined> | undefined;
// Resolves the in-flight mint; called by the credential callback or cancelSignIn (undefined on dismissal).
let settle: ((token: string | undefined) => void) | undefined;
// True only while a real mint is waiting, so a callback queued before sign-out can't repopulate the cache after.
let acceptingCredential = false;

const acceptCredential = (credential: string): boolean => {
    const claims = idTokenClaims(credential);
    if (claims === undefined || Date.now() >= claims.expiresAt - 60_000) {
        return false;
    }
    token = credential;
    expiresAt = claims.expiresAt;
    signedInEmail.value = claims.email;
    storeValue(storageKey(environment.auth.googleClientId), credential);
    needsSignIn.value = false;
    return true;
};

// Hydrates the cached token from localStorage (after a refresh, reopened tab, or another tab's renewal). Returns
// undefined and clears the slot if missing or past its near-expiry guard, so callers mint anew.
const restore = (): string | undefined => {
    const key = storageKey(environment.auth.googleClientId);
    const stored = storedValue(key);
    if (stored === undefined) {
        return undefined;
    }
    const claims = idTokenClaims(stored);
    if (claims === undefined || Date.now() >= claims.expiresAt - 60_000) {
        removeStoredValue(key);
        return undefined;
    }
    expiresAt = claims.expiresAt;
    signedInEmail.value = claims.email;
    return stored;
};

// Waits on the script's own load event rather than polling `window.google`, since a poll only notices it between
// ticks and desktop-auth charges that dead time to the user. The short poll after covers a tag absent in test DOM,
// or a load event firing before the global is assigned.
const GIS_SRC = `https://accounts.google.com/gsi/client`;

const waitForGis = async (): Promise<GoogleAccountsId> => {
    const ready = (): GoogleAccountsId | undefined => window.google?.accounts?.id;
    const script = document.querySelector<HTMLScriptElement>(`script[src^="${GIS_SRC}"]`);
    if (script !== null && ready() === undefined) {
        await new Promise<void>((resolve) => {
            script.addEventListener(`load`, () => resolve(), { once: true });
            script.addEventListener(`error`, () => resolve(), { once: true });
            setTimeout(resolve, 5000);
        });
    }
    await pollUntil(() => ready() !== undefined, { intervalMs: 50, timeoutMs: 1_000 });
    const id = ready();
    if (id === undefined) {
        throw new Error(`Google Identity Services failed to load`);
    }
    return id;
};

const ensureInitialized = async (): Promise<void> => {
    const id = await waitForGis();
    if (!initialized) {
        id.initialize({
            client_id: environment.auth.googleClientId,
            auto_select: true,
            callback: (response) => {
                if (!acceptingCredential) {
                    return;
                }
                const accepted = acceptCredential(response.credential);
                settle?.(accepted ? response.credential : undefined);
            },
        });
        initialized = true;
    }
};

// Loaded on fire rather than imported: analytics reads the page's environment at import time, and this module also
// runs where there is no page (session tests, workers).
const reportGate = (properties: Record<string, unknown>): void => {
    void import("../../app/analytics").then(({ track }) => track(`sandbox_signin_gate`, properties)).catch(() => undefined);
};

// Raises the gate if the silent attempt reports nothing by then; some browsers block FedCM UI silently.
const SILENT_GUARD_MS = 5000;

// What a mint does when the silent attempt fails:
// gate raise the shared full-screen Google button (a caller waiting on a sandbox call)
// button nothing; the caller already shows its own Google button (desktop-auth)
// silent give up quietly; the caller was only warming a credential ahead of need
// Module state, not a closure: one mint is shared by every asker in flight, and a person arriving mid-attempt
// upgrades it.
type MintMode = "gate" | "button" | "silent";
let mintMode: MintMode = "gate";

// First attempt: FedCM One Tap / auto re-auth. On skip, dismissal, or guard timeout, act per mode and record the
// reason. Returns the guard timer so `mint()` clears it once settled.
const trySilent = (): ReturnType<typeof setTimeout> | undefined => {
    const silentFailed = (reason: "skipped" | "dismissed" | "guard-timeout" | "webview"): void => {
        if (settle === undefined) {
            return;
        }
        reportGate({ reason, mode: mintMode });
        if (mintMode === `gate`) {
            needsSignIn.value = true;
        } else if (mintMode === `silent`) {
            settle(undefined);
        }
    };
    // The desktop webview has no silent attempt to make; Google won't talk to it, so the guard's wait is certain
    // failure. Raise the gate now, offering the hand-off to the real browser.
    if (desktopVersion() !== undefined) {
        silentFailed(`webview`);
        return undefined;
    }
    // No guard when the caller shows its own button: the timer only raises the shared overlay, which would make an
    // already-visible button wait five seconds for a second one.
    const guard = mintMode === `button` ? undefined : setTimeout(() => silentFailed(`guard-timeout`), SILENT_GUARD_MS);
    window.google?.accounts?.id?.prompt((moment) => {
        if (moment.isSkippedMoment()) {
            clearTimeout(guard);
            silentFailed(`skipped`);
        } else if (moment.isDismissedMoment() && moment.getDismissedReason() !== `credential_returned`) {
            clearTimeout(guard);
            silentFailed(`dismissed`);
        }
    });
    return guard;
};

// One mint: initializes GIS (wires the credential callback and whichever button renders), tries the silent prompt,
// acts per mode on failure, then waits for the credential via `settle`.
const mint = async (mode: MintMode): Promise<string | undefined> => {
    mintMode = mode;
    try {
        await ensureInitialized();
    } catch {
        inflight = undefined;
        return undefined;
    }
    const minted = new Promise<string | undefined>((resolve) => {
        settle = resolve;
    });
    acceptingCredential = true;
    const guard = trySilent();
    const result = await minted;
    clearTimeout(guard);
    settle = undefined;
    acceptingCredential = false;
    inflight = undefined;
    needsSignIn.value = false;
    return result;
};

// Margin against serving a token that's about to die; a caller handing it off needs more (see `usableFor`).
const NEAR_EXPIRY_MS = 60_000;

// The cached credential while still valid past the caller's margin; re-reads storage first if the in-memory copy
// is missing or near expiry, since another tab may have renewed it. Undefined means a mint is due.
const cached = (margin = NEAR_EXPIRY_MS): string | undefined => {
    if (token === undefined || Date.now() >= expiresAt - margin) {
        token = restore();
    }
    return token !== undefined && Date.now() < expiresAt - margin ? token : undefined;
};

// A valid Google ID token, or undefined if GIS is unavailable or the sign-in gate is dismissed; never hangs on a
// suppressed prompt.
// interactive: false — no standing to interrupt: takes an already-held credential or returns nothing, but still
// shares a mint already in flight.
// gate: false — caller already shows its own Google button; the silent attempt races it instead of raising the
// shared overlay.
// silent: true — only warming a credential; resolves undefined instead of raising the gate on failure (a
// concurrent caller with more standing upgrades it).
// usableFor — minimum life the token needs left; the desktop hand-off ships it to another process that may not
// spend it for a while, so a soon-to-expire token counts as absent.
const getIdToken = async (options?: {
    readonly gate?: boolean;
    readonly usableFor?: number;
    readonly interactive?: boolean;
    readonly silent?: boolean;
}): Promise<string | undefined> => {
    const valid = cached(options?.usableFor ?? NEAR_EXPIRY_MS);
    if (valid !== undefined) {
        return valid;
    }
    if (options?.interactive === false) {
        return inflight;
    }
    const mode: MintMode = options?.silent === true ? `silent` : options?.gate === false ? `button` : `gate`;
    if (inflight !== undefined) {
        // A person joining a quiet mint upgrades it to the gate; a warmer joining a person's mint never downgrades it.
        if (mintMode === `silent` && mode !== `silent`) {
            mintMode = mode;
        }
        return inflight;
    }
    inflight = mint(mode);
    return inflight;
};

// Prefetch means storage hydration only: GIS `prompt()` shows One Tap/FedCM UI (even with auto_select, not always
// silently), and a screen the user is merely reading has no standing to trigger it.
const warmIdToken = async (): Promise<void> => {
    cached();
};

// Platform sign-out must also forget the browser-to-sandbox Google credential, so the next signed-in session
// passes through the sandbox's Google gate again; the sandbox URL binding stays intact.
const clearCredential = (): void => {
    removeStoredValue(storageKey(environment.auth.googleClientId));
    token = undefined;
    expiresAt = 0;
    signedInEmail.value = undefined;
    needsSignIn.value = false;
    settle?.(undefined);
    settle = undefined;
    inflight = undefined;
    acceptingCredential = false;
    // Cancels a pending silent prompt (a late credential must not repopulate the cache) and stops auto_select from
    // re-signing the account just signed out of.
    window.google?.accounts?.id?.cancel?.();
    window.google?.accounts?.id?.disableAutoSelect?.();
};

// Renders Google's button; a click resolves the waiting getIdToken() via the shared callback. Desktop webview
// always returns false, decided here rather than per-caller (offer `signInThroughBrowser` instead); false means
// the caller must offer another way in.
const renderButton = async (parent: HTMLElement, dark: boolean): Promise<boolean> => {
    if (desktopVersion() !== undefined) {
        return false;
    }
    try {
        await ensureInitialized();
    } catch {
        return false; // GIS never loaded; the caller decides what to show instead.
    }
    const id = window.google?.accounts?.id;
    if (id === undefined) {
        return false;
    }
    // Sized to the given box, not its own label: 'Continue with Google' is 245px in English but 305px in Polish, and
    // Google shortens its text to fit rather than overflow. Below 200px Google refuses the width param, so the
    // natural (unmeasured) size is kept as fallback.
    const measured = Math.floor(parent.clientWidth);
    id.renderButton(parent, {
        type: `standard`,
        theme: dark ? `filled_black` : `outline`,
        size: `large`,
        text: `continue_with`,
        shape: `pill`,
        logo_alignment: `center`,
        ...(measured >= 200 ? { width: Math.min(measured, 400) } : {}),
    });
    return true;
};

// Lets the awaiting getIdToken resolve undefined so nothing stays trapped behind the gate: either the user
// dismissed it, or the reason for the mint went away underneath it (a sandbox switch mid-establishment, see
// sandboxSession's watch).
const cancelSignIn = (): void => {
    needsSignIn.value = false;
    settle?.(undefined);
};

// For a credential minted elsewhere (the desktop app's webview, which can't run GIS, hands off through the real
// browser instead). Cached the same way a local mint is, indistinguishable to the daemon; a malformed or expired
// JWT is refused rather than cached, since a cached dead token is a gate that never resolves.
const adoptIdToken = (credential: string): boolean => {
    return acceptCredential(credential);
};

export function useGoogleIdentity() {
    return { needsSignIn, signedInEmail, getIdToken, warmIdToken, adoptIdToken, clearCredential, renderButton, cancelSignIn };
}
