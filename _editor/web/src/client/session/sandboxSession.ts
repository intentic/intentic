import { anySignal, SingleFlight } from "@intentic/base/async";
import { computed, ref, watch } from "vue";
import { reloadOnHotUpdate } from "../../app/hotReload";
import type { SandboxSummary } from "@intentic/api-contract";
import {
    type DaemonSession,
    EMAIL_SIGN_IN_OFF,
    type PasskeyRequired,
    PasskeyRequiredSchema,
    PLATFORM_KEY_UNKNOWN,
    rawRouteUrl,
} from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { z } from "zod";
import { passkeyNudgeKey, removeStoredValue, storedKeys, storedValue, storeValue } from "../../lib/browserStorage";
import { accountWaysIn, emailOnly, signsInByEmail } from "../auth/signInMethods";
import { useGoogleIdentity } from "../auth/useGoogleIdentity";
import { healthAnswers, sandboxIdOf } from "../endpoint/endpoint";
import { type DaemonDoor, readDaemonDoor, takesEmailProof } from "./daemonDoor";
import { passkeyOffered } from "./passkeySignIn";
import {
    dismissSignIn,
    type EmailAnswer,
    type EmailRoad,
    offerPasskey,
    raiseSignIn,
    type SignInPrompt,
    sameBearer,
    type StepUpBearer,
    useSignInPrompt,
} from "./signInPrompt";
import { useSandbox } from "../sandbox/useSandbox";
import { currentSandboxTarget, type SandboxTarget } from "../sandbox/sandboxTarget";

// The credential every daemon call presents, a daemon-minted session, with the Google ID token (or a passkey, or the
// platform's identity assertion for an account that signs in by email) demoted to the proof that establishes it: steady
// state no longer means an hourly Google reauth. Sessions are per sandbox, persisted, and renewed in the background near
// expiry; only a call somebody is waiting on may prompt for a sign-in.
//
// THE PROOF CHAIN, in order: a live daemon session; a cached Google token; the platform's identity assertion (only for a
// call somebody waits on, only where the daemon's /health lists `email` and the account has `email` among its ways in);
// the owner ticket (a hosted machine's owner, for daemons from before the assertion); then the sign-in wall. An account
// with no Google sign-in never meets Google's prompt: its refusals are said by name instead.

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
const { prompt: signInPrompt } = useSignInPrompt();
const { activeSandboxId } = useSandbox();

// In-memory mirror of persisted sessions, hydrated lazily, so presentedEmail reacts without re-reading storage.
// allow(module-state): daemon sessions keyed by sandbox id
const sessions = ref<Record<string, StoredSession>>({});
// One in-flight establish per sandbox and kind: a press's answers a poll too, but a poll's never answers a press, which
// may need to prompt. Two flights rather than one entry a press overwrites, so neither's end can drop the other's.
const pressing = new SingleFlight<string, SandboxBearer | undefined>();
const polling = new SingleFlight<string, SandboxBearer | undefined>();
const establishing = (sandboxId: string): Promise<SandboxBearer | undefined> | undefined => pressing.joined(sandboxId) ?? polling.joined(sandboxId);
const renewals = new SingleFlight<string, void>();
// Cooldown before re-asking a sandbox that just failed; a foreground press is never held back by it.
const ESTABLISH_COOLDOWN_MS = 30_000;
const failedAt = new Map<string, number>();
const noteEstablishFailure = (sandboxId: string): void => void failedAt.set(sandboxId, Date.now());
const establishHolds = (sandboxId: string): boolean => {
    const at = failedAt.get(sandboxId);
    return at !== undefined && Date.now() - at < ESTABLISH_COOLDOWN_MS;
};
// A sandbox's establishes and renewals in flight share one signal, aborted when its session is invalidated (every
// sandbox's, when all are cleared): their exchange is cancelled, no sign-in is raised for them, and nothing they still
// mint is stored over what was just thrown away.
const retirements = new Map<string, AbortController>();
const retirementOf = (sandboxId: string): AbortSignal => {
    let controller = retirements.get(sandboxId);
    if (controller === undefined) {
        controller = new AbortController();
        retirements.set(sandboxId, controller);
    }
    return controller.signal;
};
const retire = (sandboxId: string): void => {
    retirements.get(sandboxId)?.abort();
    retirements.delete(sandboxId);
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
        // The daemon's named reason beside its status, where it gave one (EMAIL_SIGN_IN_OFF).
        readonly reason?: string,
    ) {
        super(message);
    }
}

