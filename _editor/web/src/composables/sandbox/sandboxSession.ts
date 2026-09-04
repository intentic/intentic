import { computed, ref, watch } from "vue";
import { reloadOnHotUpdate } from "../hotReload";
import type { SandboxSummary } from "@intentic-app/api-contract";
import { removeStoredValue, storedKeys, storedValue, storeValue } from "../browserStorage";
import { useGoogleIdentity } from "../useGoogleIdentity";
import { healthAnswers, sandboxIdOf } from "./endpoint";
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
 * sandbox id to key a session by, is the one place the raw proof is still the answer.
 *
 * ONLY A CALL SOMEBODY IS WAITING ON MAY ASK GOOGLE FOR ANYTHING, and that rule is what the `background` flag
 * carries down from the call sites. The app reads across sandboxes now (fleetAcross, changesAcross), one poll
 * per box, and a box this browser holds no session for takes the whole establishment path: mint a proof,
 * exchange it. The mint is not quiet — One Tap is browser UI and the gate behind it covers the window — and
 * the sign-in it asks for is not even about the sandbox the reader is looking at, since `needsSignIn` is one
 * flag for the app and names no machine. Worse, a box that is OFF cannot complete the exchange, so nothing is
 * ever stored for it and the next poll (and the next refresh) asks Google all over again: a stopped laptop in
 * the account was enough to make every page load ask for a sign-in the workspace on screen did not need.
 *
 * So a background reader spends a credential already in hand and takes "no" for an answer, a foreground call
 * may interrupt, and neither one prompts for a daemon that has not first been shown to be answering. */

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
/* One in-flight establish per sandbox, so concurrent calls share a single Google mint + exchange, carrying
 * whether it may interrupt: a background establish cannot satisfy a caller who is standing there waiting, and
 * adopting one would turn a press into a silent failure. Sharing goes the other way freely. */
const inflight = new Map<string, { readonly pending: Promise<SandboxBearer | undefined>; readonly background: boolean }>();
const renewing = new Set<string>();
/* WHEN EACH SANDBOX LAST FAILED TO ESTABLISH, so a box that is not answering is asked once per cooldown rather
 * than once per poll tick and once per page load. Foreground calls are never held back by it: a press is the
 * user saying "now", and the reason they are pressing is usually that they just brought the machine back. */
const ESTABLISH_COOLDOWN_MS = 30_000;
const failedAt = new Map<string, number>();
const noteEstablishFailure = (sandboxId: string): void => void failedAt.set(sandboxId, Date.now());
const establishHolds = (sandboxId: string): boolean => {
    const at = failedAt.get(sandboxId);
    return at !== undefined && Date.now() - at < ESTABLISH_COOLDOWN_MS;
};
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

/* IS THE DAEMON WE ARE ABOUT TO ASK FOR A SIGN-IN EVEN THERE? Its own identity-checked /health, the same one
 * the transport qualifies addresses with, unauthenticated by design so it can be asked before any credential
 * exists (endpoint.ts owns both the check and the reasoning).
 *
 * Asked ONLY on the path that would otherwise put Google on the screen, which is what keeps it off the price
 * of an ordinary establishment: a browser holding a live proof exchanges it without a probe, and pays this one
 * round trip exactly when the alternative is asking a person for a credential on behalf of a machine that
 * might be switched off. A target with no connect token cannot be identity-checked, and a check we cannot make
 * must not become a reason to refuse a sign-in, so it answers yes. */
const daemonAnswers = async (target: SandboxTarget): Promise<boolean> => {
    const token = target.connectToken;
    return token === undefined || token === `` ? true : healthAnswers(target.base, await sandboxIdOf(token));
};

/* THE PLATFORM'S WORD, where it has one (sandboxTarget's `ownerVouched`): a hosted sandbox's owner gets a signed
 * ticket the daemon takes in place of a Google proof (the contract's owner-ticket.ts), which is what makes the
 * platform sign-in the only one. Asked only when no Google proof is in hand, and any refusal (a platform that
 * cannot sign, a daemon too old to verify) simply falls through to Google, exactly as before. Never stored:
 * it is spent in the next call and expires in minutes anyway. */
