import type { PermissionOption, PermissionOptionKind, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { CommandGuard } from "../../guard/command-guard.js";
import { answerVendorAsk, askCwdOf, askProgramOf, type VendorAnswer, VendorToolInputSchema } from "../decorators/vendor-ask.js";

// Daemon's answer to ACP session/request_permission. Plan phase rejects mutating tool kinds (best-effort); the safety
// policy runs the same triage/judge/hard rule as the Claude Code hook, through the answer every vendor ask shares
// (decorators/vendor-ask.ts). Past the rulebook, a turn in `default` mode puts the call to a person on a permission card
// (`person`); every other posture allows, the container being the boundary. A refusal carries no reason; the card shows
// the user why, the agent only sees rejected.

export type PermissionPhase = "execute" | "plan";

// A person's answer to one call, from the card a turn in `default` mode raises.
export type PersonDecision = "once" | "always" | "deny";
export type PersonAsk = (request: RequestPermissionRequest) => Promise<PersonDecision>;

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

// The text the rulebook reads from a call: the command its rawInput names, or its title when it names none. rawInput's
// shape is the agent's own.
export const permissionProgram = (request: RequestPermissionRequest): string | undefined =>
    askProgramOf(VendorToolInputSchema.parse(request.toolCall.rawInput), request.toolCall.title);

// The command a call's rawInput names, with no stand-in: what a later terminal/create for the same call would run.
export const permissionCommand = (request: RequestPermissionRequest): string | undefined => askProgramOf(VendorToolInputSchema.parse(request.toolCall.rawInput));

// Whether an answer let the call run.
export const allowedBy = (request: RequestPermissionRequest, response: RequestPermissionResponse): boolean => {
    const { outcome } = response;
    if (outcome.outcome !== "selected") {
        return false;
    }
    const kind = request.options.find((option) => option.optionId === outcome.optionId)?.kind;
    return kind === "allow_once" || kind === "allow_always";
};

// A person's decision as one of the options the agent offered. Without a no on offer a deny is a cancel, which the
// agent reads as the turn stopping: the person said no, and nothing else here would make it hold.
const personAnswer = (request: RequestPermissionRequest, decision: PersonDecision): RequestPermissionResponse => {
    const kinds: readonly PermissionOptionKind[] =
        decision === "deny" ? ["reject_once", "reject_always"] : decision === "always" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"];
    const option = pick(request.options, kinds);
    return option === undefined ? CANCELLED : selected(option);
};

// The rulebook's answer to one call, and whether it put the call to a person on its own card: that card is the
// person's answer already, and a second would ask them twice.
const consultRulebook = async (
    request: RequestPermissionRequest,
    canRefuse: boolean,
    gate: CommandGuard | undefined,
    push: (event: AgentEvent) => void,
): Promise<{ readonly answer: VendorAnswer; readonly held: boolean }> => {
    let held = false;
    // No cwd to read the input against: the gate already carries the turn's.
    const input = VendorToolInputSchema.parse(request.toolCall.rawInput);
    const judge =
        gate === undefined
            ? undefined
            : {
                  gate,
                  push: (event: AgentEvent) => {
                      held ||= event.kind === "permission";
                      push(event);
                  },
              };
    const answer = await answerVendorAsk(judge, {
        tool: request.toolCall.name ?? request.toolCall.kind ?? "tool",
        program: askProgramOf(input, request.toolCall.title),
        cwd: askCwdOf(input),
        canRefuse,
    });
    return { answer, held };
};

export const decidePermission = async (
    request: RequestPermissionRequest,
    phase: PermissionPhase,
    aborted: boolean,
    gate?: CommandGuard,
    // Permission arrives via the connection's callback, not the turn generator; frames push into the turn's queue.
    push: (event: AgentEvent) => void = () => {},
    // Present on a turn in `default` mode: the call goes to a person once the rulebook has let it through.
    person?: PersonAsk,
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
    const { answer, held } = await consultRulebook(request, rejection !== undefined, gate, push);
    if (answer.allow && person !== undefined && !held) {
        return personAnswer(request, await person(request));
    }
    // The standing "always" only while no rule is watching and no person is: once the rulebook enforces, or a person
    // approves each call, the agent must keep asking.
    const lasting = answer.allow && answer.lasting && person === undefined;
    const allowance = answer.allow ? pick(request.options, lasting ? ["allow_always", "allow_once"] : ["allow_once"]) : undefined;
    if (allowance !== undefined) {
        return selected(allowance);
    }
    // A refusal, or no one-time yes on offer while the rulebook enforces: an "always" would let the agent run later
    // commands without asking, past the rulebook. Without a no on offer the rulebook was never consulted and cannot
    // hold this agent's calls anyway, and cancelling would end the whole turn.
    if (!lasting && rejection !== undefined) {
        return selected(rejection);
    }
    const first = request.options[0];
    return first !== undefined ? selected(first) : CANCELLED;
};
