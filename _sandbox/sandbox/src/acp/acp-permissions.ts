import type { PermissionOption, PermissionOptionKind, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { type CommandGate, consultWith, vendorSubject } from "../guard/command-gate.js";

/* The daemon's answer to ACP session/request_permission.
 *
 * The standing posture is auto-allow, the same as bypassPermissions / approvalPolicy:never / OpenCode's
 * allow-all: the container is the isolation boundary, and per-tool prompts are deliberately NOT surfaced to the
 * user (the architecture's standing decision). Two things override it, and both are the owner's own words
 * rather than a per-call prompt:
 *
 *   · THE PLAN PHASE rejects mutating tool kinds so a planning turn stays read-only. Best-effort, an agent that
 *     never asks isn't constrained by an answer, which is why the plan-emulation preamble demands it in prose too.
 *   · THE SAFETY POLICY (guard/command-gate.ts). This is the channel that makes the owner's written policy mean
 *     something on an ACP agent instead of silently nothing: the same triage, the same judge and the same hard
 *     rule the Claude Code hook uses, reached through the one seam ACP publishes.
 *
 * TWO LIMITS, both stated here because neither is visible from the call site.
 *
 * WHICH CALLS ARRIVE is the agent's choice. ACP puts `session/request_permission` in the floor, so the channel
 * always exists, but nothing obliges an agent to use it for any particular tool. An agent that runs a shell
 * without asking is one no rule here can reach, which is exactly what the capability record's
 * `rulebook: "approval"` discloses.
 *
 * A REFUSAL CARRIES NO WORDS. RequestPermissionResponse is an option id and nothing else: there is no field for
 * a reason, so an agent told no learns that it was refused and not why. The Claude path hands its refusal text
 * straight to the model; here the reason reaches the USER (on the card, before they answered) and the transcript,
 * and the agent gets the protocol's own "rejected". Nothing can be done about that from this side. */

export type PermissionPhase = "execute" | "plan";

const pick = (options: readonly PermissionOption[], kinds: readonly PermissionOptionKind[]): PermissionOption | undefined => {
    for (const kind of kinds) {
        const match = options.find((option) => option.kind === kind);
        if (match !== undefined) {
            return match;
        }
    }
    return undefined;
};

const selected = (option: PermissionOption): RequestPermissionResponse => ({ outcome: { outcome: "selected", optionId: option.optionId } });
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

const MUTATING = new Set(["edit", "delete", "move", "execute"]);

/* WHAT THIS CALL IS ABOUT TO RUN, as text the classifier can read, or undefined when the request carries none.
 *
 * `rawInput` is the tool's own arguments and its shape is the AGENT's, not the protocol's, so the common
 * spellings are tried in turn rather than one being assumed. `title` is the last resort and a deliberate one:
 * it is a human-readable line, so an agent that titles a call `Run "rm -rf build"` gets classified from that,
 * which is better than not looking. Both are only ever read to CLASSIFY: a false positive raises a card the
 * owner asked for, and a miss is the disclosed limit above.
 *
 * Nothing here throws on a hostile shape: `rawInput` is whatever the agent sent. */
const programOf = (request: RequestPermissionRequest): string | undefined => {
    const raw = request.toolCall.rawInput;
    if (typeof raw === "object" && raw !== null) {
        for (const key of ["command", "cmd", "script", "code", "input"]) {
            const value = (raw as Record<string, unknown>)[key];
            if (typeof value === "string" && value.trim() !== "") {
                return value;
            }
        }
    }
    const title = request.toolCall.title;
    return typeof title === "string" && title.trim() !== "" ? title : undefined;
};

export const decidePermission = async (
    request: RequestPermissionRequest,
    phase: PermissionPhase,
    aborted: boolean,
    gate?: CommandGate,
    // How a permission card reaches the client. An ACP permission arrives in the connection's own callback, not
    // inside the turn generator, so the gate's frames are pushed into that turn's queue rather than yielded.
    push: (event: AgentEvent) => void = () => {},
): Promise<RequestPermissionResponse> => {
    if (aborted) {
        return CANCELLED;
    }
    const rejection = pick(request.options, ["reject_once", "reject_always"]);
    if (phase === "plan" && typeof request.toolCall.kind === "string" && MUTATING.has(request.toolCall.kind)) {
        if (rejection !== undefined) {
            return selected(rejection);
        }
        // No rejection offered, allowing beats cancelling the whole planning turn; the preamble still holds.
    }
    /* The rulebook, consulted only where it can bite: the owner wrote a rule (or the turn is carrying somebody
     * else's words), the agent offered a way to say no, and the call carries readable text. Missing any of the
     * three and this is the auto-allow it always was, which is what keeps an unconfigured workspace unchanged. */
    if (gate?.enforcing === true && rejection !== undefined) {
        const program = programOf(request);
        if (program !== undefined) {
            const outcome = await consultWith(gate, program, vendorSubject(request.toolCall.name ?? request.toolCall.kind ?? "tool"), push);
            if (!outcome.allow) {
                return selected(rejection);
            }
        }
    }
    const allowance = pick(request.options, ["allow_always", "allow_once"]);
    if (allowance !== undefined) {
        return selected(allowance);
    }
    const first = request.options[0];
    return first !== undefined ? selected(first) : CANCELLED;
};
