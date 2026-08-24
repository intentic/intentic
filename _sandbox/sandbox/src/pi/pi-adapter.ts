import { access } from "node:fs/promises";
import { type AgentTurn, type Capability, PI_PROVIDER } from "@intentic/sandbox-contract";
import { type AgentAdapter, attemptProbe, healthUnavailable, healthUnknown, healthReady } from "../agent/adapter.js";
import { withAttachments } from "../agent/attachment-note.js";
import type { TurnContext, TurnPlan } from "../agent/turn-plan.js";
import type { Services } from "../composition.js";
import { onPath } from "../platform/on-path.js";

/* The Pi row: the reserved `pi` agent-kind capability, served over Pi's own RPC protocol. Beside the runtime
 * it serves (the provider-module siting rule), and a plain adapter rather than a module for the ACP reason:
 * Pi is an installed capability, so everything past serving a turn is the capability system's business. */

// Pi: spawned and driven over Pi's own RPC protocol. Harness doesn't apply (Pi is its own loop). Unlike the
// ACP floor it takes the steering queue (Pi's `steer` command is real mid-turn injection) and the effort tier
// (set_thinking_level); it has no MCP seam, so no tools are passed.
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
    /* Two things have to hold, and each is a different fix: the reserved `pi` capability must be installed
     * (Setup ▸ Extend), and its command must resolve on PATH. Pi ships as an npm package the capability's
     * image fragment bakes in, so a card added before the rebuild is exactly the state this names. Probed on
     * the command's head, the OpenCode precedent. */
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
    /* A Pi session is a JSONL file (the id on the wire IS its path, pi-agent.ts), so whether a resume can
     * still happen is whether the file is still there. Asked of the filesystem rather than of Pi, because
     * there is no process between turns to ask. */
    holdsSession: async (_services, sessionId) => {
        try {
            await access(sessionId);
            return true;
        } catch {
            return false;
        }
    },
};
