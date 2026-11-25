import { errorMessage } from "@intentic/base/errors";
import {
    RUNNER_FLEET_CONVERSATION_HEADER,
    RUNNER_SUBAGENTS_DOOR_HEADER,
    RunnerFleetNotPlacedSchema,
    RunnerSubagentNoToolSchema,
    type RunnerSubagentResult,
    RunnerSubagentResultSchema,
    runnerSubagentsUrl,
} from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { z } from "zod";
import type { RunnerIdentity } from "../runner-identity.js";

/* A RUNNER'S TURN SUPERVISES ITS SUBAGENTS AT ITS PARENT (2026-11-23). A turn the parent placed here runs as a local turn,
   so its `subagents` server once acted on this runner's registry: a `spawn` filed the child here, placed it by this
   runner's fleet rules (it has no runners of its own), and nobody on the parent's board saw, supervised or landed it.
   The parent owns the conversation, so every tool that touches children (spawn, wait, send, cancel, answer, merge, settle,
   providers and the workflow tools) is run by the parent's door (runner-subagents.routes.ts) as that conversation's turn
   running there would run it, and its answer is relayed as it came. The background commands' tools (`keep`, `stop`) and
   a wait on a command or an in-process subagent stay here, where those run. A conversation the parent did not place here
   is this runner's own; a parent too old for the door leaves the tools here as before and the turn is told once; a
   parent out of reach is said as such, never answered from this runner's registry. This file is the call to the parent;
   the wrapping of the server's tools is agent/subagents/waiting/parent-forward.ts. */

export type ParentSubagentAnswer =
    | { readonly kind: "answered"; readonly result: RunnerSubagentResult }
    // The parent placed no such conversation here: it is this runner's own, served here.
    | { readonly kind: "not-placed" }
    // An older parent, one refusing this runner's token, or one that does not run this tool for runners: served here.
    | { readonly kind: "no-door"; readonly status: number }
    | { readonly kind: "unreachable"; readonly message: string }
    // The calling turn gave up on it (stopped, or words were said into it).
    | { readonly kind: "aborted" };

export interface ParentSubagentCallOptions {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    // This call's id, kept across its retries, for a tool the parent answers once per call (call-receipts.ts).
    readonly callId?: string;
}

// The runner's id for one `spawn`, `send` or `cancel` call, kept across its retries, so the parent answers a retry with
// what the first call did rather than doing it again. Optional both ways: a parent that does not read it acts on every
// call as before, and a call without it is acted on as before. Both ends are this package, so it is named here.
export const RUNNER_SUBAGENT_CALL_HEADER = "x-intentic-call-id";

// A tool's arguments as the SDK handed them to its handler, already checked against the tool's own schema.
const ToolArgsSchema = z.looseObject({});
export type ToolArgs = Readonly<z.infer<typeof ToolArgsSchema>>;

/** One tool call asked of the parent for `conversationId`. */
export type ParentSubagentCall = (tool: string, args: ToolArgs, conversationId: string, options: ParentSubagentCallOptions) => Promise<ParentSubagentAnswer>;

/** `body` read as JSON and checked against `schema`; undefined where it is neither. */
export const parseBody = <T>(schema: z.ZodType<T>, body: string): T | undefined => {
    try {
        const parsed = schema.safeParse(JSON.parse(body));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a body that is not JSON is no answer of the door's own, said by the caller as such
        return undefined;
    }
};

// What the door's answer says, once it is known to be the door's: a refusal, or the tool's result.
const doorAnswer = (status: number, body: string): ParentSubagentAnswer => {
    if (status === 404 && parseBody(RunnerFleetNotPlacedSchema, body) !== undefined) {
        return { kind: "not-placed" };
    }
    if (status === 404 && parseBody(RunnerSubagentNoToolSchema, body) !== undefined) {
        return { kind: "no-door", status };
    }
    const result = parseBody(RunnerSubagentResultSchema, body);
    return result === undefined ? { kind: "unreachable", message: `it answered ${status} with no tool result` } : { kind: "answered", result };
};

export const parentSubagentCall =
    (identity: RunnerIdentity): ParentSubagentCall =>
    async (tool, args, conversationId, { timeoutMs, signal, callId }) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const headers = new Headers({
            authorization: `Bearer ${identity.token}`,
            "content-type": "application/json",
            [RUNNER_FLEET_CONVERSATION_HEADER]: conversationId,
        });
        if (callId !== undefined) {
            headers.set(RUNNER_SUBAGENT_CALL_HEADER, callId);
        }
        try {
            const response = await fetch(runnerSubagentsUrl(identity.parentUrl, tool), {
                method: "POST",
                headers,
                body: JSON.stringify(args),
                signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            });
            if (response.headers.get(RUNNER_SUBAGENTS_DOOR_HEADER) === null) {
                // A proxy's 502 is a parent not answering, not one without the door.
                return response.status >= 500 ? { kind: "unreachable", message: `it answered ${response.status}` } : { kind: "no-door", status: response.status };
            }
            return doorAnswer(response.status, await response.text());
        } catch (error) {
            if (signal?.aborted === true) {
                return { kind: "aborted" };
            }
            return { kind: "unreachable", message: timeout.aborted ? `no answer in ${Math.round(timeoutMs / 1000)}s` : errorMessage(error) };
        }
    };
