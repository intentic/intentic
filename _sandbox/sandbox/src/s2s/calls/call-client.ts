import { parseJsonOr } from "@intentic/base/json";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { confirmsSession, createReplayWindow, openCall, openSession, type RandomBytes, type ReplayWindow, type SessionKey, sealCall } from "@intentic/sandbox-contract/s2s";
import {
    S2S_CALLS,
    S2S_SESSION_HEADER,
    S2sCallAnswerSchema,
    type S2sCallInput,
    type S2sCallMethod,
    type S2sCallOutput,
    S2sCallSealedSchema,
    S2sRefusalSchema,
    S2sSessionAnswerSchema,
} from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { ContactRow } from "../contacts/contacts-store.js";
import type { S2sIdentity } from "../identity/s2s-identity.js";
import type { S2sFetch } from "../messages/outbox.js";

/* THE CALLS CLIENT, the caller's half (docs/architecture/messages.md, "Calls"): one session per contact, opened on first
 * need with one hybrid signature and kept until a minute before it expires, so every call after costs a symmetric seal.
 * A session is opened again when the contact's pinned key or this sandbox's own changed (`rotated`), and once, then the
 * call asked again, when the callee says it holds no such session (it restarted, or its key changed). Nothing is
 * stored or retried past that: a call is answered now or said as not answered. */

// What a call came to: the method's output, or why not. `status` 0 is no answer at all; `body` is the far side's own
// refusal as it sent it (a fleet read's candidates, say), when it sent one.
export type CallResult<M extends S2sCallMethod> =
    | { readonly ok: true; readonly value: S2sCallOutput<M> }
    | { readonly ok: false; readonly status: number; readonly message: string; readonly code?: string; readonly body?: unknown };

export type CallContact = <M extends S2sCallMethod>(row: ContactRow, method: M, input: S2sCallInput<M>, signal?: AbortSignal) => Promise<CallResult<M>>;

export interface CallClient {
    readonly call: CallContact;
    // Every session forgotten: this sandbox's key changed.
    readonly rotated: () => void;
    // How many sessions this side opened, for a suite to count signatures.
    readonly opened: () => number;
}

export interface CallClientDeps {
    readonly identity: () => Pick<S2sIdentity, "current" | "document">;
    readonly urlOf: (host: string) => string;
    readonly fetch: S2sFetch;
    // Why a host is no address to call (s2s-wiring.ts hostProblem), or undefined.
    readonly hostProblem: (host: string) => string | undefined;
    readonly now: () => number;
    readonly random?: RandomBytes;
}

// How long before its end a session is let go rather than used, and how long one call may take beyond what it holds.
const REOPEN_MARGIN_MS = 60_000;
const CALL_MS = 60_000;
const OPEN_MS = 20_000;

interface OpenSession {
    readonly id: string;
    readonly key: SessionKey;
    readonly expiresAt: number;
    // The callee's key it was opened to: a contact that rotated since is opened to again.
    readonly theirFp: string;
    readonly replay: ReplayWindow;
}

type Failure = { readonly ok: false; readonly status: number; readonly message: string; readonly code?: string; readonly body?: unknown };

const RefusalBodySchema = z.looseObject({ error: z.string().optional(), message: z.string().optional() });

// What a far answer that is not a call's says: its refusal in words, or what its status means.
const failureOf = async (response: Response): Promise<Failure> => {
    // allow(silent-catch): a refusal whose body cannot be read is still reported, by its status.
    const text = await response.text().catch(() => "");
    const refusal = S2sRefusalSchema.safeParse(parseJsonOr(text, undefined));
    if (refusal.success) {
        return { ok: false, status: response.status, message: refusal.data.error, code: refusal.data.code };
    }
    if (response.status === 501 || response.status === 401) {
        return { ok: false, status: response.status, message: "it runs a build from before calls between contacts: updating that sandbox brings them" };
    }
    return { ok: false, status: response.status, message: response.status === 404 && text.includes("no-tunnel") ? "it is not online" : `it answered ${response.status}` };
};

const unreached = (error: Error | undefined): Failure => {
    const why = error?.name === "TimeoutError" ? "it did not answer in time" : "it could not be reached: it may be asleep or offline";
    return { ok: false, status: 0, message: `${why} (${error?.message ?? "no answer"})` };
};

// One POST of a JSON body already spelled.
const post = async (deps: CallClientDeps, url: string, json: string, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<Response | Failure> => {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
        return await deps.fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: json,
            // A session's id and a call go to the contact's own host and nowhere else.
            redirect: "error",
            signal: signal === undefined ? deadline : AbortSignal.any([deadline, signal]),
        });
    } catch (error) {
        return unreached(error instanceof Error ? error : undefined);
    }
};

// What a method may hold the far side for at most, in seconds (a status wait, a file read or written): the call's deadline
// is past it.
const HOLD_S = {
    "records.fleet": 0,
    "records.show": 0,
    "records.bundle": 0,
    "records.diagnostics": 0,
    "operate.exec": 25,
    "operate.status": 25,
    "operate.stop": 5,
    "operate.read": 30,
    "operate.write": 30,
    "task.watch": 25,
} as const satisfies Record<S2sCallMethod, number>;

