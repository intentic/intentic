import { z } from "zod";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import type { McpToolSchema } from "./browser-router.js";

// browser_wait_for given `time` with `text` (or `textGone`) sleeps the whole time upstream, then starts waiting for the
// text: a model asking "up to ten seconds for 'Saved'" got ten seconds always, and five more if it had not come
// (@playwright/mcp 0.0.83, wait.ts). The router sends it on as a text wait alone and sends it again until `time` has
// passed, so it answers the moment the text is there (2026-10-20). A single text wait is bounded by the backend's own
// action timeout (5s), so the wait can run that much past a shorter `time`, never past `time` plus one more.

const WAIT_FOR_TOOL = "browser_wait_for";

// Upstream's own ceiling on `time`, kept so a model cannot park a browser call longer through the rewrite.
const MAX_WAIT_S = 30;

// The arguments the rewrite reads; anything else the call carries rides along untouched.
const TimedTextWaitSchema = z
    .looseObject({ time: z.number().positive(), text: z.string().min(1).optional(), textGone: z.string().min(1).optional() })
    .refine((args) => args.text !== undefined || args.textGone !== undefined);

export interface BoundedWait {
    // The call as sent on: the same arguments less `time`.
    readonly params: NonNullable<RpcMessage["params"]>;
    // When to stop sending it again, epoch ms.
    readonly deadline: number;
}

/** A wait_for call naming both a time and a text, as the text wait it means; undefined for every other call. */
export const boundedWaitOf = (params: NonNullable<RpcMessage["params"]>, now = Date.now()): BoundedWait | undefined => {
    if (params["name"] !== WAIT_FOR_TOOL) {
        return undefined;
    }
    const parsed = TimedTextWaitSchema.safeParse(params["arguments"]);
    if (!parsed.success) {
        return undefined;
    }
    const { time, ...rest } = parsed.data;
    return { params: { ...params, arguments: rest }, deadline: now + Math.min(time, MAX_WAIT_S) * 1000 };
};

const TimedOutSchema = z.object({ isError: z.literal(true), content: z.array(z.looseObject({ text: z.string() })) });

/** Whether a backend answer is a text wait that ran out of time, the one failure worth sending the wait again for. */
export const waitTimedOut = (answer: RpcMessage): boolean => {
    const result = TimedOutSchema.safeParse(answer.result);
    return result.success && result.data.content.some((block) => /Timeout \d+ms exceeded/.test(block.text));
};

// What `time` means once the router has rewritten it, said where the model reads it.
const TIME_DESCRIPTION =
    `The time to wait in seconds, at most ${MAX_WAIT_S}. Alone, a pause that long. With text or textGone, the most to ` +
    "wait for it: the call returns as soon as the text appears (or goes).";

/** The listed wait_for schema, its `time` described as the router now treats it. */
export const describeBoundedWait = (tools: readonly McpToolSchema[]): McpToolSchema[] =>
    tools.map((tool) => {
        const schema = tool.inputSchema;
        const time = z.looseObject({}).safeParse(schema?.properties?.["time"]);
        if (tool.name !== WAIT_FOR_TOOL || schema === undefined || !time.success) {
            return tool;
        }
        return { ...tool, inputSchema: { ...schema, properties: { ...schema.properties, time: { ...time.data, description: TIME_DESCRIPTION } } } };
    });

/**
 * Sends a call on through `send`; a timed text wait goes as the text wait alone, again each time it runs out, until its
 * time has passed or the caller hangs up.
 */
export const sendBoundingWait = async (
    params: NonNullable<RpcMessage["params"]>,
    signal: AbortSignal | undefined,
    send: (params: NonNullable<RpcMessage["params"]>) => Promise<RpcMessage>,
): Promise<RpcMessage> => {
    const bounded = boundedWaitOf(params);
    if (bounded === undefined) {
        return send(params);
    }
    for (;;) {
        const answer = await send(bounded.params);
        if (!waitTimedOut(answer) || Date.now() >= bounded.deadline || signal?.aborted === true) {
            return answer;
        }
    }
};
