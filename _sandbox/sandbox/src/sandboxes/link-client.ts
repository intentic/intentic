import {
    LINK_HEADER,
    LINK_OPERATE_WAIT_S_MAX,
    type LinkAnswer,
    type LinkExec,
    type LinkExecStatus,
    type LinkRead as LinkFileRead,
    type LinkReadAnswer,
    type LinkHello,
    type LinkMessage,
    type LinkMessageReceipt,
    type LinkTask,
    type LinkTaskStatus,
    type LinkWrite,
    type LinkWriteAnswer,
} from "@intentic/sandbox-contract/schemas/links";
import type { LinkConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { DiagnosticsAnswer, DiagnosticsQuery } from "@intentic/sandbox-contract/schemas/diagnostics";
import type { LinkAccountCopy, LinkAccounts, SharedAccountRef } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type {
    RunnerCredential,
    RunnerCredentialRefresh,
    RunnerCredentialRefreshRequest,
    RunnerCredentialRequest,
} from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { RAW_JSON_ROUTES } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { z } from "zod";
import { opt } from "../opt.js";

// THE ASKING SIDE'S WIRE: this daemon calling another of the owner's sandboxes through the link doors it holds a token
// for (a `link` card). Here beside the fleet's client, below links/, since the card's own handler checks a link with it. Plain fetch on the routes' own paths and schemas (RAW_JSON_ROUTES), never a second spelling of
// either. The token rides one header and goes nowhere else: not into a log line, not into an answer.

// How long a call may take to answer, beyond any wait it asked the far side to hold it for.
const CALL_MS = 20_000;
// What the far side may hold a status read for; it holds no longer than its own ceiling (link-tasks.ts STATUS_WAIT_MAX_S).
export const LINK_POLL_WAIT_S = 25;

// One link card as the wire needs it.
export interface LinkTarget {
    readonly id: string;
    readonly config: LinkConfig;
}

// A call's answer: the far side's parsed answer, or why there is none. `status` 0 is no answer at all (offline, a dead
// address, a timeout), which says nothing about the link itself.
export type LinkAnswerOf<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: number; readonly message: string };

// What the far side says when it refuses: `{ error }` on every link door, a sentence written for the asking agent.
const RefusalSchema = z.object({ error: z.string().min(1) });

// A door the far side's build does not have yet is refused by its sign-in check, before any link door reads the token: a
// bare "unauthorized", where every link door words its own refusal (link-door.ts). Said as what it is, since "unauthorized"
// reads as a link that stopped working (knot-xwrx, 2026-11-11: records asked of a sandbox older than records over links).
const TOO_OLD_FOR_DOOR =
    "it runs a build too old for this: it refused the call as a sign-in it does not know, which is how a sandbox answers a link door it does not have yet. Updating that sandbox brings it";

const tooOld = (status: number, error: string | undefined): boolean => status === 401 && error === "unauthorized";

const refusalOf = async (response: Response): Promise<string> => {
    // allow(silent-catch): a refusal whose body cannot be read is still reported, by its status, below.
    const text = await response.text().catch(() => "");
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        // allow(silent-catch): a refusal that is not JSON (an edge's own page) is reported by its status below.
        body = undefined;
    }
    const refusal = RefusalSchema.safeParse(body);
    if (refusal.success) {
        return tooOld(response.status, refusal.data.error) ? TOO_OLD_FOR_DOOR : refusal.data.error;
    }
    return response.status === 404 && text.includes("no-tunnel") ? "it is not online" : `it answered ${response.status}`;
};

const call = async <T>(
    target: LinkTarget,
    request: { readonly method: string; readonly path: string; readonly body?: unknown; readonly schema: z.ZodType<T>; readonly holdS?: number },
    signal?: AbortSignal,
): Promise<LinkAnswerOf<T>> => {
    const deadline = AbortSignal.timeout(CALL_MS + (request.holdS ?? 0) * 1_000);
    const headers = new Headers({ [LINK_HEADER]: target.config.token });
    // A redirect is a refusal from the configured sandbox; its private link header must never travel to another target.
    const init: RequestInit = {
        method: request.method,
        headers,
        redirect: "manual",
        signal: signal === undefined ? deadline : AbortSignal.any([deadline, signal]),
    };
    if (request.body !== undefined) {
        headers.set("content-type", "application/json");
        init.body = JSON.stringify(request.body);
    }
    let response: Response;
    try {
        response = await fetch(new URL(request.path, target.config.url), init);
    } catch (error) {
        const why = error instanceof Error && error.name === "TimeoutError" ? "it did not answer in time" : "it could not be reached";
        return { ok: false, status: 0, message: `${why} (${error instanceof Error ? error.message : "no answer"})` };
    }
    if (!response.ok) {
        return { ok: false, status: response.status, message: await refusalOf(response) };
    }
    // allow(silent-catch): an answer that is not JSON fails the schema, which is reported as the far side being too old.
    const parsed = request.schema.safeParse(await response.json().catch(() => undefined));
    return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, status: 502, message: "its answer did not read as a link's: it may run a sandbox too old for links" };
};

