import { computed, ref } from "vue";
import { useGoogleIdentity } from "../useGoogleIdentity";
import { routeAdvertised } from "./useDaemonRoutes";
import { useSandbox } from "./useSandbox";

/* The credential every browser→daemon call presents, as a module-level singleton: a DAEMON-MINTED session,
 * with the Google ID token demoted to the sign-in proof that establishes it.
 *
 * The raw Google ID token used to BE the steady-state credential, and its ~1h lifetime meant every renewal
 * went back through Google Identity Services — whose FedCM prompt shows browser UI even for a silent re-auth,
 * so "Sign in with Google" popped over a perfectly healthy workspace, roughly hourly, at whatever moment a
 * call crossed the expiry guard. Exchanging the first verified Google token for a weeks-long session the
 * daemon signs itself (system.session) makes Google UI a sign-in moment again: first visit in a browser,
 * account switch, a long-idle return — never mid-session. The daemon stays the only verifier and enforcer
 * (owner/membership are re-checked per request), and the platform still never sees either credential.
 *
 * Sessions are per sandbox (each daemon signs with its own secret), persisted in localStorage like the Google
 * credential, and renewed IN THE BACKGROUND with the session itself once within a week of expiry — an active
 * user re-proves to Google only after a month away. Old daemons keep working: one that positively advertises
 * no `system.session` route (or 404s the exchange) simply gets the raw Google ID token per call, exactly the
 * pre-session behavior. */

interface StoredSession {
    readonly token: string;
    // Epoch ms, echoed by the daemon at mint.
    readonly expiresAt: number;
    // Who the daemon verified — the identity the gates name when access is denied.
    readonly email: string;
}

const SESSION_KEY_PREFIX = `intentic.session.`;
const storageKey = (sandboxId: string): string => `${SESSION_KEY_PREFIX}${sandboxId}`;

// Never serve a token about to die mid-flight (the same guard the Google layer uses on its own tokens).
const EXPIRY_MARGIN_MS = 60_000;
// Renew — with the session itself, no Google involved — once this close to expiry, so an ACTIVE user's
// session slides forever and only a return from a long absence re-proves identity.
const RENEW_UNDER_MS = 7 * 24 * 60 * 60 * 1000;

const { getIdToken, signedInEmail } = useGoogleIdentity();
const { active, activeSandboxId, daemonUrl } = useSandbox();

// In-memory mirror of the persisted sessions (hydrated lazily per sandbox), so presentedEmail is reactive to
// mints and invalidations without re-reading storage.
const sessions = ref<Record<string, StoredSession>>({});
// Sandboxes whose daemon 404'd the exchange without advertising any route surface (a build predating both) —
// stops re-probing on every call. Cleared per sandbox the moment a hello positively advertises the route.
const unsupported = new Set<string>();
// One in-flight establish per sandbox, so concurrent calls share a single Google mint + exchange.
const inflight = new Map<string, Promise<string | undefined>>();
const renewing = new Set<string>();

const readStored = (sandboxId: string): StoredSession | undefined => {
    const raw = localStorage.getItem(storageKey(sandboxId)) ?? undefined;
    if (raw === undefined) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as StoredSession;
        return typeof parsed.token === `string` && typeof parsed.expiresAt === `number` && typeof parsed.email === `string` ? parsed : undefined;
    } catch {
        return undefined;
    }
};

const write = (sandboxId: string, session: StoredSession): void => {
    sessions.value = { ...sessions.value, [sandboxId]: session };
    try {
        localStorage.setItem(storageKey(sandboxId), JSON.stringify(session));
    } catch {
        // Storage may be unavailable (private mode); the in-memory session still serves this tab.
    }
};

// Exchange a verified bearer (Google ID token, or a still-valid session when renewing) for a fresh session.
// A raw fetch on purpose: sandboxRpc's own headers hook calls back into this module, so routing the exchange
// through it would recurse. `unsupported` is a 404 — the daemon predates the route.
const exchange = async (bearer: string): Promise<StoredSession | `unsupported` | undefined> => {
    const base = daemonUrl.value;
    if (base === undefined || base === ``) {
        return undefined;
    }
    const connectToken = active.value?.token;
    try {
        const response = await fetch(`${base}/system/session`, {
            method: `POST`,
            headers: { authorization: `Bearer ${bearer}`, ...(connectToken !== undefined ? { "x-intentic-connect": connectToken } : {}) },
        });
        if (response.status === 404) {
            return `unsupported`;
        }
        if (!response.ok) {
            return undefined;
        }
        const body = (await response.json()) as { token?: unknown; expiresAt?: unknown; email?: unknown };
        return typeof body.token === `string` && typeof body.expiresAt === `number` && typeof body.email === `string`
            ? { token: body.token, expiresAt: body.expiresAt, email: body.email }
            : undefined;
    } catch {
        return undefined;
    }
};

