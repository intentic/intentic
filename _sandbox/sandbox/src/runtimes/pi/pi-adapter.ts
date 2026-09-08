import { access } from "node:fs/promises";
import { type AgentTurn, type Capability, PI_PROVIDER } from "@intentic/sandbox-contract";
import { type AgentAdapter, attemptProbe, healthUnavailable, healthUnknown, healthReady } from "../../agent/providers/adapter.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import type { TurnContext, TurnPlan } from "../../agent/run/turn/turn-plan.js";
import type { Services } from "../../composition.js";
import { onPath } from "../../platform/boot/on-path.js";

// The Pi row: the reserved `pi` agent-kind capability, served over Pi's own RPC protocol. A plain adapter rather than a
// provider module (the ACP reason): Pi is an installed capability, so everything past serving a turn is the capability
// system's business.

// Spawned and driven over Pi's own RPC; harness doesn't apply (Pi is its own loop). Unlike the ACP floor it takes
// steering (real mid-turn injection) and effort (set_thinking_level); no MCP seam, so no tools.
export const planPiTurn = async (services: Services, _input: AgentTurn, context: TurnContext, granted: readonly Capability[]): Promise<TurnPlan> => {
    const capability = granted.find((entry) => entry.kind === "agent" && entry.id === PI_PROVIDER);
    if (capability === undefined || capability.kind !== "agent") {
        return { ok: false, message: "Pi is not installed, add the Pi Agent capability first." };
    }
    return {
        ok: true,
        run: (turnRequest) => services.piAgent(capability.config, turnRequest),
        request: withAttachments(
            context.steering !== undefined ? { ...context.base, steering: context.steering } : context.base,
            context.attachmentPaths,
        ),
    };
};

export const PI_ADAPTER: AgentAdapter<"pi"> = {
    runtime: "pi",
    preflight: (services, input, context, installed) => planPiTurn(services, input, context, installed),
    // Two things must hold, each a different fix: the `pi` capability installed (Setup ▸ Extend), and its command on
    // PATH (a card added before the image rebuild is exactly this state). Probed on the command's head, the OpenCode
    // precedent.
    health: async (services) => {
        const installed = await attemptProbe(() => services.capabilities.list());
        if (installed === undefined) {
            return healthUnknown();
        }
        const capability = installed.find((entry) => entry.kind === "agent" && entry.id === PI_PROVIDER);
        if (capability === undefined || capability.kind !== "agent") {
            return healthUnavailable("Add the Pi Agent capability to run Pi here.");
        }
        const head = capability.config.command.trim().split(/\s+/)[0] ?? "";
        return (await onPath(head)) ? healthReady() : healthUnavailable(`\`${head}\` is not on PATH, rebuild the sandbox so the Pi install lands in the image.`);
    },
    // A Pi session is a JSONL file (the id on the wire is its path); resume-ability is whether the file still exists,
    // asked of the filesystem since there's no process between turns to ask.
    holdsSession: async (_services, sessionId) => {
        try {
            await access(sessionId);
            return true;
        } catch {
            return false;
        }
    },
};