/** GET /link: whether the link still works, and the terms the far side holds it to. */
export const linkHello = (target: LinkTarget, signal?: AbortSignal): Promise<LinkAnswerOf<LinkHello>> =>
    call(target, { method: "GET", path: rawRouteUrl("GET /link"), schema: RAW_JSON_ROUTES["GET /link"].output }, signal);

/** POST /link/conversations: one task, opening one conversation over there. */
export const linkAsk = (target: LinkTarget, task: LinkTask): Promise<LinkAnswerOf<LinkTaskStatus>> =>
    call(target, {
        method: "POST",
        path: rawRouteUrl("POST /link/conversations"),
        body: task,
        schema: RAW_JSON_ROUTES["POST /link/conversations"].output,
    });

/** GET /link/conversations/{id}: where it stands, held until it moves past `after` when one is named. */
export const linkStatus = (
    target: LinkTarget,
    conversationId: string,
    hold: { readonly after?: number; readonly waitS?: number } = {},
    signal?: AbortSignal,
): Promise<LinkAnswerOf<LinkTaskStatus>> => {
    const query =
        hold.after === undefined
            ? ""
            : `?${new URLSearchParams({ after: String(hold.after), wait: String(hold.waitS ?? LINK_POLL_WAIT_S) }).toString()}`;
    return call(
        target,
        {
            method: "GET",
            path: `${rawRouteUrl("GET /link/conversations/{id}", { id: conversationId })}${query}`,
            schema: RAW_JSON_ROUTES["GET /link/conversations/{id}"].output,
            ...opt("holdS", hold.after === undefined ? undefined : (hold.waitS ?? LINK_POLL_WAIT_S)),
        },
        signal,
    );
};

/** POST /link/conversations/{id}/messages */
export const linkMessage = (target: LinkTarget, conversationId: string, message: LinkMessage): Promise<LinkAnswerOf<LinkMessageReceipt>> =>
    call(target, {
        method: "POST",
        path: rawRouteUrl("POST /link/conversations/{id}/messages", { id: conversationId }),
        body: message,
        schema: RAW_JSON_ROUTES["POST /link/conversations/{id}/messages"].output,
    });

/** POST /link/conversations/{id}/answer */
export const linkAnswer = (target: LinkTarget, conversationId: string, answer: LinkAnswer): Promise<LinkAnswerOf<{ readonly ok: true }>> =>
    call(target, {
        method: "POST",
        path: rawRouteUrl("POST /link/conversations/{id}/answer", { id: conversationId }),
        body: answer,
        schema: RAW_JSON_ROUTES["POST /link/conversations/{id}/answer"].output,
    });

/** POST /link/conversations/{id}/stop */
export const linkStop = (target: LinkTarget, conversationId: string): Promise<LinkAnswerOf<LinkTaskStatus>> =>
    call(target, {
        method: "POST",
        path: rawRouteUrl("POST /link/conversations/{id}/stop", { id: conversationId }),
        schema: RAW_JSON_ROUTES["POST /link/conversations/{id}/stop"].output,
    });

/* An accounts link's doors (schemas/providers/account-sharing.ts): read by the borrowing side's daemon, never a browser. */

/** GET /link/accounts: what the link may use, with the lending side's usage readings. */
export const linkAccounts = (target: LinkTarget, signal?: AbortSignal): Promise<LinkAnswerOf<LinkAccounts>> =>
    call(target, { method: "GET", path: rawRouteUrl("GET /link/accounts"), schema: RAW_JSON_ROUTES["GET /link/accounts"].output }, signal);

/** POST /link/accounts/copy: one static account's value, which only this daemon ever reads. */
export const linkAccountCopy = (target: LinkTarget, ref: SharedAccountRef): Promise<LinkAnswerOf<LinkAccountCopy>> =>
    call(target, {
        method: "POST",
        path: rawRouteUrl("POST /link/accounts/copy"),
        body: ref,
        schema: RAW_JSON_ROUTES["POST /link/accounts/copy"].output,
    });

/** POST /link/credentials: a lent sign-in's access token for one turn, the runner door's own shapes. */
export const linkCredential = (target: LinkTarget, request: RunnerCredentialRequest): Promise<LinkAnswerOf<RunnerCredential>> =>
    call(target, {
        method: "POST",
        path: rawRouteUrl("POST /link/credentials"),
        body: request,
        schema: RAW_JSON_ROUTES["POST /link/credentials"].output,
    });

/** POST /link/credentials/refresh: a fresh access token in place of the one a provider refused mid-turn. */
export const linkCredentialRefresh = (target: LinkTarget, request: RunnerCredentialRefreshRequest): Promise<LinkAnswerOf<RunnerCredentialRefresh>> =>
    call(target, {
        method: "POST",
        path: rawRouteUrl("POST /link/credentials/refresh"),
        body: request,
        schema: RAW_JSON_ROUTES["POST /link/credentials/refresh"].output,
    });

/* A link's records doors (schemas/links.ts `records`): read by the asking side's daemon for its agent's `--on <link>`. */

