import { computed, ref, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import type { SandboxSummary } from "@intentic/api-contract";
import { removeStoredValue, storedKeys, storedValue, storeValue } from "../../../lib/browserStorage";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import { healthAnswers, sandboxIdOf } from "../secrets/endpoint";
import { useSandbox } from "./useSandbox";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";

// The credential every daemon call presents, a daemon-minted session, with the Google ID token demoted to the
// proof that establishes it: steady state no longer means an hourly Google reauth. Sessions are per sandbox,
// persisted, and renewed in the background near expiry; only a call somebody is waiting on may prompt Google.

interface StoredSession {
    readonly token: string;
    // Epoch ms, echoed by the daemon at mint.
    readonly expiresAt: number;
    // Who the daemon verified, the identity the gates name when access is denied.
    readonly email: string;
}

// What was presented, carried with the token instead of re-derived on a 401: re-reading storage after the fact
// can race a renewal or another window's invalidate that already replaced it.
export interface SandboxBearer {
    readonly token: string;
    readonly kind: "session" | "google";
}

const SESSION_KEY_PREFIX = `intentic.session.`;
const storageKey = (sandboxId: string): string => `${SESSION_KEY_PREFIX}${sandboxId}`;

// Never serve a token about to die mid-flight (the same guard the Google layer uses on its own tokens).
const EXPIRY_MARGIN_MS = 60_000;
// Renew via the session itself this close to expiry, so an active user never re-proves to Google.
const RENEW_UNDER_MS = 7 * 24 * 60 * 60 * 1000;

const { getIdToken, signedInEmail, clearCredential, cancelSignIn } = useGoogleIdentity();
const { activeSandboxId } = useSandbox();

// In-memory mirror of persisted sessions, hydrated lazily, so presentedEmail reacts without re-reading storage.
const sessions = ref<Record<string, StoredSession>>({});
// One in-flight establish per sandbox: shared both ways, but background can't satisfy a waiting caller.
const inflight = new Map<string, { readonly pending: Promise<SandboxBearer | undefined>; readonly background: boolean }>();
const renewing = new Set<string>();
// Cooldown before re-asking a sandbox that just failed; a foreground press is never held back by it.
const ESTABLISH_COOLDOWN_MS = 30_000;
const failedAt = new Map<string, number>();
const noteEstablishFailure = (sandboxId: string): void => void failedAt.set(sandboxId, Date.now());
const establishHolds = (sandboxId: string): boolean => {
    const at = failedAt.get(sandboxId);
    return at !== undefined && Date.now() - at < ESTABLISH_COOLDOWN_MS;
};
// Per-sandbox generation retires a late establish; the global one is for clearSessions, retiring all at once.
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

// Exchanges a verified bearer for a fresh session. A raw fetch on purpose: routing through sandboxRpc would
// recurse back into this module's own headers hook.
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

// Checks the daemon's unauthenticated /health before asking for a sign-in, paid only when the alternative is
// prompting for a possibly offline machine. Answers yes when there's no connect token to check with.
const daemonAnswers = async (target: SandboxTarget): Promise<boolean> => {
    const token = target.connectToken;
    return token === undefined || token === `` ? true : healthAnswers(target.base, await sandboxIdOf(token));
};

// A hosted sandbox's owner can present a signed platform ticket instead of a Google proof; asked only when no
// Google proof is in hand, and any refusal falls through to Google. Never stored.
const ownerTicketFor = async (target: SandboxTarget): Promise<string | undefined> => {
    if (target.ownerVouched !== true || target.sandboxId === undefined) {
        return undefined;
    }
    try {
        // Loaded here, not at top: the client reads page environment at import, and this module also runs pageless.
        const { apiClient } = await import("../../../lib/useApi");
        return (await apiClient.sandbox.ownerTicket({ sandboxId: target.sandboxId })).ticket;
    } catch {
        return undefined;
    }
};

// The proof to spend: a cached one is free, a platform ticket is free of interruption too, and a fresh Google
// mint is the last resort, only for a foreground caller once the daemon's been shown to answer.
const proveIdentity = async (target: SandboxTarget, background: boolean): Promise<string | undefined> => {
    const held = await getIdToken({ interactive: false });
    if (held !== undefined || background) {
        return held;
    }
    const vouched = await ownerTicketFor(target);
    if (vouched !== undefined) {
        return vouched;
    }
    return (await daemonAnswers(target)) ? getIdToken() : undefined;
};

// The sign-in moment: spends a Google proof (cached, or freshly minted for a foreground caller) and exchanges
// it. Network or malformed-response failures are thrown, not swallowed: a daemon that can't mint a session is
// broken, not just old.
const establish = (target: SandboxTarget & { readonly sandboxId: string }, background: boolean): Promise<SandboxBearer | undefined> => {
    const generation = generationOf(target.sandboxId);
    const pending: Promise<SandboxBearer | undefined> = (async (): Promise<SandboxBearer | undefined> => {
        const idToken = await proveIdentity(target, background);
        if (idToken === undefined) {
            return undefined;
        }
        let minted = await exchange(target, idToken);
        if (minted === `unauthorized` && !background) {
            // A rejected proof is dead; drop it and let this action drive one interactive retry rather than looping.
            void import("../../../app/analytics").then(({ track }) => track(`sandbox_signin_gate`, { reason: `daemon-401` })).catch(() => undefined);
            clearCredential();
            const replacement = await getIdToken();
            if (replacement === undefined) {
                return undefined;
            }
            minted = await exchange(target, replacement);
        }
        if (generationOf(target.sandboxId) !== generation) {
            return undefined;
        }
        if (minted === `unauthorized`) {
            // A background poll's refusal says nothing about the credential; only a foreground rejection clears it.
            if (background) {
                return undefined;
            }
            clearCredential();
            throw new Error(`The sandbox rejected your Google sign-in.`);
        }
        write(target.sandboxId, minted);
        return { token: minted.token, kind: `session` };
    })()
        .then((bearer) => {
            if (bearer === undefined) {
                noteEstablishFailure(target.sandboxId);
            }
            return bearer;
        })
        .catch((error: unknown) => {
            noteEstablishFailure(target.sandboxId);
            throw error;
        })
        .finally(() => {
            if (inflight.get(target.sandboxId)?.pending === pending) {
                inflight.delete(target.sandboxId);
            }
        });
    inflight.set(target.sandboxId, { pending, background });
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
        // A failed renewal changes nothing: the session works until expiry, a real rejection re-establishes next call.
    } finally {
        renewing.delete(target.sandboxId);
    }
};

