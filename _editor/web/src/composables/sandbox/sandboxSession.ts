import { computed, ref, watch } from "vue";
import type { SandboxSummary } from "@intentic-app/api-contract";
import { removeStoredValue, storedKeys, storedValue, storeValue } from "../browserStorage";
import { useGoogleIdentity } from "../useGoogleIdentity";
import { useSandbox } from "./useSandbox";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";

/* The credential every browser→daemon call presents, as a module-level singleton: a DAEMON-MINTED session,
 * with the Google ID token demoted to the sign-in proof that establishes it.
 *
 * The raw Google ID token used to BE the steady-state credential, and its ~1h lifetime meant every renewal
 * went back through Google Identity Services, whose FedCM prompt shows browser UI even for a silent re-auth,
 * so "Sign in with Google" popped over a perfectly healthy workspace, roughly hourly, at whatever moment a
 * call crossed the expiry guard. Exchanging the first verified Google token for a weeks-long session the
 * daemon signs itself (system.session) makes Google UI a sign-in moment again: first visit in a browser,
 * account switch, a long-idle return, never mid-session. The daemon stays the only verifier and enforcer
 * (owner/membership are re-checked per request), and the platform still never sees either credential.
 *
 * Sessions are per sandbox (each daemon signs with its own secret), persisted in localStorage like the Google
 * credential, and renewed IN THE BACKGROUND with the session itself once within a week of expiry, an active
 * user re-proves to Google only after a month away. The exchange is the ONLY road to a bearer for a named
 * sandbox: a daemon that will not mint one fails visibly rather than falling back to spending a raw Google
 * proof per call, which is a credential mode nobody chose and nothing reports. Loopback, where there is no
 * sandbox id to key a session by, is the one place the raw proof is still the answer. */

interface StoredSession {
    readonly token: string;
    // Epoch ms, echoed by the daemon at mint.
    readonly expiresAt: number;
    // Who the daemon verified, the identity the gates name when access is denied.
    readonly email: string;
}

/* WHAT A CALLER PRESENTED, carried with the token rather than re-derived when it comes back refused.
 *
 * A 401 has to be attributed to the credential that earned it: a refused SESSION is re-established from the
 * Google proof still in hand, a refused GOOGLE proof is thrown away so it cannot be replayed forever. The
 * attribution used to be made by re-reading the stored session and comparing, which is a read of state the
 * request does not own: a background renewal, or the other window's invalidate arriving over the channel,
 * replaces it while the request is in flight, and the comparison then says "not the session" about a token
 * that WAS the session. The refusal fell through to clearing the Google credential, which also turns off
 * Google's automatic re-authentication, so the next daemon call could only come back as a visible sign-in
 * gate. Two concurrent 401s on one session were enough on their own: the first invalidates, the second finds
 * nothing on file and clears.
 *
 * So the caller says which one it spent. Nothing about the answer depends on what happened meanwhile. */
export interface SandboxBearer {
    readonly token: string;
    readonly kind: "session" | "google";
}

const SESSION_KEY_PREFIX = `intentic.session.`;
const storageKey = (sandboxId: string): string => `${SESSION_KEY_PREFIX}${sandboxId}`;

// Never serve a token about to die mid-flight (the same guard the Google layer uses on its own tokens).
const EXPIRY_MARGIN_MS = 60_000;
// Renew, with the session itself, no Google involved, once this close to expiry, so an ACTIVE user's
// session slides forever and only a return from a long absence re-proves identity.
const RENEW_UNDER_MS = 7 * 24 * 60 * 60 * 1000;

const { getIdToken, signedInEmail, clearCredential, cancelSignIn } = useGoogleIdentity();
const { activeSandboxId } = useSandbox();