// The daemon's named refusals of the platform's identity assertion (sandbox-contract schemas/system.ts), and the two this
// module adds for an assertion that never reached it: the platform would not mint one, or the daemon refused it bare.
export type EmailRefusal = typeof EMAIL_SIGN_IN_OFF | typeof PLATFORM_KEY_UNKNOWN | `rejected` | `unavailable`;
interface Refused {
    readonly refused: EmailRefusal;
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
    forgetEmailRefusal(sandboxId);
    storeValue(storageKey(sandboxId), JSON.stringify(session));
    if (broadcast) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
        channel?.postMessage({ kind: `write`, sandboxId, session } satisfies SessionMessage);
    }
};

// The daemon's third answer to an exchange: the identity is welcome, the proof is short of the sandbox's passkey rule.
interface StepUp {
    readonly stepUp: PasskeyRequired;
}

const storedOf = (session: DaemonSession): StoredSession => ({ token: session.token, expiresAt: session.expiresAt, email: session.email });

// Every exchange's answer that is a session, told apart from the refusals and the step-up beside it.
const isSession = (answer: StoredSession | `unauthorized` | StepUp | Refused): answer is StoredSession =>
    typeof answer === `object` && `token` in answer;

// The `reason` a daemon's refusal carries beside its `error` (EMAIL_SIGN_IN_OFF, PLATFORM_KEY_UNKNOWN).
const RefusalReasonSchema = z.object({ reason: z.string() });
const refusalReason = async (response: Response): Promise<string | undefined> => {
    // allow(silent-catch): a refusal whose body is not JSON names no reason, which is what undefined says.
    const parsed = RefusalReasonSchema.safeParse(await response.json().catch(() => undefined));
    return parsed.success ? parsed.data.reason : undefined;
};

// The minted session off the exchange's body, or a throw for a daemon answering with something else.
const mintedFrom = (body: unknown): StoredSession => {
    const fields = typeof body === `object` && body !== null ? (body as { token?: unknown; expiresAt?: unknown; email?: unknown }) : {};
    if (typeof fields.token !== `string` || fields.token === `` || typeof fields.expiresAt !== `number` || !Number.isFinite(fields.expiresAt) || typeof fields.email !== `string`) {
        throw new Error(t(`sandbox.sandboxSession.invalidSession`));
    }
    if (Date.now() >= fields.expiresAt - EXPIRY_MARGIN_MS) {
        throw new Error(t(`sandbox.sandboxSession.expiredSession`));
    }
    return { token: fields.token, expiresAt: fields.expiresAt, email: fields.email };
};

// The step-up off a 428: a body that isn't the contract's still means the step-up, with `enrolled` false walking through
// adding a first passkey; the daemon refusing a second one is what tells the truth.
const stepUpFrom = (body: unknown): StepUp => {
    const required = PasskeyRequiredSchema.safeParse(body);
    return { stepUp: required.success ? required.data : { error: `this sandbox requires a passkey`, requires: `passkey`, enrolled: false } };
};

// Exchanges a verified bearer for a fresh session. A raw fetch on purpose: routing through sandboxRpc would
// recurse back into this module's own headers hook.
const exchange = async (target: SandboxTarget, bearer: string, signal: AbortSignal): Promise<StoredSession | `unauthorized` | StepUp | Refused> => {
    try {
        // allow(contract-paths): the exchange mints the session sandboxRpc's headers hook asks this module for, so the typed client would recurse
        const response = await fetch(`${target.base}/system/session`, {
            method: `POST`,
            headers: {
                authorization: `Bearer ${bearer}`,
                ...(target.connectToken !== undefined ? { "x-intentic-connect": target.connectToken } : {}),
            },
            signal: anySignal(AbortSignal.timeout(10_000), signal),
        });
        // An identity assertion's refusals carry a reason: a daemon that has not learned the platform's key yet (401), a
        // person this sandbox has not opted in to email sign-in (403). Any other 401 is a dead proof, as it always was.
        if (response.status === 401) {
            return (await refusalReason(response)) === PLATFORM_KEY_UNKNOWN ? { refused: PLATFORM_KEY_UNKNOWN } : `unauthorized`;
        }
        if (response.status === 403 && (await refusalReason(response)) === EMAIL_SIGN_IN_OFF) {
            return { refused: EMAIL_SIGN_IN_OFF };
        }
        if (response.status === 428) {
            return stepUpFrom(await response.json().catch(() => undefined));
        }
        if (!response.ok) {
            throw new SandboxSessionError(response.status, t(`sandbox.sandboxSession.exchangeRefused`, { status: response.status }));
        }
        return mintedFrom(await response.json());
    } catch (error) {
        if (error instanceof Error && error.name === `TimeoutError`) {
            throw new Error(t(`sandbox.sandboxSession.signInTimeout`), { cause: error });
        }
        throw error;
    }
};

