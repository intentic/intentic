import { Latest, pollUntil, whenAborted } from "@intentic/base/async";
import { t } from "@intentic/ui/i18n";
import { ref } from "vue";
import { reloadOnHotUpdate } from "../../app/hotReload";
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
// allow(module-state): the Google credential, which the platform and every daemon accept alike
const needsSignIn = ref(false);
// Email in the current credential; set when a token materializes, cleared with it, so a denial names the account.
// allow(module-state): the Google credential, which the platform and every daemon accept alike
const signedInEmail = ref<string | undefined>();
// How many credentials Google answered with that this module refused (unreadable, or inside the near-expiry guard by
// this machine's clock). A count rather than a flag so a page can say so again on the second refusal.
// allow(module-state): the Google credential, which the platform and every daemon accept alike
const refusedCredentials = ref(0);

let token: string | undefined;
let expiresAt = 0;
// The auto-select posture GIS is initialized in, undefined before the first initialize. A switch re-initializes
// with it off: Google auto-selects the account already approved for this client, which on a switch is the very
// account being rejected.
let initializedAutoSelect: boolean | undefined;
// True from the moment a caller asks to change accounts until that mint settles: no silent attempt is made, so
// Google's chooser is the only road to a credential.
let picking = false;
// The single in-flight mint, so concurrent callers share one prompt/gate instead of racing for it.
let inflight: Promise<string | undefined> | undefined;
// The mint in flight. Its signal aborts when it ends however it ends (settled, retired, replaced), which ends its silent
// attempt with it: a guard timer or a moment GIS reports late cannot act on the mint after it, and a mint retired while
// GIS was still loading prompts nobody once it loads.
const mints = new Latest();
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

// The script tag, asked for on first need: index.html only fetches it up front on the pages that exist to sign in.
const gisScript = (): HTMLScriptElement => {
    const present = document.querySelector<HTMLScriptElement>(`script[src^="${GIS_SRC}"]`);
    if (present !== null) {
        return present;
    }
    const script = document.createElement(`script`);
    script.src = GIS_SRC;
    script.async = true;
    document.head.append(script);
    return script;
};

const waitForGis = async (): Promise<GoogleAccountsId> => {
    const ready = (): GoogleAccountsId | undefined => window.google?.accounts?.id;
    const script = ready() === undefined ? gisScript() : null;
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
        throw new Error(t(`auth.useGoogleIdentity.loadFailed`));
    }
    return id;
};