export const createCallClient = (deps: CallClientDeps): CallClient => {
    const sessions = new Map<string, Promise<OpenSession | Failure>>();
    let opens = 0;

    const openFor = async (row: ContactRow): Promise<OpenSession | Failure> => {
        const identity = deps.identity();
        const [caller, document] = await Promise.all([identity.current(), identity.document()]);
        const { request, key } = openSession({
            from: document.host,
            to: row.address,
            as: row.scope.kind === "person" ? row.scope.person : undefined,
            caller,
            callee: row.document.keys,
            now: deps.now(),
            ...opt("random", deps.random),
        });
        opens += 1;
        const response = await post(deps, `${deps.urlOf(row.document.host)}${rawRouteUrl("POST /s2s/session")}`, JSON.stringify(request), {}, OPEN_MS);
        if (!(response instanceof Response)) {
            return response;
        }
        if (response.status !== 200) {
            return failureOf(response);
        }
        const answer = S2sSessionAnswerSchema.safeParse(parseJsonOr(await response.text(), undefined));
        if (!answer.success || !confirmsSession(key, answer.data.session, answer.data.confirm)) {
            return { ok: false, status: 502, message: "it did not prove it holds the key this sandbox pinned for it: no call goes over that session" };
        }
        return { id: answer.data.session, key, expiresAt: answer.data.expiresAt, theirFp: row.document.fingerprint, replay: createReplayWindow() };
    };

    // The contact's session, opened again when it is near its end or the contact's key changed; a failed open is not kept.
    const sessionFor = async (row: ContactRow, fresh: boolean): Promise<OpenSession | Failure> => {
        const held = fresh ? undefined : await sessions.get(row.id);
        if (held !== undefined && !("ok" in held) && held.theirFp === row.document.fingerprint && held.expiresAt - deps.now() > REOPEN_MARGIN_MS) {
            return held;
        }
        const opening = openFor(row);
        sessions.set(row.id, opening);
        const opened = await opening;
        if ("ok" in opened && sessions.get(row.id) === opening) {
            sessions.delete(row.id);
        }
        return opened;
    };

    const callOnce = async <M extends S2sCallMethod>(row: ContactRow, session: OpenSession, method: M, input: S2sCallInput<M>, signal?: AbortSignal): Promise<CallResult<M>> => {
        const sealed = sealCall(session.key, { session: session.id, method, leg: { direction: "call" } }, input, deps.now(), deps.random);
        const url = `${deps.urlOf(row.document.host)}${rawRouteUrl("POST /s2s/call/{method}", { method })}`;
        const response = await post(deps, url, JSON.stringify(sealed), { [S2S_SESSION_HEADER]: session.id }, CALL_MS + HOLD_S[method] * 1_000, signal);
        if (!(response instanceof Response)) {
            return response;
        }
        if (response.status !== 200) {
            return failureOf(response);
        }
        const answerSealed = S2sCallSealedSchema.safeParse(parseJsonOr(await response.text(), undefined));
        const opened = answerSealed.success
            ? openCall(session.key, { session: session.id, method, leg: { direction: "answer", re: sealed.nonce } }, answerSealed.data, deps.now(), session.replay)
            : undefined;
        const answer = opened?.ok === true ? S2sCallAnswerSchema.safeParse(parseJsonOr(opened.json, undefined)) : undefined;
        if (answer?.success !== true) {
            return { ok: false, status: 502, message: "its answer does not open under this session as the answer to this call" };
        }
        if (answer.data.status !== 200) {
            const words = RefusalBodySchema.safeParse(answer.data.body).data;
            return { ok: false, status: answer.data.status, message: words?.error ?? words?.message ?? `it answered ${answer.data.status}`, body: answer.data.body };
        }
        const schema: z.ZodType = S2S_CALLS[method].output;
        const value = schema.safeParse(answer.data.body);
        // SAFETY: read by `method`'s own output schema (S2S_CALLS), which is what S2sCallOutput<M> names.
        return value.success ? { ok: true, value: value.data as S2sCallOutput<M> } : { ok: false, status: 502, message: `its answer does not read as ${method}'s` };
    };

    const call: CallContact = async (row, method, input, signal) => {
        const unreachable = deps.hostProblem(row.document.host);
        if (unreachable !== undefined) {
            return { ok: false, status: 403, message: `${row.document.host} is no address this sandbox calls: ${unreachable}` };
        }
        const session = await sessionFor(row, false);
        if ("ok" in session) {
            return session;
        }
        const first = await callOnce(row, session, method, input, signal);
        if (first.ok || first.code !== "session") {
            return first;
        }
        // It holds no such session any more (it restarted, or a key changed): one more, on a new one.
        const again = await sessionFor(row, true);
        return "ok" in again ? again : callOnce(row, again, method, input, signal);
    };

    return {
        call,
        rotated: () => sessions.clear(),
        opened: () => opens,
    };
};
