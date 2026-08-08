import { computed, ref } from "vue";
import type { SandboxSummary } from "@intentic-app/api-contract";
import { removeStoredValue, storedKeys, storedValue, storeValue } from "../browserStorage";
import { useGoogleIdentity } from "../useGoogleIdentity";
import { routeAdvertised } from "./useDaemonRoutes";
import { useSandbox } from "./useSandbox";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";

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

const { getIdToken, signedInEmail, clearCredential } = useGoogleIdentity();
const { activeSandboxId } = useSandbox();

// In-memory mirror of the persisted sessions (hydrated lazily per sandbox), so presentedEmail is reactive to
// mints and invalidations without re-reading storage.
const sessions = ref<Record<string, StoredSession>>({});
// Sandboxes whose daemon 404'd the exchange without advertising any route surface (a build predating both) —
// stops re-probing on every call. Cleared per sandbox the moment a hello positively advertises the route.
const unsupported = new Set<string>();
// One in-flight establish per sandbox, so concurrent calls share a single Google mint + exchange.
const inflight = new Map<string, Promise<string | undefined>>();
const renewing = new Set<string>();
// Invalidates every async establishment/renewal already past an await. A late response may complete on the
// wire, but it cannot write or return a credential after logout.
let authGeneration = 0;

type SessionMessage =
    | { readonly kind: `clear` }
    | { readonly kind: `invalidate`; readonly sandboxId: string }
    | { readonly kind: `write`; readonly sandboxId: string; readonly session: StoredSession };