const ownerTicketFor = async (target: SandboxTarget): Promise<string | undefined> => {
    if (target.ownerVouched !== true || target.sandboxId === undefined) {
        return undefined;
    }
    try {
        // Loaded here rather than at the top: the platform client reads the page's environment when its module
        // loads, and this module is imported by code that runs where there is no page (the session tests, and
        // every reader that never reaches a hosted sandbox).
        const { apiClient } = await import("../useApi");
        return (await apiClient.sandbox.ownerTicket({ sandboxId: target.sandboxId })).ticket;
    } catch {
        return undefined;
    }
};

/* The proof this exchange will spend. A cached one costs nothing and is what the steady state uses; minting a
 * fresh one is an interruption, so it belongs only to a caller somebody is waiting on, and only once the
 * daemon has been shown to be answering. The platform's ticket sits between the two: free of interruption like
 * the cache, so a foreground caller tries it before it would put Google on the screen. */
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

// The sign-in moment: spend a Google proof (cached, or minted through One Tap / the rendered gate for a
// foreground caller) and exchange it. Network errors and malformed/non-2xx answers fail loudly: a daemon that
// cannot mint a session is broken, not old, and pretending otherwise would spend a raw Google proof per call.
const establish = (target: SandboxTarget & { readonly sandboxId: string }, background: boolean): Promise<SandboxBearer | undefined> => {
    const generation = generationOf(target.sandboxId);
    const pending: Promise<SandboxBearer | undefined> = (async (): Promise<SandboxBearer | undefined> => {
        const idToken = await proveIdentity(target, background);
        if (idToken === undefined) {
            return undefined;
        }
        let minted = await exchange(target, idToken);
        if (minted === `unauthorized` && !background) {
            // A definitive verifier rejection means the cached Google proof is dead or malformed (or the
            // platform's ticket was refused). Forget it and let this same user action drive the interactive
            // recovery once, rather than looping on it. Counted: this is one of the ways a second sign-in
            // reaches the screen, and until it was counted nobody could say which way it usually was.
            void import("../analytics").then(({ track }) => track(`sandbox_signin_gate`, { reason: `daemon-401` })).catch(() => undefined);
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
            /* ONE BOX'S REFUSAL IS NOT EVIDENCE ABOUT THE CREDENTIAL when nobody asked this question. Clearing
             * the proof also switches Google's automatic re-authentication off (useGoogleIdentity), so the next
             * mint anywhere in the app is a visible gate rather than a silent renewal — far too much to spend
             * on a poll of a machine the reader is not looking at, whose likelier explanations (a sandbox bound
             * to another account, a member since removed) say nothing at all about the token. */
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
        // A failed renewal changes nothing: the current session keeps working until expiry, and a daemon that
        // rotated its secret answers 401 on the next real call, which invalidates and re-establishes.
    } finally {
        renewing.delete(target.sandboxId);
    }
};

// The raw Google proof as a bearer, for the one caller that legitimately spends one: loopback mode, where
// there is no sandbox id to key a session by.
const googleBearer = async (background: boolean): Promise<SandboxBearer | undefined> => {
    const token = await getIdToken({ interactive: !background });
    return token === undefined ? undefined : { token, kind: `google` };
};

// A stored session still good past the guard: hydrated into the reactive mirror if this window has not read it
// yet, and slid forward in the background once it is close enough to expiry to be worth renewing.
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

/* One establishment per sandbox at a time, and, for the readers that must not press, one per cooldown.
 *
 * An establish already out for this box answers this call too, unless it is the quiet kind and this caller is
 * not: adopting a background attempt would settle a press with the silence a poll is content with. */
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

/* The bearer for a sandbox: a valid session (renewed in the background when due) or a freshly established one.
 * Undefined when there is none to be had without asking Google — the user dismissed the gate, or this is a
 * `background` read, which is never allowed to ask (see the header). */
const getSessionToken = async (target = currentSandboxTarget(), options?: { readonly background?: boolean }): Promise<SandboxBearer | undefined> => {
    const background = options?.background === true;
    if (target === undefined || target.sandboxId === undefined) {
        return googleBearer(background);
    }
    const scoped = { ...target, sandboxId: target.sandboxId };
    return servedSession(scoped) ?? establishShared(scoped, background);
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

// One session store and one channel per window: a hot update that re-ran this module would leave the daemon
// bearer being minted into an instance the client no longer reads, and every call would go back to Google
// (hotReload.ts).
reloadOnHotUpdate(import.meta);