// Checks the daemon's unauthenticated /health before asking for a sign-in, paid only when the alternative is
// prompting for a possibly offline machine. A member holds no connect token to say WHICH sandbox should answer, so
// theirs asks only whether one answers at all: it used to answer yes unasked, and a member met Google's prompt for a
// sandbox whose machine was off.
const daemonAnswers = async (target: SandboxTarget): Promise<boolean> => {
    const token = target.connectToken;
    return healthAnswers(target.base, token === undefined || token === `` ? undefined : await sandboxIdOf(token));
};

// A hosted sandbox's owner can present a signed platform ticket instead of a Google proof; asked only when no
// Google proof is in hand, and any refusal falls through to Google. Never stored.
const ownerTicketFor = async (target: SandboxTarget, signal: AbortSignal): Promise<string | undefined> => {
    if (target.platformVouch?.ownerTicket !== true || target.sandboxId === undefined) {
        return undefined;
    }
    try {
        // Loaded here, not at top: the client reads page environment at import, and this module also runs pageless.
        const { apiClient } = await import("../../lib/useApi");
        return (await apiClient.sandbox.ownerTicket({ sandboxId: target.sandboxId }, { signal })).ticket;
    } catch {
        return undefined;
    }
};

// A target with a sandbox id, the only kind a session can be stored for.
type ScopedTarget = SandboxTarget & { readonly sandboxId: string };

// The daemon answering, and the proofs it lists: read once per sign-in moment by the email road, which needs both.
const daemonDoor = async (target: SandboxTarget): Promise<DaemonDoor> => {
    const token = target.connectToken;
    return readDaemonDoor(target.base, token === undefined || token === `` ? undefined : await sandboxIdOf(token));
};

type SignInChoice = { readonly kind: `google`; readonly idToken: string } | { readonly kind: `session`; readonly session: StoredSession };

// What an account that signs in by email brings to the sign-in moment: its road on this sandbox (absent when it has none
// to offer here), and whether Google may be asked at all.
interface EmailChoice {
    readonly road: EmailRoad | undefined;
    readonly withoutGoogle: boolean;
}

// The sign-in moment for someone with nothing in hand: Google's gate goes up, and a passkey is offered beside it once
// the daemon says one is registered for this origin; whichever the person answers with settles it, and the other road
// is closed so nothing stays parked. An account with no Google sign-in is never put in front of Google's gate: the
// prompt alone is the wall, with its email road and the passkey. The email road has read the daemon's door already.
const chooseSignIn = async (target: SandboxTarget, signal: AbortSignal, email?: EmailChoice): Promise<SignInChoice | undefined> => {
    if ((email === undefined && !(await daemonAnswers(target))) || signal.aborted) {
        return undefined;
    }
    const withoutGoogle = email?.withoutGoogle === true;
    const choice: SignInPrompt = { kind: `choose`, target, passkey: false, email: email?.road, withoutGoogle: withoutGoogle ? true : undefined };
    const viaPrompt = raiseSignIn(choice).then(
        (session): SignInChoice | undefined => (session === undefined ? undefined : { kind: `session`, session: storedOf(session) }),
    );
    void passkeyOffered(target)
        .then((offered) => offerPasskey(target, offered))
        .catch(() => undefined);
    if (withoutGoogle) {
        const chosen = await viaPrompt;
        dismissSignIn();
        return chosen;
    }
    const viaGoogle = getIdToken().then((idToken): SignInChoice | undefined => (idToken === undefined ? undefined : { kind: `google`, idToken }));
    const chosen = await Promise.race([viaGoogle, viaPrompt]);
    cancelSignIn();
    dismissSignIn();
    return chosen;
};

