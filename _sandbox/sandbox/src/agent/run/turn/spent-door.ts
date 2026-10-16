import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Services } from "../../../composition.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { opt } from "../../../opt.js";
import { spentRung } from "../../models/role-model-quota.js";

/* THE SANDBOX DOES NOT SEND ITS OWN TURNS INTO AN ALLOWANCE IT KNOWS IS SPENT. A rebuild's restart re-ran three Codex
   subagents onto an allowance every account read as spent, logging "expect the provider to refuse it" as it did; the
   translator refused with a Retry-After of 3h48m, and two of them sat as working on it (2026-10-13). A turn the sandbox
   starts by itself (a restart's re-run, a parent's message to its child, a peer's, a watch or an automation waking a
   conversation) onto a provider and model the records call spent, with a known reopening still ahead, is held there
   instead: no request goes out, nothing is filed against the provider (the records already say it), and the hold is the
   one a refusal would have left, booked for the reopening, its card and a parent's report saying so. A person's own
   message and a person's press on a held turn always go: they may know what the records do not. */

type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

/** Whether nobody pressed anything for this turn: a restart's re-run, or words no person typed. */
export const sandboxStarted = (turn: Pick<TurnInput, "resume" | "speaker">): boolean => {
    if (turn.resume === "restart") {
        return true;
    }
    // Every other re-run (a held turn's press or booking, a person's Continue, a parked answer) is somebody's own word.
    if (turn.resume !== undefined) {
        return false;
    }
    return turn.speaker?.kind !== "person";
};

export const HELD_AT_THE_DOOR =
    "The sandbox did not send this turn: its own records say the provider would refuse it, so it is held for when the allowance reopens rather than spent on a refusal.";

/**
 * The refusal a sandbox-started turn is held on before anything is sent, or undefined to send it. Only a model the
 * records call spent on every account, with its reopening named and still ahead, is held: an unmeasured one may answer,
 * and one with no reopening would be held for a press that nothing tells anyone to make.
 */
export const spentDoor = async (
    services: Services,
    turn: Pick<TurnInput, "resume" | "speaker" | "conversationId" | "model"> & { readonly agent: string },
    now: number = Date.now(),
): Promise<ErrorFrame | undefined> => {
    if (turn.conversationId === undefined || !sandboxStarted(turn)) {
        return undefined;
    }
    const spent = await spentRung(services, { provider: turn.agent, model: turn.model ?? "" }, now);
    if (spent?.reopensAt === undefined || spent.reopensAt * 1000 <= now) {
        return undefined;
    }
    services.logger.info(
        { conversationId: turn.conversationId, provider: turn.agent, ...opt("model", turn.model), reopensAt: new Date(spent.reopensAt * 1000).toISOString(), why: spent.reason },
        "turn held at the door: the records call its allowance spent, so nothing was sent",
    );
    return { kind: "error", code: "rate_limit", message: `${spent.reason} ${HELD_AT_THE_DOOR}`, resetsAt: spent.reopensAt };
};

/** The loop a turn held at the door runs in place of its runtime: the refusal it is held on, and nothing else. */
export const heldAtTheDoor =
    (refusal: ErrorFrame) =>
    async function* (): AsyncGenerator<AgentEvent> {
        yield refusal;
    };