// The raw Google proof as a bearer, for the one caller that legitimately spends it: loopback, with no sandbox
// id to key a session by.
const googleBearer = async (background: boolean): Promise<SandboxBearer | undefined> => {
    const token = await getIdToken({ interactive: !background });
    return token === undefined ? undefined : { token, kind: `google` };
};

// A stored session still good past the guard, hydrated into the reactive mirror on first read this window, and
// slid forward in the background once close enough to expiry.
const servedSession = (target: SandboxTarget & { readonly sandboxId: string }): SandboxBearer | undefined => {
    const sandboxId = target.sandboxId;
    const stored = sessions.value[sandboxId] ?? readStored(sandboxId);
    if (stored === undefined || Date.now() >= stored.expiresAt - EXPIRY_MARGIN_MS) {
        return undefined;
    }
    if (sessions.value[sandboxId] === undefined) {
        sessions.value = { ...sessions.value, [sandboxId]: stored };
    }
    if (Date.now() >= stored.expiresAt - RENEW_UNDER_MS) {
        void renew(target, stored.token).catch(() => undefined);
    }
    return { token: stored.token, kind: `session` };
};

// One establishment per sandbox at a time, and one per cooldown for background readers; an in-flight background
// attempt never silently answers a foreground press.
const establishShared = (target: SandboxTarget & { readonly sandboxId: string }, background: boolean): Promise<SandboxBearer | undefined> => {
    const running = inflight.get(target.sandboxId);
    if (running !== undefined && (background || !running.background)) {
        return running.pending;
    }
    if (background && establishHolds(target.sandboxId)) {
        return Promise.resolve(undefined);
    }
    return establish(target, background);
};