// A proof the sandbox accepted but will not open for: the gate asks for the passkey held, or walks through adding a
// first one under this proof, and the ceremony's session comes back here.
const stepUp = async (target: SandboxTarget, bearer: StepUpBearer, required: PasskeyRequired): Promise<StoredSession | undefined> => {
    const session = await raiseSignIn({ kind: `step-up`, target, enrolled: required.enrolled, bearer });
    return session === undefined ? undefined : storedOf(session);
};

// Exchanges a Google proof, following the daemon's three answers: a session; a refusal, which kills the proof and
// earns one interactive retry when someone is waiting; or the passkey step-up, which a background poll never enters.
// A retired establishment follows none of them: it clears no proof and raises no gate.
const settleExchange = async (
    target: SandboxTarget,
    idToken: string,
    background: boolean,
    retry: boolean,
    signal: AbortSignal,
): Promise<StoredSession | undefined> => {
    const minted = await exchange(target, idToken, signal);
    if (signal.aborted) {
        return undefined;
    }
    if (minted === `unauthorized`) {
        // A background poll's refusal says nothing about the credential; only a foreground rejection clears it.
        if (background) {
            return undefined;
        }
        clearCredential();
        if (!retry) {
            throw new Error(t(`sandbox.sandboxSession.googleRejected`));
        }
        // A rejected proof is dead; drop it and let this action drive one interactive retry rather than looping.
        void import("../../app/analytics").then(({ track }) => track(`sandbox_signin_gate`, { reason: `daemon-401` })).catch(() => undefined);
        const replacement = await getIdToken();
        return replacement === undefined ? undefined : settleExchange(target, replacement, false, false, signal);
    }
    if (`stepUp` in minted) {
        return background ? undefined : stepUp(target, sameBearer(idToken), minted.stepUp);
    }
    // A reason only an identity assertion meets; a Google proof never should, and is not taken for a session if it does.
    if (`refused` in minted) {
        throw new Error(emailRefusalText(minted.refused));
    }
    return minted;
};

// The sign-in moment, and the Google proof it may come back with exchanged.
const chooseAndSettle = async (target: SandboxTarget, signal: AbortSignal, email?: EmailChoice): Promise<StoredSession | undefined> => {
    const chosen = await chooseSignIn(target, signal, email);
    if (chosen === undefined) {
        return undefined;
    }
    return chosen.kind === `session` ? chosen.session : settleExchange(target, chosen.idToken, false, true, signal);
};

/* THE EMAIL ROAD. */

// The platform's word that this account controls its address, minted for this one sandbox and spent at once on its
// daemon: never stored, never shown, dead within minutes whatever happens to it.
const mintAssertion = async (sandboxId: string, signal: AbortSignal): Promise<string> => {
    // Loaded here, not at top, as the owner ticket is: this module also runs pageless.
    const { apiClient } = await import("../../lib/useApi");
    return (await apiClient.sandbox.identityAssertion({ sandboxId }, { signal })).assertion;
};

type EmailOutcome = StoredSession | (StepUp & { readonly bearer: StepUpBearer }) | Refused;

// How long minting one of the step-up's fresh assertions may take; it outlives the establish that raised the step-up.
const STEP_UP_MINT_MS = 15_000;

// One assertion, minted and exchanged: a session, the step-up with the assertion it was taken on, or a refusal by name.
const spendAssertion = async (target: ScopedTarget, signal: AbortSignal): Promise<EmailOutcome> => {
    let assertion: string;
    try {
        assertion = await mintAssertion(target.sandboxId, signal);
    } catch (error) {
        // The platform would not vouch (an account that is not an email one after all, a platform that signs none) or
        // could not be asked: the road is closed for now, and said so, rather than read as the daemon's refusal.
        console.warn(`[session] the platform minted no identity assertion:`, error);
        return { refused: `unavailable` };
    }
    const minted = await exchange(target, assertion, signal);
    if (minted === `unauthorized`) {
        return { refused: `rejected` };
    }
    // The assertion this exchange took is spent; each call of the step-up that follows mints its own.
    return `stepUp` in minted ? { stepUp: minted.stepUp, bearer: () => mintAssertion(target.sandboxId, AbortSignal.timeout(STEP_UP_MINT_MS)) } : minted;
};

