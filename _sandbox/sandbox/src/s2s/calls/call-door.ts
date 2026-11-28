import { randomBytes } from "node:crypto";
import { parseJsonOr } from "@intentic/base/json";
import type { PassScope } from "@intentic/sandbox-contract/protocol/doors/pass-scopes";
import { acceptSession, openCall, type RandomBytes, type SessionAccepted, sealCall, sessionConfirm } from "@intentic/sandbox-contract/s2s";
import {
    S2S_CALLS,
    S2S_REFUSAL_STATUS,
    type S2sCallAnswer,
    type S2sCallMethod,
    type S2sCallSealed,
    type S2sRefusal,
    type S2sRefusalCode,
    type S2sSessionAnswer,
    type S2sSessionOpen,
} from "@intentic/sandbox-contract/schemas/s2s";
import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { Logger } from "pino";
import type { z } from "zod";
import type { Caller } from "../../auth/auth.js";
import { opt } from "../../opt.js";
import type { AdmitRefusal, S2sAdmission } from "../admission.js";
import type { ContactRow, ContactsStore } from "../contacts/contacts-store.js";
import type { S2sIdentity } from "../identity/s2s-identity.js";
import { type CallSessions, callSessions, type HeldSession } from "./call-sessions.js";

/* THE CALLS DOOR, the callee's half (docs/architecture/messages.md, "Calls"): records and operating between contacts, as
 * request and response under a session key, nothing stored or retried.
 * - A SESSION (`open`): the request's addressee is this sandbox; its contact is found, its signature checked against the
 *   pinned key, a changed key put through the rotation table, as an envelope's are (the one admission's parts,
 *   admission.ts); its time within the skew and its nonce never seen. The answer is the session's id and `confirm`, the
 *   proof this side derived the same key. Sessions are held in memory (call-sessions.ts).
 * - A CALL (`call`): its session, still the contact's under the key it opened with; its body opened under the session key
 *   for this session, this method and the call leg, its nonce never seen in the session and its time within the skew; the
 *   method's grant on the contact; for a person-scoped contact, that person on the roster above the method's floor
 *   (records cut to what they may read, diagnostics a maintainer's, operating never). The method answers (`serve`,
 *   registered above this module: links/contacts/contact-calls.ts), and the answer is sealed bound to the call's nonce,
 *   its status inside, so the edge reads nothing of it. Each call is logged with the contact's name.
 * A refusal before a call is opened (or of its grant) is answered in the clear, in words, never 401. */

// A method's input once its schema read it.
export type S2sCallParsed<M extends S2sCallMethod> = z.output<(typeof S2S_CALLS)[M]["input"]>;

// Who a call is for: the contact its session was opened over, and a person-scoped contact's person as the roster has them now.
export interface CallCaller {
    readonly row: ContactRow;
    readonly person?: Caller | undefined;
}

export type CallHandler<M extends S2sCallMethod> = (input: S2sCallParsed<M>, caller: CallCaller, signal: AbortSignal) => Promise<S2sCallAnswer>;
export type CallHandlers = { readonly [M in S2sCallMethod]?: CallHandler<M> };

// What the door answers: the session or the sealed answer, or a refusal in words.
export type CallDoorAnswer<T> = { readonly status: 200; readonly body: T } | { readonly status: (typeof S2S_REFUSAL_STATUS)[S2sRefusalCode]; readonly body: S2sRefusal };

export interface CallDoorDeps {
    readonly identity: () => Pick<S2sIdentity, "addresses" | "openWith">;
    readonly admission: Pick<S2sAdmission, "contactFor" | "signerOf" | "grantRefusal" | "floorRefusal">;
    readonly contacts: Pick<ContactsStore, "get">;
    readonly roster: () => Promise<{ readonly callerOf: (email: string) => Caller | undefined }>;
    readonly now: () => number;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly random?: RandomBytes;
}