// A records read relayed as the far side answered it, status and body, so the asking agent reads that sandbox's own
// refusal (an unknown handle, an ambiguous one with its candidates) exactly as it would read this one's.
// The body as JSON, kept whole: the fleet reads have no shared schema, and the asking command prints them as they came.
// Only the two fields a refusal words itself with are read here.
const RecordsBodySchema = z.looseObject({ error: z.string().optional(), message: z.string().optional() });
export type LinkRecordsBody = z.infer<typeof RecordsBodySchema>;
export type LinkRead =
    | { readonly ok: true; readonly status: number; readonly body: LinkRecordsBody }
    | { readonly ok: false; readonly status: 0; readonly message: string };

/** GET /link/records/fleet…: one of the fleet reads, its path and query already spelled. */
export const linkRecordsRead = async (target: LinkTarget, path: string): Promise<LinkRead> => {
    try {
        const response = await fetch(new URL(path, target.config.url), {
            headers: { [LINK_HEADER]: target.config.token },
            redirect: "manual",
            signal: AbortSignal.timeout(CALL_MS * 3),
        });
        // allow(silent-catch): an answer that is not JSON is relayed as its status alone.
        const parsed = RecordsBodySchema.safeParse(await response.json().catch(() => undefined));
        const body = parsed.success ? parsed.data : { error: `it answered ${response.status}` };
        return { ok: true, status: response.status, body: tooOld(response.status, body.error) ? { error: TOO_OLD_FOR_DOOR } : body };
    } catch (error) {
        const why = error instanceof Error && error.name === "TimeoutError" ? "it did not answer in time" : "it could not be reached";
        return { ok: false, status: 0, message: `${why} (${error instanceof Error ? error.message : "no answer"})` };
    }
};

/** POST /link/records/diagnostics: one diagnostics query of the linked sandbox's records. */
export const linkRecordsDiagnostics = (target: LinkTarget, query: DiagnosticsQuery): Promise<LinkAnswerOf<DiagnosticsAnswer>> =>
    call(target, {
        method: "POST",
        path: rawRouteUrl("POST /link/records/diagnostics"),
        body: query,
        schema: RAW_JSON_ROUTES["POST /link/records/diagnostics"].output,
    });

/* A link's operating doors (schemas/links.ts `operate`): this daemon running commands and reading and writing files in
   the linked sandbox for its agent, while that sandbox's owner lets the link operate it. */

// What a read or a write may be held for: the far side answers either whole within its own bound (link-operate.ts).
const FILE_HOLD_S = 30;

/** POST /link/operate/exec: one command started over there, answered once it ends or `waitS` passes. */
export const linkExec = (target: LinkTarget, exec: LinkExec, signal?: AbortSignal): Promise<LinkAnswerOf<LinkExecStatus>> =>
    call(
        target,
        { method: "POST", path: rawRouteUrl("POST /link/operate/exec"), body: exec, schema: RAW_JSON_ROUTES["POST /link/operate/exec"].output, holdS: exec.waitS },
        signal,
    );

/** GET /link/operate/exec/{id}: where that command stands, held until it ends or `waitS` passes. */
export const linkExecStatus = (target: LinkTarget, id: string, waitS: number = LINK_OPERATE_WAIT_S_MAX, signal?: AbortSignal): Promise<LinkAnswerOf<LinkExecStatus>> =>
    call(
        target,
        {
            method: "GET",
            path: `${rawRouteUrl("GET /link/operate/exec/{id}", { id })}?${new URLSearchParams({ wait: String(waitS) }).toString()}`,
            schema: RAW_JSON_ROUTES["GET /link/operate/exec/{id}"].output,
            holdS: waitS,
        },
        signal,
    );

/** POST /link/operate/exec/{id}/stop */
export const linkExecStop = (target: LinkTarget, id: string): Promise<LinkAnswerOf<LinkExecStatus>> =>
    call(target, {
        method: "POST",
        path: rawRouteUrl("POST /link/operate/exec/{id}/stop", { id }),
        schema: RAW_JSON_ROUTES["POST /link/operate/exec/{id}/stop"].output,
        holdS: 5,
    });

/** POST /link/operate/read: a file's lines, or a directory's listing. */
export const linkFileRead = (target: LinkTarget, read: LinkFileRead, signal?: AbortSignal): Promise<LinkAnswerOf<LinkReadAnswer>> =>
    call(
        target,
        { method: "POST", path: rawRouteUrl("POST /link/operate/read"), body: read, schema: RAW_JSON_ROUTES["POST /link/operate/read"].output, holdS: FILE_HOLD_S },
        signal,
    );

/** POST /link/operate/write: a file's whole new contents. */
export const linkFileWrite = (target: LinkTarget, write: LinkWrite, signal?: AbortSignal): Promise<LinkAnswerOf<LinkWriteAnswer>> =>
    call(
        target,
        { method: "POST", path: rawRouteUrl("POST /link/operate/write"), body: write, schema: RAW_JSON_ROUTES["POST /link/operate/write"].output, holdS: FILE_HOLD_S },
        signal,
    );
