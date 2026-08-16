import { ref } from "vue";
import { environment } from "../environments/environment";
import { removeStoredValue, storedValue, storeValue } from "./browserStorage";
import { idTokenClaims } from "./googleToken";

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
 * `warmIdToken` only hydrates the persisted fast-path. Google `prompt()` can display One Tap/FedCM UI and is
 * reserved for a real caller waiting on access, never a screen the user is merely reading. */

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
// The shared GIS callback is installed once. It accepts credentials only while a real mint is waiting; a
// callback already queued when sign-out cancels GIS cannot repopulate the cache afterwards.
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

// Hydrate the cached token from localStorage (after a refresh, a reopened tab, or a renewal in another tab).
// Returns undefined and clears the slot if the stored token is missing or already past its near-expiry guard,
// so callers mint anew.
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

/* The gsi/client script loads async (see index.html). Wait on its OWN load event rather than polling for
 * `window.google`: a poll only notices the script between ticks, and on the desktop-auth page — where the
 * whole screen is one person waiting for Google to appear — that dead time is charged straight to them. The
 * short settle poll after the event is the belt-and-braces half (the tag can be absent in a test DOM, and a
 * load event is not a promise that the global is assigned in the same task). */
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
    for (let attempt = 0; attempt < 20; attempt++) {
        const id = ready();
        if (id !== undefined) {
            return id;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
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

// If the silent attempt reports nothing by then (FedCM removed the "not displayed" moment; some browsers
// block the FedCM UI without any moment firing), raise the button gate. Benign if it fires mid-One-Tap —
// both surfaces feed the same credential callback.
const SILENT_GUARD_MS = 5000;

// First attempt of a mint: FedCM One Tap / auto re-authentication (auto_select). Raise the rendered-button
// gate when the prompt is skipped (cooldown / no session), dismissed without a credential, or silent past the
// guard. Returns the guard timer so mint() clears it once the credential (or a cancel) settles.
const trySilent = (gate: boolean): ReturnType<typeof setTimeout> | undefined => {
    const raiseGate = (): void => {
        if (settle !== undefined && gate) {
            needsSignIn.value = true;
        }
    };
    // No guard when the caller shows its own button: the timer exists only to raise the shared overlay, and a
    // caller that is ALREADY showing a Google button would be made to wait five seconds for a second one.
    const guard = gate ? setTimeout(raiseGate, SILENT_GUARD_MS) : undefined;
    window.google?.accounts?.id?.prompt((moment) => {
        if (moment.isSkippedMoment() || (moment.isDismissedMoment() && moment.getDismissedReason() !== `credential_returned`)) {
            clearTimeout(guard);
            raiseGate();
        }
    });
    return guard;
};

// One mint: init GIS (wires the shared credential callback + whichever button is rendered), try the silent
// prompt, fall back to the gate when this mint owns one, and wait for the credential via `settle`.
const mint = async (gate: boolean): Promise<string | undefined> => {
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
    const guard = trySilent(gate);
    const result = await minted;
    clearTimeout(guard);
    settle = undefined;
    acceptingCredential = false;
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

/* A valid (not near-expiry) Google ID token, or undefined if GIS is unavailable or the user dismisses the
 * sign-in gate. Never hangs on a suppressed prompt — the guard surfaces the gate and waits for a real click.
 *
 * `gate: false` says the CALLER is already showing a Google button of its own. The shared overlay would be a
 * second button on top of the first, and the timer that raises it would be five seconds of nothing first — so
 * the silent attempt simply races the caller's button, and whichever produces a credential settles this call.
 * The consequence is that a suppressed prompt leaves this pending until that button is clicked, which is only
 * safe because its one caller — the desktop-auth page — is a whole window with no other caller in it. */
const getIdToken = async (options?: { readonly gate?: boolean }): Promise<string | undefined> => {
    const valid = cached();
    if (valid !== undefined) {
        return valid;
    }
    inflight ??= mint(options?.gate ?? true);
    return inflight;
};

// Prefetch means storage hydration only. GIS `prompt()` is a request to show One Tap/FedCM UI, even when
// auto_select sometimes makes it silent; a screen the user is merely reading has no standing to make it.
const warmIdToken = async (): Promise<void> => {
    cached();
};

// Platform sign-out must also forget the browser→sandbox Google credential. This keeps the sandbox URL binding
// intact while making the next signed-in platform session pass through the sandbox Google gate again.
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
    // Kill a pending silent prompt (a late credential must not repopulate the cache) and stop auto_select from
    // silently re-signing the account the user just signed out of — the next mint shows a chooser or the gate.
    window.google?.accounts?.id?.cancel?.();
    window.google?.accounts?.id?.disableAutoSelect?.();
};

// Render the real Google button into a container; a click fires the shared callback above, which caches the
// credential and resolves the waiting getIdToken(). `dark` picks the filled-black theme so the button matches
// the app's dark surfaces instead of showing as a white card. Awaits GIS itself, because the callers that
// show a button UP FRONT (rather than behind the gate) reach here before any mint has initialized it.
// Answers whether a button is actually standing there: a caller whose ONLY sign-in control this is (the login
// page) has to offer something else when Google's script never arrived, and silence would leave a blank panel.
const renderButton = async (parent: HTMLElement, dark: boolean): Promise<boolean> => {
    try {
        await ensureInitialized();
    } catch {
        return false; // GIS never loaded — the caller decides what to show instead.
    }
    const id = window.google?.accounts?.id;
    if (id === undefined) {
        return false;
    }
    id.renderButton(parent, {
        type: `standard`,
        theme: dark ? `filled_black` : `outline`,
        size: `large`,
        text: `continue_with`,
        shape: `pill`,
        logo_alignment: `center`,
    });
    return true;
};

// User dismissed the gate without signing in: let the awaiting call resolve undefined (the caller surfaces
// "sign in to reach your sandbox"), so nothing is trapped behind a modal.
const cancelSignIn = (): void => {
    needsSignIn.value = false;
    settle?.(undefined);
};

/* Take a credential that was minted somewhere else — the ONE case being the desktop app, whose webview cannot
 * run GIS at all (FedCM is absent in WebKitGTK and Google refuses OAuth from an embedded webview), so its
 * sign-in happens in the user's real browser and arrives here over the platform's handoff.
 *
 * It writes to the same cache the callback above writes to, deliberately: from this point the token is
 * indistinguishable from a locally-minted one — the daemon verifies it against Google's JWKS either way, and
 * spends it once for a daemon session that renews without Google. A malformed or already-expired JWT is
 * refused rather than cached, because a cached dead token is a sign-in gate that never resolves. */
const adoptIdToken = (credential: string): boolean => {
    return acceptCredential(credential);
};

export function useGoogleIdentity() {
    return { needsSignIn, signedInEmail, getIdToken, warmIdToken, adoptIdToken, clearCredential, renderButton, cancelSignIn };
}
