import { z } from "zod";
import { opt } from "../opt.js";
import type { MountCall } from "../agent/tools/turn-mounts.routes.js";
import type { RpcMessage } from "../agent/tools/turn-mounts.js";
import { WEBEXT_CLIENT_TIMEOUT_MS } from "../peers/webext-call-deadline.js";

// A browser call for a turn whose runtime's MCP client stops waiting sooner than a browser call can take
// (MountCall.clientCeilingMs; Cursor's client gives up at 60 s and its configuration has no field to say otherwise). Such
// a call is not left to die mid-wait with nothing said: wait_for is shortened to fit, with a line saying so.
// (2026-11-26) The ChatGPT kit's tools, which this shortened and refused too, are the chatgpt extension's now
// (_extensions/chatgpt): through this door they are the browser's own tools, passed as they come like any other.

// What the browser needs past a wait to read the page and answer: the wait is cut this much short of the client's limit.
const ANSWER_MARGIN_MS = 10_000;

const CallSchema = z.looseObject({ name: z.string(), arguments: z.looseObject({}).catch({}).default({}) });
const ResultSchema = z.looseObject({ content: z.array(z.unknown()) });
const WaitArgsSchema = z.looseObject({ seconds: z.number().catch(15).default(15), quietFor: z.number().optional().catch(undefined) });

// What fitting a call to the client did: passed it as it was, or shortened it (and what to tell the agent).
export type FittedCall = { readonly kind: "as-is" } | { readonly kind: "shortened"; readonly message: RpcMessage; readonly note: string };

const seconds = (ms: number): number => Math.round(ms / 1000);

// The call as the turn's client can wait for it.
export const fitToClient = (message: RpcMessage, call: Pick<MountCall, "clientCeilingMs">): FittedCall => {
    const ceiling = call.clientCeilingMs;
    const called = message.method === "tools/call" ? CallSchema.safeParse(message.params) : undefined;
    if (ceiling === undefined || ceiling >= WEBEXT_CLIENT_TIMEOUT_MS || called?.success !== true) {
        return { kind: "as-is" };
    }
    const { name, arguments: args } = called.data;
    const most = seconds(ceiling - ANSWER_MARGIN_MS);
    if (name !== "wait_for") {
        return { kind: "as-is" };
    }
    const wait = WaitArgsSchema.parse(args);
    if (wait.seconds <= most) {
        return { kind: "as-is" };
    }
    // A quiet stretch must fit inside the wait, or the browser refuses the call outright.
    const quietFor = wait.quietFor === undefined || wait.quietFor < most ? wait.quietFor : most - 1;
    const fitted = { ...args, seconds: most, ...opt("quietFor", quietFor) };
    const quiet = quietFor === wait.quietFor ? "" : ` and quietFor to ${quietFor} s`;
    return {
        kind: "shortened",
        message: { ...message, params: { ...message.params, arguments: fitted } },
        note:
            `This runtime's MCP client stops waiting at ${seconds(ceiling)} s, so this wait_for was cut to ${most} s${quiet} instead of the ${wait.seconds} s asked. ` +
            `If the page is not there yet, call wait_for again to keep waiting.`,
    };
};

// The note after what the browser answered, in the daemon's own voice: a block of its own beside the sealed page.
export const withNote = (answer: RpcMessage | undefined, note: string): RpcMessage | undefined => {
    const result = ResultSchema.safeParse(answer?.result);
    if (answer === undefined || !result.success) {
        return answer;
    }
    return { ...answer, result: { ...result.data, content: [...result.data.content, { type: "text", text: note }] } };
};