// Words are built when read (languages.md), so a refusal is said in the language of the moment it is shown.
const emailRefusalText = (refusal: EmailRefusal): string => {
    switch (refusal) {
        case EMAIL_SIGN_IN_OFF: {
            return t(`sandbox.sandboxSession.emailSignInOff`);
        }
        case PLATFORM_KEY_UNKNOWN: {
            return t(`sandbox.sandboxSession.platformKeyUnknown`);
        }
        case `rejected`: {
            return t(`sandbox.sandboxSession.assertionRejected`);
        }
        default: {
            return t(`sandbox.sandboxSession.assertionUnavailable`);
        }
    }
};

// The last refusal an email sign-in met, per sandbox, and when: the no-access gate names it, and the one only the owner
// can lift holds new assertions back for a while, since the liveness loop retries a blocked sandbox every few seconds
// and each retry would otherwise be a mint and an exchange. A session for the sandbox clears it.
const EMAIL_REFUSAL_HOLD_MS = 30_000;
// allow(module-state): per sandbox, the last refusal an email sign-in met
const emailRefusals = ref<Record<string, { readonly refusal: EmailRefusal; readonly at: number }>>({});
const noteEmailRefusal = (sandboxId: string, refusal: EmailRefusal): void => {
    emailRefusals.value = { ...emailRefusals.value, [sandboxId]: { refusal, at: Date.now() } };
};
const forgetEmailRefusal = (sandboxId: string): void => {
    if (emailRefusals.value[sandboxId] === undefined) {
        return;
    }
    const rest = { ...emailRefusals.value };
    delete rest[sandboxId];
    emailRefusals.value = rest;
};
const ownerRefusalHolds = (sandboxId: string): boolean => {
    const last = emailRefusals.value[sandboxId];
    return last?.refusal === EMAIL_SIGN_IN_OFF && Date.now() - last.at < EMAIL_REFUSAL_HOLD_MS;
};
// What the no-access gate says for a person this sandbox has not opted in to email sign-in.
const refusedByOwner = (): SandboxSessionError => new SandboxSessionError(403, t(`sandbox.sandboxSession.emailSignInOff`), EMAIL_SIGN_IN_OFF);

// A first session this browser got on a sandbox by email code: the nudge to add a passkey, which opens the sandbox even
// while intentic cannot vouch for anybody (shell/notifications/notificationSources.ts). Put away per sandbox, once.
// allow(module-state): the one sandbox a passkey is being suggested for
const passkeyNudge = ref<string | undefined>(undefined);
const nudgePasskey = (sandboxId: string): void => {
    if (storedValue(passkeyNudgeKey(sandboxId)) === undefined) {
        passkeyNudge.value = sandboxId;
    }
};
const dismissPasskeyNudge = (): void => {
    const sandboxId = passkeyNudge.value;
    if (sandboxId !== undefined) {
        storeValue(passkeyNudgeKey(sandboxId), `dismissed`);
    }
    passkeyNudge.value = undefined;
};

// "Continue as" on the wall: a fresh assertion, its refusal thrown in the words the wall shows.
const spendForWall =
    (target: ScopedTarget) =>
    async (): Promise<EmailAnswer> => {
        const outcome = await spendAssertion(target, retirementOf(target.sandboxId));
        if (isSession(outcome)) {
            nudgePasskey(target.sandboxId);
            return { session: outcome };
        }
        if (`stepUp` in outcome) {
            return { stepUp: outcome.stepUp, bearer: outcome.bearer };
        }
        noteEmailRefusal(target.sandboxId, outcome.refused);
        throw outcome.refused === EMAIL_SIGN_IN_OFF ? refusedByOwner() : new Error(emailRefusalText(outcome.refused));
    };