// In-memory mirror of the persisted sessions (hydrated lazily per sandbox), so presentedEmail is reactive to
// mints and invalidations without re-reading storage.
const sessions = ref<Record<string, StoredSession>>({});
// One in-flight establish per sandbox, so concurrent calls share a single Google mint + exchange.
const inflight = new Map<string, Promise<SandboxBearer | undefined>>();
const renewing = new Set<string>();
/* Invalidates async establishment/renewal already past an await. A late response may complete on the wire, but
 * it cannot write or return a credential after the thing that retired it.
 *
 * PER SANDBOX, and that is the whole point of the pair. A single counter meant one sandbox's 401 discarded a
 * session another sandbox had just minted successfully — the exchange landed, the write was skipped, and the
 * next call established all over again, which is a Google round trip whenever the ~1h proof has aged out. The
 * global half stays for `clearSessions`, which retires every sandbox at once (a sign-out must reach a mint in
 * flight for a sandbox nobody has named yet, so it cannot be a per-id bump). */
let allGeneration = 0;
const sandboxGenerations = new Map<string, number>();
const generationOf = (sandboxId: string): string => `${allGeneration}.${sandboxGenerations.get(sandboxId) ?? 0}`;
const retireGeneration = (sandboxId: string): void => {
    sandboxGenerations.set(sandboxId, (sandboxGenerations.get(sandboxId) ?? 0) + 1);
};

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
// through it would recurse.
const exchange = async (target: SandboxTarget, bearer: string): Promise<StoredSession | `unauthorized`> => {
    try {
        const response = await fetch(`${target.base}/system/session`, {
            method: `POST`,
            headers: {
                authorization: `Bearer ${bearer}`,
                ...(target.connectToken !== undefined ? { "x-intentic-connect": target.connectToken } : {}),
            },
            signal: AbortSignal.timeout(10_000),
        });
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
// gate otherwise) and exchange it. Network errors and malformed/non-2xx answers fail loudly: a daemon that
// cannot mint a session is broken, not old, and pretending otherwise would spend a raw Google proof per call.
const establish = (target: SandboxTarget & { readonly sandboxId: string }): Promise<SandboxBearer | undefined> => {
    const generation = generationOf(target.sandboxId);
    const pending = (async (): Promise<SandboxBearer | undefined> => {
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
        if (generationOf(target.sandboxId) !== generation) {
            return undefined;
        }
        if (minted === `unauthorized`) {
            clearCredential();
            throw new Error(`The sandbox rejected your Google sign-in.`);
        }
        write(target.sandboxId, minted);
        return { token: minted.token, kind: `session` };
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
    const generation = generationOf(target.sandboxId);
    renewing.add(target.sandboxId);
    try {
        const minted = await exchange(target, sessionToken);
        if (minted !== `unauthorized` && generation === generationOf(target.sandboxId)) {
            write(target.sandboxId, minted);
        }
        // A failed renewal changes nothing: the current session keeps working until expiry, and a daemon that
        // rotated its secret answers 401 on the next real call, which invalidates and re-establishes.
    } finally {
        renewing.delete(target.sandboxId);
    }
};

// The raw Google proof as a bearer, for the one caller that legitimately spends one: loopback mode, where
// there is no sandbox id to key a session by.
const googleBearer = async (): Promise<SandboxBearer | undefined> => {
    const token = await getIdToken();
    return token === undefined ? undefined : { token, kind: `google` };
};

// The bearer for the active sandbox: a valid session (renewed in the background when due) or the freshly
// established one. Undefined only when the user dismisses the sign-in gate.
const getSessionToken = async (target = currentSandboxTarget()): Promise<SandboxBearer | undefined> => {
    if (target === undefined || target.sandboxId === undefined) {
        return googleBearer();
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
        return { token: stored.token, kind: `session` };
    }
    return inflight.get(sandboxId) ?? establish({ ...target, sandboxId });
};

/* A SIGN-IN NOBODY IS WAITING FOR ANY MORE, settled the moment the user points the workspace somewhere else.
 *
 * Establishing a session for a sandbox starts a Google mint, and a mint shows Google's own UI and then, when
 * that produces nothing within the guard, the app's full-screen gate. Neither is bound to the sandbox that
 * asked: `needsSignIn` is one flag for the window. So a switch to a sandbox this browser has no session for
 * raised a gate that outlived the switch BACK, and it arrived up to five seconds late, which is to say over a
 * workspace whose credentials are perfectly good, with nothing on it to explain which machine it is about.
 * Every window of the app does this at once, because the popped-out panels follow the active sandbox
 * (pages/FloatingArea.vue), so the same prompt appeared on both screens.
 *
 * Fired only when WE have an establish parked for the sandbox being left, and never when the incoming one is
 * parked too: a mint is one shared promise, so settling it for the outgoing sandbox would also settle the
 * sign-in the user is about to need. Anything else awaiting that same mint (the setup wizard's own, in the
 * window where both could be up) resolves empty and asks again when it next needs a credential, which is the
 * behaviour a dismissed gate already has.
 *
 * This is the credential half of the sandbox re-scope, which the other self-scoping subsystems (the liveness
 * stream, the extension host) do for their own state; sandboxScope.ts names all three. */
watch(activeSandboxId, (id, previous) => {
    if (previous === undefined || previous === id || !inflight.has(previous)) {
        return;
    }
    if (id !== undefined && inflight.has(id)) {
        return;
    }
    cancelSignIn();
});

// Drop the ACTIVE sandbox's session: the daemon rejected it (401, secret rotated, expiry raced) or the user
// is switching Google accounts. The next call re-establishes from a fresh Google proof.
const invalidateSession = (sandboxId = activeSandboxId.value, broadcast = true): void => {
    if (sandboxId === undefined) {
        return;
    }
    retireGeneration(sandboxId);
    const rest = { ...sessions.value };
    delete rest[sandboxId];
    sessions.value = rest;
    removeStoredValue(storageKey(sandboxId));
    if (broadcast) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
        channel?.postMessage({ kind: `invalidate`, sandboxId } satisfies SessionMessage);
    }
};

/* A 401 names the exact bearer the daemon rejected, and the bearer says which credential it is (SandboxBearer).
 * A session rejection keeps the Google proof available for the one retry; a raw-Google rejection clears that
 * proof so it cannot be replayed forever.
 *
 * The session is dropped only while the refused one is still what is on file. A background renewal, or the
 * other window's invalidate arriving first, may already have replaced it, and retiring a successor nothing has
 * rejected costs a round trip for no reason. */
const rejectSessionToken = (target: SandboxTarget, rejected: SandboxBearer): void => {
    if (rejected.kind === `google`) {
        clearCredential();
        return;
    }
    const sandboxId = target.sandboxId;
    const stored = sandboxId === undefined ? undefined : (sessions.value[sandboxId] ?? readStored(sandboxId));
    if (sandboxId !== undefined && stored?.token === rejected.token) {
        invalidateSession(sandboxId);
    }
};

// Platform sign-out / account deletion: forget EVERY sandbox's session, alongside useAuth's clearCredential.
const clearSessions = (broadcast = true): void => {
    allGeneration += 1;
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

// The identity this browser presents to the ACTIVE daemon, the session's email when one exists, else the
// Google credential's. The gates name it: the pre-bind mismatch bar, the "no access" screen.
const presentedEmail = computed<string | undefined>(() => {
    const sandboxId = activeSandboxId.value;
    const stored = sandboxId === undefined ? undefined : (sessions.value[sandboxId] ?? readStored(sandboxId));
    return stored !== undefined && Date.now() < stored.expiresAt ? stored.email : signedInEmail.value;
});

/* WHEN THIS BROWSER'S PASS RUNS OUT, and the only fact about a signed-in browser the app can ever state.
 *
 * Nothing is stored per session anywhere: the daemon VERIFIES a signed claim rather than looking one up, which
 * is what keeps a request a local HMAC instead of a database read. So no device list exists to render, here or
 * on the daemon, and the access tab would otherwise have nothing at all to say under a heading that promises a
 * roster. It can at least speak for the browser it is running in.
 *
 * Undefined when there is no session to describe: a daemon predating the exchange (raw Google token per call)
 * and loopback mode, where the answer is "signed in" with no expiry to quote. */
const sessionExpiresAt = computed<number | undefined>(() => {
    const sandboxId = activeSandboxId.value;
    const stored = sandboxId === undefined ? undefined : (sessions.value[sandboxId] ?? readStored(sandboxId));
    return stored !== undefined && Date.now() < stored.expiresAt ? stored.expiresAt : undefined;
});

export function useSandboxSession() {
    return { presentedEmail, sessionExpiresAt, getSessionToken, rejectSessionToken, invalidateSession, clearSessions, retireAccountAccess };
}