// The sign-in moment: mint a Google proof (silent for a returning Google session; One Tap / the rendered
// gate otherwise) and exchange it. Any exchange failure falls back to the raw ID token — the pre-session
// behavior, still valid against every daemon.
const establish = (sandboxId: string): Promise<string | undefined> => {
    const pending = (async (): Promise<string | undefined> => {
        const idToken = await getIdToken();
        if (idToken === undefined) {
            return undefined;
        }
        const minted = await exchange(idToken);
        if (minted === `unsupported`) {
            unsupported.add(sandboxId);
            return idToken;
        }
        if (minted === undefined) {
            return idToken;
        }
        write(sandboxId, minted);
        return minted.token;
    })().finally(() => inflight.delete(sandboxId));
    inflight.set(sandboxId, pending);
    return pending;
};

const renew = async (sandboxId: string, sessionToken: string): Promise<void> => {
    if (renewing.has(sandboxId)) {
        return;
    }
    renewing.add(sandboxId);
    try {
        const minted = await exchange(sessionToken);
        if (minted !== `unsupported` && minted !== undefined) {
            write(sandboxId, minted);
        }
        // A failed renewal changes nothing: the current session keeps working until expiry, and a daemon that
        // rotated its secret answers 401 on the next real call — which invalidates and re-establishes.
    } finally {
        renewing.delete(sandboxId);
    }
};

// The bearer for the active sandbox: a valid session (renewed in the background when due), or the freshly
// established one, or — for pre-session daemons and failed exchanges — the raw Google ID token. Undefined
// only when the user dismisses the sign-in gate.
const getSessionToken = async (): Promise<string | undefined> => {
    const sandboxId = activeSandboxId.value;
    if (sandboxId === undefined) {
        return getIdToken();
    }
    const stored = sessions.value[sandboxId] ?? readStored(sandboxId);
    if (stored !== undefined && Date.now() < stored.expiresAt - EXPIRY_MARGIN_MS) {
        if (sessions.value[sandboxId] === undefined) {
            sessions.value = { ...sessions.value, [sandboxId]: stored };
        }
        if (Date.now() >= stored.expiresAt - RENEW_UNDER_MS) {
            void renew(sandboxId, stored.token);
        }
        return stored.token;
    }
    const advertises = routeAdvertised(`system.session`);
    if (advertises === false) {
        return getIdToken();
    }
    if (advertises === true) {
        unsupported.delete(sandboxId);
    }
    if (unsupported.has(sandboxId)) {
        return getIdToken();
    }
    return inflight.get(sandboxId) ?? establish(sandboxId);
};

// Drop the ACTIVE sandbox's session: the daemon rejected it (401 — secret rotated, expiry raced) or the user
// is switching Google accounts. The next call re-establishes from a fresh Google proof.
const invalidateSession = (): void => {
    const sandboxId = activeSandboxId.value;
    if (sandboxId === undefined) {
        return;
    }
    const rest = { ...sessions.value };
    delete rest[sandboxId];
    sessions.value = rest;
    localStorage.removeItem(storageKey(sandboxId));
};

// Platform sign-out / account deletion: forget EVERY sandbox's session, alongside useAuth's clearCredential.
const clearSessions = (): void => {
    sessions.value = {};
    // Backwards so removal doesn't shift the indexes still to visit.
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key !== null && key.startsWith(SESSION_KEY_PREFIX)) {
            localStorage.removeItem(key);
        }
    }
};

// The identity this browser presents to the ACTIVE daemon — the session's email when one exists, else the
// Google credential's. The gates name it: the pre-bind mismatch bar, the "no access" screen.
const presentedEmail = computed<string | undefined>(() => {
    const sandboxId = activeSandboxId.value;
    const stored = sandboxId === undefined ? undefined : (sessions.value[sandboxId] ?? readStored(sandboxId));
    return stored !== undefined && Date.now() < stored.expiresAt ? stored.email : signedInEmail.value;
});

export function useSandboxSession() {
    return { presentedEmail, getSessionToken, invalidateSession, clearSessions };
}