// The account's email road on the wall: offered where the daemon takes the assertion, a named gap where it is too old
// to and the account has no other way in. An account that also signs in with Google has Google there instead.
const emailRoadFor = (target: ScopedTarget, door: DaemonDoor, refusal: EmailRefusal | undefined): EmailRoad | undefined => {
    const ways = accountWaysIn.value;
    if (ways === undefined) {
        return undefined;
    }
    if (!takesEmailProof(door)) {
        return emailOnly(ways.methods) ? { kind: `outdated`, address: ways.email } : undefined;
    }
    const known = refusal === EMAIL_SIGN_IN_OFF || refusal === PLATFORM_KEY_UNKNOWN ? refusal : undefined;
    return { kind: `offered`, address: ways.email, spend: spendForWall(target), refusal: known };
};

// The owner ticket for an account with no Google sign-in: its refusal goes to the wall, never to Google's prompt.
const ticketWithoutGoogle = async (target: ScopedTarget, ticket: string, signal: AbortSignal): Promise<StoredSession | undefined> => {
    const minted = await exchange(target, ticket, signal);
    if (signal.aborted) {
        return undefined;
    }
    if (isSession(minted)) {
        return minted;
    }
    return minted !== `unauthorized` && `stepUp` in minted ? stepUp(target, sameBearer(ticket), minted.stepUp) : undefined;
};

// The assertion, spent where the daemon takes one: a session (or the step-up's), or the refusal it met. Undefined when
// the establishment was retired meanwhile, or a step-up was dismissed: there is nothing further to try then.
const assertionLink = async (target: ScopedTarget, signal: AbortSignal, withoutGoogle: boolean): Promise<StoredSession | Refused | undefined> => {
    // A refusal only the owner can lift is said again, not asked again, for a while.
    if (withoutGoogle && ownerRefusalHolds(target.sandboxId)) {
        throw refusedByOwner();
    }
    const outcome = await spendAssertion(target, signal);
    if (signal.aborted) {
        return undefined;
    }
    if (isSession(outcome)) {
        nudgePasskey(target.sandboxId);
        return outcome;
    }
    if (`stepUp` in outcome) {
        return stepUp(target, outcome.bearer, outcome.stepUp);
    }
    noteEmailRefusal(target.sandboxId, outcome.refused);
    // For an account with no other way in, this one is the no-access gate's to say (SandboxUnauthorized.vue).
    if (withoutGoogle && outcome.refused === EMAIL_SIGN_IN_OFF) {
        throw refusedByOwner();
    }
    return outcome;
};

// The owner ticket, the fourth link: for an account with no Google sign-in a refusal answers undefined, and the wall
// follows; any other account's refusal earns Google's one interactive retry, as it always has.
const ticketLink = async (target: ScopedTarget, signal: AbortSignal, withoutGoogle: boolean): Promise<StoredSession | `none` | undefined> => {
    const ticket = await ownerTicketFor(target, signal);
    if (ticket === undefined || signal.aborted) {
        return signal.aborted ? undefined : `none`;
    }
    if (!withoutGoogle) {
        return settleExchange(target, ticket, false, true, signal);
    }
    return (await ticketWithoutGoogle(target, ticket, signal)) ?? `none`;
};

// The proof chain's third, fourth and fifth links for an account that signs in by email: the platform's assertion
// where the daemon takes one, the owner ticket where it is too old to, then the wall.
const mintByEmail = async (target: ScopedTarget, signal: AbortSignal): Promise<StoredSession | undefined> => {
    const door = await daemonDoor(target);
    if (!door.answers || signal.aborted) {
        return undefined;
    }
    const withoutGoogle = emailOnly(accountWaysIn.value?.methods);
    let refusal: EmailRefusal | undefined;
    if (takesEmailProof(door)) {
        const spent = await assertionLink(target, signal, withoutGoogle);
        if (spent === undefined || signal.aborted) {
            return undefined;
        }
        if (!(`refused` in spent)) {
            return spent;
        }
        refusal = spent.refused;
    }
    const ticketed = await ticketLink(target, signal, withoutGoogle);
    if (ticketed !== `none`) {
        return ticketed;
    }
    return chooseAndSettle(target, signal, { road: emailRoadFor(target, door, refusal), withoutGoogle });
};