// The bearer for a sandbox: a valid session (renewed in the background when due) or a freshly established one.
// Undefined when none can be had without asking Google, which a background call may never do.
const getSessionToken = async (target = currentSandboxTarget(), options?: { readonly background?: boolean }): Promise<SandboxBearer | undefined> => {
    const background = options?.background === true;
    if (target === undefined || target.sandboxId === undefined) {
        return googleBearer(background);
    }
    const scoped = { ...target, sandboxId: target.sandboxId };
    return servedSession(scoped) ?? establishShared(scoped, background);
};

// Cancels a sign-in gate left behind after switching away from the sandbox that raised it, since an establish's
// mint isn't bound to any one sandbox. Left alone if the sandbox being switched to has its own establish in flight.
watch(activeSandboxId, (id, previous) => {
    if (previous === undefined || previous === id || !inflight.has(previous)) {
        return;
    }
    if (id !== undefined && inflight.has(id)) {
        return;
    }
    cancelSignIn();
});

// Drops the active sandbox's session (a 401, a rotated secret, an account switch); the next call re-establishes
// from a fresh Google proof.
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

// The bearer says which credential the daemon rejected: a session drops the Google proof for one retry, a
// raw-Google rejection clears it. Only dropped while the refused token is still on file.
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

// Sign-out or account deletion: forgets every sandbox's session, alongside useAuth's clearCredential.
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
        // A member's row carries no connect token, and the daemon it reaches is bound already: nothing to send.
        headers: { authorization: `Bearer ${bearer}`, ...(sandbox.token === null ? {} : { "x-intentic-connect": sandbox.token }) },
        signal: AbortSignal.timeout(10_000),
    });

const retireSandboxAccess = async (sandbox: SandboxSummary): Promise<void> => {
    // No address ever assigned means no daemon ever had browser access to retire.
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
    // An already-removed member is the desired end state; a 403 there completes the removal rather than blocking it.
    if (!response.ok && !(sandbox.role !== `owner` && response.status === 403)) {
        throw new Error(`access removal failed (${response.status})`);
    }
    invalidateSession(sandbox.id);
};

// Account deletion proceeds only once every reachable daemon has removed this identity (owners retire access,
// members remove their own grant); one offline machine must not block the rest.
const retireAccountAccess = async (sandboxes: readonly SandboxSummary[]): Promise<void> => {
    const results = await Promise.allSettled(sandboxes.map((sandbox) => retireSandboxAccess(sandbox)));
    const failed = results.flatMap((result, index) => (result.status === `rejected` ? [sandboxes[index]?.name ?? `Unknown sandbox`] : []));
    if (failed.length > 0) {
        throw new Error(
            `Your account was not deleted because access could not be removed from ${failed.join(`, `)}. Bring ${failed.length === 1 ? `that sandbox` : `those sandboxes`} online and try again.`,
        );
    }
};

// The identity this browser presents to the active daemon: the session's email when one exists, else the
// Google credential's. Named by the gates (the mismatch bar, the no-access screen).
const presentedEmail = computed<string | undefined>(() => {
    const sandboxId = activeSandboxId.value;
    const stored = sandboxId === undefined ? undefined : (sessions.value[sandboxId] ?? readStored(sandboxId));
    return stored !== undefined && Date.now() < stored.expiresAt ? stored.email : signedInEmail.value;
});

// When this browser's session on the active daemon expires; there's no device list since the daemon verifies a
// signed claim rather than looking one up. Undefined for loopback or a pre-exchange daemon.
const sessionExpiresAt = computed<number | undefined>(() => {
    const sandboxId = activeSandboxId.value;
    const stored = sandboxId === undefined ? undefined : (sessions.value[sandboxId] ?? readStored(sandboxId));
    return stored !== undefined && Date.now() < stored.expiresAt ? stored.expiresAt : undefined;
});

export function useSandboxSession() {
    return { presentedEmail, sessionExpiresAt, getSessionToken, rejectSessionToken, invalidateSession, clearSessions, retireAccountAccess };
}

// One session store and channel per window: a hot-reloaded copy would mint into an instance nothing reads.
reloadOnHotUpdate(import.meta);