export interface CallDoor {
    // POST /s2s/session.
    readonly open: (request: S2sSessionOpen) => Promise<CallDoorAnswer<S2sSessionAnswer>>;
    // POST /s2s/call/{method}, the session as its header named it.
    readonly call: (session: string, method: string, sealed: S2sCallSealed, signal: AbortSignal) => Promise<CallDoorAnswer<S2sCallSealed>>;
    // Adds methods' handlers; answers their removal.
    readonly serve: (handlers: CallHandlers) => () => void;
    // Ends every session: this sandbox's key changed.
    readonly forget: () => void;
    // How many sessions are held now.
    readonly held: () => number;
}

type Refused = Extract<CallDoorAnswer<never>, { readonly body: S2sRefusal }>;

const refusal = (code: S2sRefusalCode, error: string): Refused => ({ status: S2S_REFUSAL_STATUS[code], body: { error, code } });
const fromAdmission = (refused: AdmitRefusal): Refused => refusal(refused.code, refused.error);
const isRefused = <T extends object>(value: T | Refused): value is Refused => "status" in value && value.status !== 200;

const isCallMethod = (method: string): method is S2sCallMethod => Object.hasOwn(S2S_CALLS, method);

// The pass scope a person-scoped contact's person is held to for a method, the floor reads and tasks have as a route.
const floorOf = (method: S2sCallMethod): PassScope => (S2S_CALLS[method].grant === "task" ? "task" : "read");

const STALE = "its time is more than two minutes from this sandbox's clock: check the clock, then ask again";

// A session request's own verdict, past its signature, as a refusal.
const acceptedRefusal = (accepted: Extract<SessionAccepted, { ok: false }>): Refused => {
    switch (accepted.reason) {
        case "stale":
            return refusal("replay", `the session request is stale: ${STALE}`);
        case "recipient":
            return refusal("recipient", "the session request is sealed to no key this sandbox holds: fetch its identity again");
        case "malformed":
            return refusal("malformed", "the session request's key agreement does not open");
        default:
            return refusal("signature", "the session request's signature does not verify against the key this sandbox pinned for you");
    }
};

// A contact that no longer stands for a session: why, in words.
const standingRefusal = (row: ContactRow | undefined): Refused | undefined => {
    if (row === undefined) {
        return refusal("not_contact", "your sandbox is not a contact of this one any more");
    }
    if (row.state === "key-changed") {
        return refusal("key_changed", `${row.address}'s key changed with no proof: a person here must trust the new key first`);
    }
    return row.state === "accepted" ? undefined : refusal("not_contact", "this sandbox has not accepted yours as a contact");
};

const nameOf = (row: ContactRow): string => row.name ?? row.document.name;

// One call's method and its input as that method's schema read it.
type ParsedCall = { readonly [M in S2sCallMethod]: { readonly method: M; readonly input: S2sCallParsed<M> } }[S2sCallMethod];

const parsedCall = (method: S2sCallMethod, json: string): ParsedCall | S2sCallAnswer => {
    const schema: z.ZodType = S2S_CALLS[method].input;
    const parsed = schema.safeParse(parseJsonOr(json, undefined));
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { status: 400, body: { error: `not a ${method} call: ${issue === undefined ? "unreadable" : `${issue.path.join(".")} ${issue.message}`}` } };
    }
    // SAFETY: `parsed.data` is what `method`'s own input schema (S2S_CALLS) read.
    return { method, input: parsed.data } as ParsedCall;
};

// What one call asked, for the log line beside the contact's name: operating calls log their own (links/link-operate.ts).
const summaryOf = (call: ParsedCall): string | undefined => {
    switch (call.method) {
        case "records.fleet":
            return call.input.q === undefined ? "roster" : `search "${call.input.q.slice(0, 80)}"`;
        case "records.show":
            return `show ${call.input.handle}`;
        case "records.bundle":
            return `bundle ${call.input.handle}`;
        case "records.diagnostics":
            return `diagnostics ${call.input.query}`;
        case "task.watch":
            return `watch ${call.input.task}`;
        default:
            return undefined;
    }
};