const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.sandbox-auth`);

export class SandboxSessionError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const readStored = (sandboxId: string): StoredSession | undefined => {
    const raw = storedValue(storageKey(sandboxId));
    if (raw === undefined) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as StoredSession;
        return typeof parsed.token === `string` &&
            parsed.token !== `` &&
            Number.isFinite(parsed.expiresAt) &&
            typeof parsed.email === `string` &&
            parsed.email !== ``
            ? parsed
            : undefined;
    } catch {
        return undefined;
    }
};

const write = (sandboxId: string, session: StoredSession, broadcast = true): void => {
    sessions.value = { ...sessions.value, [sandboxId]: session };
    storeValue(storageKey(sandboxId), JSON.stringify(session));
    if (broadcast) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
        channel?.postMessage({ kind: `write`, sandboxId, session } satisfies SessionMessage);
    }
};

// Exchange a verified bearer (Google ID token, or a still-valid session when renewing) for a fresh session.
// A raw fetch on purpose: sandboxRpc's own headers hook calls back into this module, so routing the exchange
// through it would recurse. `unsupported` is a 404 — the daemon predates the route.
const exchange = async (target: SandboxTarget, bearer: string): Promise<StoredSession | `unsupported` | `unauthorized`> => {
    try {
        const response = await fetch(`${target.base}/system/session`, {
            method: `POST`,
            headers: {
                authorization: `Bearer ${bearer}`,
                ...(target.connectToken !== undefined ? { "x-intentic-connect": target.connectToken } : {}),
            },
            signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 404) {
            return `unsupported`;
        }
        if (response.status === 401) {
            return `unauthorized`;
        }
        if (!response.ok) {
            throw new SandboxSessionError(response.status, `The sandbox refused its session exchange (${response.status}).`);
        }
        const body = (await response.json()) as { token?: unknown; expiresAt?: unknown; email?: unknown };
        if (
            typeof body.token !== `string` ||
            body.token === `` ||
            typeof body.expiresAt !== `number` ||
            !Number.isFinite(body.expiresAt) ||
            typeof body.email !== `string`
        ) {
            throw new Error(`The sandbox returned an invalid session.`);
        }
        if (Date.now() >= body.expiresAt - EXPIRY_MARGIN_MS) {
            throw new Error(`The sandbox returned an expired session.`);
        }
        return { token: body.token, expiresAt: body.expiresAt, email: body.email };
    } catch (error) {
        if (error instanceof Error && error.name === `TimeoutError`) {
            throw new Error(`The sandbox did not finish signing in within 10 seconds.`, { cause: error });
        }
        throw error;
    }
};

// The sign-in moment: mint a Google proof (silent for a returning Google session; One Tap / the rendered
// gate otherwise) and exchange it. Only an explicit 404 proves an old daemon needs the raw-token fallback;
// network errors and malformed/non-2xx answers fail instead of silently changing credential modes.
const establish = (target: SandboxTarget & { readonly sandboxId: string }): Promise<string | undefined> => {
    const generation = authGeneration;
    const pending = (async (): Promise<string | undefined> => {
        let idToken = await getIdToken();
        if (idToken === undefined) {
            return undefined;
        }
        let minted = await exchange(target, idToken);
        if (minted === `unauthorized`) {
            // A definitive verifier rejection means the cached Google proof is dead or malformed. Forget it
            // and let this same user action drive the interactive recovery once, rather than looping on it.
            clearCredential();
            idToken = await getIdToken();
            if (idToken === undefined) {
                return undefined;
            }
            minted = await exchange(target, idToken);
        }
        if (authGeneration !== generation) {
            return undefined;
        }
        if (minted === `unsupported`) {
            unsupported.add(target.sandboxId);
            return idToken;
        }
        if (minted === `unauthorized`) {
            clearCredential();
            throw new Error(`The sandbox rejected your Google sign-in.`);
        }
        write(target.sandboxId, minted);
        return minted.token;
    })().finally(() => {
        if (inflight.get(target.sandboxId) === pending) {
            inflight.delete(target.sandboxId);
        }
    });
    inflight.set(target.sandboxId, pending);
    return pending;
};

const renew = async (target: SandboxTarget & { readonly sandboxId: string }, sessionToken: string): Promise<void> => {
    if (renewing.has(target.sandboxId)) {
        return;
    }
    const generation = authGeneration;
    renewing.add(target.sandboxId);
    try {
        const minted = await exchange(target, sessionToken);
        if (minted !== `unsupported` && minted !== `unauthorized` && generation === authGeneration) {
            write(target.sandboxId, minted);
        }
        // A failed renewal changes nothing: the current session keeps working until expiry, and a daemon that
        // rotated its secret answers 401 on the next real call — which invalidates and re-establishes.
    } finally {
        renewing.delete(target.sandboxId);
    }
};

// The bearer for the active sandbox: a valid session (renewed in the background when due), or the freshly
// established one, or — only for pre-session daemons — the raw Google ID token. Undefined
// only when the user dismisses the sign-in gate.
const getSessionToken = async (target = currentSandboxTarget()): Promise<string | undefined> => {
    if (target === undefined || target.sandboxId === undefined) {
        return getIdToken();
    }
    const sandboxId = target.sandboxId;
    const stored = sessions.value[sandboxId] ?? readStored(sandboxId);
    if (stored !== undefined && Date.now() < stored.expiresAt - EXPIRY_MARGIN_MS) {
        if (sessions.value[sandboxId] === undefined) {
            sessions.value = { ...sessions.value, [sandboxId]: stored };
        }
        if (Date.now() >= stored.expiresAt - RENEW_UNDER_MS) {
            void renew({ ...target, sandboxId }, stored.token).catch(() => undefined);
        }
        return stored.token;
    }
    const advertises = activeSandboxId.value === sandboxId ? routeAdvertised(`system.session`) : undefined;
    if (advertises === false) {
        return getIdToken();
    }
    if (advertises === true) {
        unsupported.delete(sandboxId);
    }
    if (unsupported.has(sandboxId)) {
        return getIdToken();
    }
    return inflight.get(sandboxId) ?? establish({ ...target, sandboxId });
};

// Drop the ACTIVE sandbox's session: the daemon rejected it (401 — secret rotated, expiry raced) or the user
// is switching Google accounts. The next call re-establishes from a fresh Google proof.
const invalidateSession = (sandboxId = activeSandboxId.value, broadcast = true): void => {
    if (sandboxId === undefined) {
        return;
    }
    authGeneration += 1;
    const rest = { ...sessions.value };
    delete rest[sandboxId];
    sessions.value = rest;
    removeStoredValue(storageKey(sandboxId));
    if (broadcast) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
        channel?.postMessage({ kind: `invalidate`, sandboxId } satisfies SessionMessage);
    }
};

// A 401 names the exact bearer the daemon rejected. A session rejection keeps the Google proof available for
// the one retry; a raw-Google rejection clears that proof so it cannot be replayed forever.
const rejectSessionToken = (target: SandboxTarget, rejected: string): void => {
    const sandboxId = target.sandboxId;
    const stored = sandboxId === undefined ? undefined : (sessions.value[sandboxId] ?? readStored(sandboxId));
    if (sandboxId !== undefined && stored?.token === rejected) {
        invalidateSession(sandboxId);
        return;
    }
    clearCredential();
};

// Platform sign-out / account deletion: forget EVERY sandbox's session, alongside useAuth's clearCredential.
const clearSessions = (broadcast = true): void => {
    authGeneration += 1;
    sessions.value = {};
    renewing.clear();
    for (const key of storedKeys(SESSION_KEY_PREFIX)) {
        removeStoredValue(key);
    }
    if (broadcast) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
        channel?.postMessage({ kind: `clear` } satisfies SessionMessage);
    }
};

if (channel !== undefined) {
    channel.addEventListener(`message`, (event: MessageEvent<SessionMessage>) => {
        if (event.data.kind === `clear`) {
            clearSessions(false);
        } else if (event.data.kind === `invalidate`) {
            invalidateSession(event.data.sandboxId, false);
        } else {
            write(event.data.sandboxId, event.data.session, false);
        }
    });
}

const removalRequest = async (sandbox: SandboxSummary, base: string, bearer: string): Promise<Response> =>
    fetch(`${base.replace(/\/$/, ``)}${sandbox.role === `owner` ? `/system/access/disable` : `/members/self`}`, {
        method: sandbox.role === `owner` ? `POST` : `DELETE`,
        headers: { authorization: `Bearer ${bearer}`, "x-intentic-connect": sandbox.token },
        signal: AbortSignal.timeout(10_000),
    });

const retireSandboxAccess = async (sandbox: SandboxSummary): Promise<void> => {
    // A row which never received an address never had a daemon at which browser access could be established.
    const base = sandbox.daemonUrl;
    if (base === null) {
        return;
    }
    const stored = sessions.value[sandbox.id] ?? readStored(sandbox.id);
    let bearer = stored !== undefined && Date.now() < stored.expiresAt - EXPIRY_MARGIN_MS ? stored.token : await getIdToken();
    if (bearer === undefined) {
        throw new Error(`Google sign-in was canceled.`);
    }
    let response = await removalRequest(sandbox, base, bearer);
    if (response.status === 401 && stored?.token === bearer) {
        invalidateSession(sandbox.id);
        bearer = await getIdToken();
        if (bearer === undefined) {
            throw new Error(`Google sign-in was canceled.`);
        }
        response = await removalRequest(sandbox, base, bearer);
    }
    // A shared sandbox may already have removed this member while its platform mirror was stale. That is the
    // desired security state, so an authoritative 403 there is complete rather than a deletion blocker.
    if (!response.ok && !(sandbox.role !== `owner` && response.status === 403)) {
        throw new Error(`access removal failed (${response.status})`);
    }
    invalidateSession(sandbox.id);
};

// Account deletion is allowed to proceed only after every reachable daemon has removed this identity. Owners
// permanently retire browser auth; members remove their own grant. Attempt all of them so one offline machine
// does not prevent the others becoming safe, then name the machines the user must bring online before retrying.
const retireAccountAccess = async (sandboxes: readonly SandboxSummary[]): Promise<void> => {
    const results = await Promise.allSettled(sandboxes.map((sandbox) => retireSandboxAccess(sandbox)));
    const failed = results.flatMap((result, index) => (result.status === `rejected` ? [sandboxes[index]?.name ?? `Unknown sandbox`] : []));
    if (failed.length > 0) {
        throw new Error(
            `Your account was not deleted because access could not be removed from ${failed.join(`, `)}. Bring ${failed.length === 1 ? `that sandbox` : `those sandboxes`} online and try again.`,
        );
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
    return { presentedEmail, getSessionToken, rejectSessionToken, invalidateSession, clearSessions, retireAccountAccess };
}