// One establishment's road to a session, along the proof chain (top of this file): a held Google proof exchanged, then
// for a foreground caller the email road, the owner ticket and the sign-in moment.
const mintSession = async (target: ScopedTarget, background: boolean, signal: AbortSignal): Promise<StoredSession | undefined> => {
    const held = await getIdToken({ interactive: false });
    if (signal.aborted) {
        return undefined;
    }
    if (held !== undefined) {
        return settleExchange(target, held, background, true, signal);
    }
    if (background) {
        return undefined;
    }
    if (target.platformVouch !== undefined && signsInByEmail(accountWaysIn.value?.methods)) {
        return mintByEmail(target, signal);
    }
    const ticket = await ownerTicketFor(target, signal);
    if (signal.aborted) {
        return undefined;
    }
    return ticket === undefined ? chooseAndSettle(target, signal) : settleExchange(target, ticket, false, true, signal);
};

// The sign-in moment: spends a proof (cached, a passkey, or freshly minted Google for a foreground caller) and
// exchanges it. Network or malformed-response failures are thrown, not swallowed: a daemon that can't mint a session is
// broken, not just old. One that was retired answers nothing and holds no cooldown: the sandbox did not fail.
const establish = async (target: ScopedTarget, background: boolean): Promise<SandboxBearer | undefined> => {
    const retired = retirementOf(target.sandboxId);
    try {
        const minted = await mintSession(target, background, retired);
        if (retired.aborted) {
            return undefined;
        }
        if (minted === undefined) {
            noteEstablishFailure(target.sandboxId);
            return undefined;
        }
        write(target.sandboxId, minted);
        return { token: minted.token, kind: `session` };
    } catch (error) {
        if (retired.aborted) {
            return undefined;
        }
        noteEstablishFailure(target.sandboxId);
        throw error;
    }
};

// One renewal per sandbox at a time; a caller meanwhile joins it. A failed renewal changes nothing: the session works
// until expiry, a real rejection re-establishes next call.
const renew = (target: SandboxTarget & { readonly sandboxId: string }, sessionToken: string): Promise<void> =>
    renewals.run(target.sandboxId, async () => {
        const retired = retirementOf(target.sandboxId);
        const minted = await exchange(target, sessionToken, retired);
        if (isSession(minted) && !retired.aborted) {
            write(target.sandboxId, minted);
        }
    });

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
    if (!background) {
        return pressing.run(target.sandboxId, () => establish(target, false));
    }
    const running = establishing(target.sandboxId);
    if (running !== undefined) {
        return running;
    }
    if (establishHolds(target.sandboxId)) {
        return Promise.resolve(undefined);
    }
    return polling.run(target.sandboxId, () => establish(target, true));
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
    if (previous === undefined || previous === id || establishing(previous) === undefined) {
        return;
    }
    if (id !== undefined && establishing(id) !== undefined) {
        return;
    }
    cancelSignIn();
    // The wall an account with no Google sign-in was shown has no Google mint to cancel: it is the prompt alone.
    const standing = signInPrompt.value;
    if (standing?.kind === `choose` && standing.withoutGoogle === true) {
        dismissSignIn();
    }
});

// Stores a session another ceremony minted for this browser: registering a passkey upgrades the session that asked,
// and keeping the upgraded one is what lets the owner switch the passkey rule on without being asked for it at once.
const adoptSession = (sandboxId: string, session: DaemonSession): void => write(sandboxId, storedOf(session));

