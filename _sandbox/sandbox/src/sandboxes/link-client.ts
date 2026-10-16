import {
    LINK_HEADER,
    type LinkAnswer,
    type LinkHello,
    type LinkMessage,
    type LinkMessageReceipt,
    type LinkTask,
    type LinkTaskStatus,
} from "@intentic/sandbox-contract/schemas/links";
import type { LinkConfig } from "@intentic/sandbox-contract/schemas/capabilities";
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
        return refusal.data.error;
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
    const init: RequestInit = { method: request.method, headers, signal: signal === undefined ? deadline : AbortSignal.any([deadline, signal]) };
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
        hold.after === undefined ? "" : `?${new URLSearchParams({ after: String(hold.after), wait: String(hold.waitS ?? LINK_POLL_WAIT_S) }).toString()}`;
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