// Re-initializes whenever the wanted auto-select posture differs from the one GIS holds, so the button rendered by
// one surface and the mint awaiting it always agree about whether Google may answer without asking.
const ensureInitialized = async (): Promise<void> => {
    const id = await waitForGis();
    const autoSelect = !picking;
    if (initializedAutoSelect !== autoSelect) {
        id.initialize({
            client_id: environment.auth.googleClientId,
            auto_select: autoSelect,
            callback: (response) => {
                if (!acceptingCredential) {
                    return;
                }
                if (acceptCredential(response.credential)) {
                    settle?.(response.credential);
                    return;
                }
                refusedCredentials.value += 1;
                reportGate({ reason: `refused`, mode: mintMode });
                // A caller showing its own button keeps waiting on it: ended here, the page read the undefined as a
                // dismissal and every later press of that same button was dropped, no mint being left to take it. The
                // shared overlay closes and is raised afresh by the next ask, so its mint can end.
                if (mintMode !== `button`) {
                    settle?.(undefined);
                }
            },
        });
        initializedAutoSelect = autoSelect;
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
// reason; all of it speaks for the mint behind `signal` alone, and ends when it does.
const trySilent = (signal: AbortSignal): void => {
    // What the mode does once the silent attempt is over (the MintMode table above).
    const giveUp = (): void => {
        if (mintMode === `gate`) {
            needsSignIn.value = true;
        } else if (mintMode === `silent`) {
            settle?.(undefined);
        }
    };
    const silentFailed = (reason: "skipped" | "dismissed" | "guard-timeout" | "webview"): void => {
        if (signal.aborted) {
            return;
        }
        reportGate({ reason, mode: mintMode });
        giveUp();
    };
    // The desktop webview has no silent attempt to make; Google won't talk to it, so the guard's wait is certain
    // failure. Raise the gate now, offering the hand-off to the real browser.
    if (desktopVersion() !== undefined) {
        silentFailed(`webview`);
        return;
    }
    // No guard when the caller shows its own button: the timer only raises the shared overlay, which would make an
    // already-visible button wait five seconds for a second one.
    const guard = mintMode === `button` ? undefined : setTimeout(() => silentFailed(`guard-timeout`), SILENT_GUARD_MS);
    whenAborted(signal, () => clearTimeout(guard));
    window.google?.accounts?.id?.prompt((moment) => {
        if (signal.aborted) {
            return;
        }
        if (moment.isSkippedMoment()) {
            clearTimeout(guard);
            silentFailed(`skipped`);
        } else if (moment.isDismissedMoment() && moment.getDismissedReason() === `flow_restarted`) {
            // The reader pressed Google's own button, whose flow replaces this one: a sign-in under way, which the gate's
            // funnel counted as an abandonment on every such press, so it is not reported. The mode still gives up as on
            // any silent attempt that ended: the button's flow may be closed unanswered, and a warm-up left waiting on
            // it would hold every later mint that joins it. A caller showing its own button waits for its answer.
            clearTimeout(guard);
            giveUp();
        } else if (moment.isDismissedMoment() && moment.getDismissedReason() !== `credential_returned`) {
            clearTimeout(guard);
            silentFailed(`dismissed`);
        }
    });
};

// What a switch does instead of the silent attempt: Google re-selects the account already approved for this client,
// which on a switch is the one being rejected, so auto-select goes off, any prompt in flight is cancelled, and the
// shared overlay comes up to carry the button whose click reaches Google's chooser.
const openChooser = (mode: MintMode): void => {
    window.google?.accounts?.id?.disableAutoSelect?.();
    window.google?.accounts?.id?.cancel?.();
    if (mode === `gate`) {
        needsSignIn.value = true;
    }
};

// One mint: initializes GIS (wires the credential callback and whichever button renders), tries the silent prompt,
// acts per mode on failure, then waits for the credential via `settle`. A picking mint skips the silent prompt
// entirely: its whole point is that Google asks.
const mint = async (mode: MintMode): Promise<string | undefined> => {
    mintMode = mode;
    const signal = mints.next();
    try {
        await ensureInitialized();
    } catch {
        if (mints.isCurrent(signal)) {
            mints.done(signal);
            picking = false;
            inflight = undefined;
        }
        return undefined;
    }
    // Retired while GIS loaded (a sign-out, a switch, a dismissal): it asks Google nothing, and its callers get nothing.
    if (signal.aborted) {
        return undefined;
    }
    const minted = new Promise<string | undefined>((resolve) => {
        settle = resolve;
    });
    acceptingCredential = true;
    if (picking) {
        openChooser(mode);
    }
    if (!picking) {
        trySilent(signal);
    }
    const result = await minted;
    // A retired mint owns none of this state any more: retireMint reset it, or the mint that replaced it holds it.
    if (!mints.isCurrent(signal)) {
        return result;
    }
    mints.abort();
    settle = undefined;
    acceptingCredential = false;
    picking = false;
    inflight = undefined;
    needsSignIn.value = false;
    return result;
};

// Ends the mint in flight with nothing and leaves the module ready for the next one; a dismissal, a sign-out and a
// switch all need exactly this much. A mint still loading GIS ends too, once it loads, and its own epilogue is skipped.
const retireMint = (): void => {
    mints.abort();
    settle?.(undefined);
    settle = undefined;
    inflight = undefined;
    acceptingCredential = false;
    picking = false;
};

// Which failure road a mint takes, read off the asker's standing (see the MintMode table above).
const modeFor = (options?: { readonly gate?: boolean; readonly silent?: boolean }): MintMode =>
    options?.silent === true ? `silent` : options?.gate === false ? `button` : `gate`;

// The mint in flight, upgraded when this asker has more standing than the one that started it; undefined when there
// is none to join.
const joinMint = (mode: MintMode): Promise<string | undefined> | undefined => {
    if (inflight !== undefined && mintMode === `silent` && mode !== `silent`) {
        // A person joining a quiet mint upgrades it to the gate; a warmer joining a person's mint never downgrades it.
        mintMode = mode;
    }
    return inflight;
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
// pick: true — the reader is changing accounts: the cached credential is the one being rejected, a mint in flight
// would hand that same one back, and Google is asked with auto-select off so its chooser comes up.
const getIdToken = async (options?: {
    readonly gate?: boolean;
    readonly usableFor?: number;
    readonly interactive?: boolean;
    readonly silent?: boolean;
    readonly pick?: boolean;
}): Promise<string | undefined> => {
    const pick = options?.pick === true;
    const valid = pick ? undefined : cached(options?.usableFor ?? NEAR_EXPIRY_MS);
    if (valid !== undefined) {
        return valid;
    }
    if (options?.interactive === false) {
        return inflight;
    }
    const mode = modeFor(options);
    if (pick) {
        // Retired rather than joined: whatever that mint returns is about the account being left behind. Its caller
        // is settled with nothing, exactly as a dismissal settles one.
        retireMint();
        picking = true;
    } else {
        const joined = joinMint(mode);
        if (joined !== undefined) {
            return joined;
        }
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
    retireMint();
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
    retireMint();
};

// For a credential minted elsewhere (the desktop app's webview, which can't run GIS, hands off through the real
// browser instead). Cached the same way a local mint is, indistinguishable to the daemon; a malformed or expired
// JWT is refused rather than cached, since a cached dead token is a gate that never resolves.
const adoptIdToken = (credential: string): boolean => {
    return acceptCredential(credential);
};

export function useGoogleIdentity() {
    return { needsSignIn, signedInEmail, refusedCredentials, getIdToken, warmIdToken, adoptIdToken, clearCredential, renderButton, cancelSignIn };
}

// One Google credential per window: a hot-reloaded rerun would forget the minted token and raise the sign-in gate
// for a session that still holds one (hotReload.ts).
reloadOnHotUpdate(import.meta);