// A call handed to its method's handler; one that throws is said in words rather than lost.
const dispatched = async <M extends S2sCallMethod>(
    deps: Pick<CallDoorDeps, "logger">,
    handlers: CallHandlers,
    call: { readonly method: M; readonly input: S2sCallParsed<M> },
    caller: CallCaller,
    signal: AbortSignal,
): Promise<S2sCallAnswer> => {
    const handler: CallHandler<M> | undefined = handlers[call.method];
    if (handler === undefined) {
        return { status: 503, body: { error: `this sandbox does not answer ${call.method} yet` } };
    }
    try {
        return await handler(call.input, caller, signal);
    } catch (error) {
        deps.logger.warn({ err: error, contact: caller.row.id, method: call.method }, "contact: a call failed");
        return { status: 500, body: { error: `${call.method} failed here` } };
    }
};

// POST /s2s/session: the contact, its signature through the one admission's signer, the request's time and nonce.
const sessionOpener =
    (deps: CallDoorDeps, sessions: CallSessions, random: RandomBytes) =>
    async (request: S2sSessionOpen): Promise<CallDoorAnswer<S2sSessionAnswer>> => {
        const identity = deps.identity();
        const [addresses, keys] = await Promise.all([identity.addresses(), identity.openWith()]);
        if (!addresses.includes(request.to)) {
            return refusal("recipient", `this sandbox is not ${request.to}: fetch its identity again`);
        }
        const lookup = await deps.admission.contactFor(request.from, request.as, request.fromFp, "session");
        if (lookup.kind === "refused") {
            return fromAdmission(lookup);
        }
        // A blocked sender is told no more than a stranger: a call is answered or it is not, so nothing can be pretended.
        const row = lookup.kind === "contact" ? lookup.row : undefined;
        const standing = row === undefined ? refusal("not_contact", "your sandbox is not a contact of this one: ask to be one first (a contact request)") : standingRefusal(row);
        if (standing !== undefined || row === undefined) {
            return standing ?? refusal("not_contact", "your sandbox is not a contact of this one");
        }
        // The signature is the one admission's to check (the rotation table for a changed key); what accepting the request
        // found past its signature is kept for below.
        let accepted: SessionAccepted | undefined;
        const signer = await deps.admission.signerOf(row, request.fromFp, (callerKeys) => {
            accepted = acceptSession(request, { caller: callerKeys, keys, now: deps.now() });
            return accepted.ok || accepted.reason !== "signature";
        });
        if (signer.kind === "refused") {
            return fromAdmission(signer);
        }
        if (accepted === undefined || !accepted.ok) {
            return acceptedRefusal(accepted ?? { ok: false, reason: "signature" });
        }
        if (sessions.requestSeen(request.nonce, request.at)) {
            return refusal("replay", "this session request was seen before: make a new one");
        }
        const held = sessions.add({ key: accepted.key, contact: row.id, callerFp: signer.value.fingerprint }, random);
        deps.logger.info({ contact: row.id, name: nameOf(row), address: row.address, ...opt("person", request.as), session: held.id }, "contact: call session opened");
        return { status: 200, body: { session: held.id, expiresAt: held.expiresAt, confirm: sessionConfirm(accepted.key, held.id) } };
    };

// The session a call names, while its contact still stands under the key it opened with.
const sessionFor = async (deps: CallDoorDeps, sessions: CallSessions, id: string): Promise<{ readonly session: HeldSession; readonly row: ContactRow } | Refused> => {
    const session = sessions.get(id);
    if (session === undefined) {
        return refusal("session", "this sandbox holds no such session: it expired, this sandbox restarted, or its key changed. Open a new one");
    }
    const row = await deps.contacts.get(session.contact);
    const standing = standingRefusal(row);
    if (standing !== undefined || row === undefined) {
        sessions.drop(id);
        return standing ?? refusal("not_contact", "your sandbox is not a contact of this one any more");
    }
    if (row.document.fingerprint !== session.callerFp) {
        sessions.drop(id);
        return refusal("session", "your key changed since this session opened: open a new one");
    }
    return { session, row };
};