// Drops the active sandbox's session (a 401, a rotated secret, an account switch); the next call re-establishes
// from a fresh Google proof.
const invalidateSession = (sandboxId = activeSandboxId.value, broadcast = true): void => {
    if (sandboxId === undefined) {
        return;
    }
    retire(sandboxId);
    const rest = { ...sessions.value };
    delete rest[sandboxId];
    sessions.value = rest;
    removeStoredValue(storageKey(sandboxId));
    if (broadcast) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
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
    for (const controller of retirements.values()) {
        controller.abort();
    }
    retirements.clear();
    sessions.value = {};
    for (const key of storedKeys(SESSION_KEY_PREFIX)) {
        removeStoredValue(key);
    }
    if (broadcast) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
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

const removalRequest = async (sandbox: SandboxSummary, base: string, bearer: string): Promise<Response> => {
    const route = sandbox.role === `owner` ? (`POST /system/access/disable` as const) : (`DELETE /members/self` as const);
    // allow(daemon-doors): aimed at the address of a sandbox that is not the active one, with that sandbox's own bearer, so
    // the active session and target the client carries would be the wrong ones.
    return fetch(`${base.replace(/\/$/, ``)}${rawRouteUrl(route)}`, {
        method: route.slice(0, route.indexOf(` `)),
        // A member's row carries no connect token, and the daemon it reaches is bound already: nothing to send.
        headers: { authorization: `Bearer ${bearer}`, ...(sandbox.token === null ? {} : { "x-intentic-connect": sandbox.token }) },
        signal: AbortSignal.timeout(10_000),
    });
};

// The proof to retire access with when this browser holds no live session there: Google's own for an account that has
// it, and for one with no Google sign-in a fresh session from the platform's identity assertion (the assertion opens
// only POST /system/session, so it is exchanged first rather than sent as the removal's bearer).
const removalProof = async (sandbox: SandboxSummary, base: string): Promise<string> => {
    if (!emailOnly(accountWaysIn.value?.methods)) {
        const idToken = await getIdToken();
        if (idToken === undefined) {
            throw new Error(t(`sandbox.sandboxSession.googleCanceled`));
        }
        return idToken;
    }
    const target: ScopedTarget = { sandboxId: sandbox.id, base: base.replace(/\/$/, ``), connectToken: sandbox.token ?? undefined };
    const outcome = await spendAssertion(target, retirementOf(sandbox.id));
    if (isSession(outcome)) {
        return outcome.token;
    }
    throw new Error(`stepUp` in outcome ? t(`sandbox.sandboxSession.passkeyFirst`) : emailRefusalText(outcome.refused));
};

// Takes this identity off one sandbox's own list: an owner's door is closed, a member's grant is given up. Throws when the
// daemon could not be asked or refused. The leave action and an account's deletion both end here.
const retireSandboxAccess = async (sandbox: SandboxSummary): Promise<void> => {
    // No address ever assigned means no daemon ever had browser access to retire.
    const base = sandbox.daemonUrl;
    if (base === null) {
        return;
    }
    const stored = sessions.value[sandbox.id] ?? readStored(sandbox.id);
    let bearer = stored !== undefined && Date.now() < stored.expiresAt - EXPIRY_MARGIN_MS ? stored.token : await removalProof(sandbox, base);
    let response = await removalRequest(sandbox, base, bearer);
    if (response.status === 401 && stored?.token === bearer) {
        invalidateSession(sandbox.id);
        bearer = await removalProof(sandbox, base);
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
    const failed = results.flatMap((result, index) => (result.status === `rejected` ? [sandboxes[index]?.name ?? t(`sandbox.sandboxSession.unknownSandbox`)] : []));
    if (failed.length > 0) {
        throw new Error(t(`sandbox.sandboxSession.accountNotDeleted`, { names: failed.join(`, `) }, failed.length));
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

// Why the active sandbox last refused an email sign-in, while it stands: the no-access gate names it
// (SandboxUnauthorized.vue), and its retry clears it so the next try asks the platform again at once.
const emailRefusal = computed<EmailRefusal | undefined>(() => {
    const sandboxId = activeSandboxId.value;
    return sandboxId === undefined ? undefined : emailRefusals.value[sandboxId]?.refusal;
});
const retryEmailSignIn = (sandboxId = activeSandboxId.value): void => {
    if (sandboxId !== undefined) {
        forgetEmailRefusal(sandboxId);
    }
};

// Who this browser's stored session on a sandbox names, while it is good: recovery's way to know the account when the
// platform cannot say (features/sandbox/recovery/directMode.ts).
const heldSessionEmail = (sandboxId: string): string | undefined => {
    const stored = sessions.value[sandboxId] ?? readStored(sandboxId);
    return stored !== undefined && Date.now() < stored.expiresAt - EXPIRY_MARGIN_MS ? stored.email : undefined;
};

export function useSandboxSession() {
    return {
        presentedEmail,
        sessionExpiresAt,
        emailRefusal,
        retryEmailSignIn,
        passkeyNudge,
        dismissPasskeyNudge,
        heldSessionEmail,
        getSessionToken,
        rejectSessionToken,
        adoptSession,
        invalidateSession,
        clearSessions,
        retireAccountAccess,
        retireSandboxAccess,
    };
}

// One session store and channel per window: a hot-reloaded copy would mint into an instance nothing reads.
reloadOnHotUpdate(import.meta);