// The method's grant, and for a person-scoped contact its person above the method's floor; the person when there is one.
const allowedFor = async (deps: CallDoorDeps, row: ContactRow, method: S2sCallMethod): Promise<CallCaller | Refused> => {
    const ungranted = deps.admission.grantRefusal(row, method);
    if (ungranted !== undefined) {
        return fromAdmission(ungranted);
    }
    if (row.scope.kind !== "person") {
        return { row };
    }
    if (S2S_CALLS[method].grant === "operate") {
        return refusal("grant", "a person's own contact never operates this sandbox: only the sandbox's own contact may, under its operate grant");
    }
    const below = await deps.admission.floorRefusal(row, floorOf(method));
    if (below !== undefined) {
        return fromAdmission(below);
    }
    const person = (await deps.roster()).callerOf(row.scope.person);
    if (method === "records.diagnostics" && (person === undefined || !tierAtLeast(person.tier, "maintainer"))) {
        return refusal("floor", `${row.scope.person} may not read this sandbox's diagnostics: they are for its owner and its maintainers`);
    }
    return { row, person };
};

// POST /s2s/call/{method}: the session, the call opened under it, the grant and the floor, then the method, sealed back.
const caller =
    (deps: CallDoorDeps, sessions: CallSessions, handlers: () => CallHandlers, random: RandomBytes) =>
    async (id: string, method: string, sealed: S2sCallSealed, signal: AbortSignal): Promise<CallDoorAnswer<S2sCallSealed>> => {
        if (!isCallMethod(method)) {
            return refusal("unknown_kind", `this sandbox does not know the call ${method}`);
        }
        const found = await sessionFor(deps, sessions, id);
        if (isRefused(found)) {
            return found;
        }
        const { session, row } = found;
        const opened = openCall(session.key, { session: id, method, leg: { direction: "call" } }, sealed, deps.now(), session.replay);
        if (!opened.ok) {
            return opened.reason === "decrypt"
                ? refusal("signature", `the call does not open under this session's key as ${method}`)
                : refusal("replay", opened.reason === "stale" ? `the call is stale: ${STALE}` : "this call was seen before in this session");
        }
        const who = await allowedFor(deps, row, method);
        if (isRefused(who)) {
            return who;
        }
        const call = parsedCall(method, opened.json);
        let answer: S2sCallAnswer;
        if ("status" in call) {
            answer = call;
        } else {
            deps.logger.info({ contact: row.id, name: nameOf(row), address: row.address, ...opt("person", who.person?.email), method, ...opt("read", summaryOf(call)) }, "contact: call");
            answer = await dispatched(deps, handlers(), call, who, signal);
        }
        return { status: 200, body: sealCall(session.key, { session: id, method, leg: { direction: "answer", re: sealed.nonce } }, answer, deps.now(), random) };
    };

export const createCallDoor = (deps: CallDoorDeps): CallDoor => {
    const random = deps.random ?? ((length: number) => new Uint8Array(randomBytes(length)));
    const sessions = callSessions(deps.now);
    let handlers: CallHandlers = {};
    return {
        open: sessionOpener(deps, sessions, random),
        call: caller(deps, sessions, () => handlers, random),
        serve: (added) => {
            handlers = { ...handlers, ...added };
            return () => {
                handlers = Object.fromEntries(Object.entries(handlers).filter(([method]) => !Object.hasOwn(added, method)));
            };
        },
        forget: () => sessions.clear(),
        held: () => sessions.size(),
    };
};
