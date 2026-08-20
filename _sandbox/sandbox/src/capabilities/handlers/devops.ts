import { existsSync } from "node:fs";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import type { CapabilityHandler } from "../capability.js";

// DevOps: scaffold the intent + desired-state repos and make them provisionable. This is the capability that
// turns an empty sandbox into an infra-capable one, the Infra UI plus the service/integration capabilities all
// depend on it. No `remove`: deleting the repos would destroy the user's declared infrastructure. The git
// bookkeeping and the pnpm install run in the visible job session the first frame surfaces.
export const devopsHandler: CapabilityHandler = {
    echo: () => ({}),
    // One per sandbox, and never named by anybody, like `remove`, a rename is not a thing this capability has.
    rename: { refuse: "DevOps is one per sandbox and has no name of its own to change." },
    apply: async function* (ctx, id) {
        const session = capabilityJobSession(id);
        if (ctx.terminalRun.visible) {
            yield { kind: "terminal", session };
        }
        if (existsSync(ctx.workspace.repos.intent)) {
            yield { kind: "log", message: "Intent repo already present." };
        } else {
            yield { kind: "log", message: "Scaffolding intent + desired-state repos…" };
            await ctx.scaffoldNeutralLedger(session);
        }
        yield { kind: "log", message: "Installing provisioning dependencies (this can take a minute)…" };
        await ctx.ensureIntentInstallable(session);
        yield { kind: "log", message: "DevOps ready — connect a machine (Infra) to provision onto." };
    },
    status: async (ctx) =>
        existsSync(ctx.workspace.repos.intent) && existsSync(ctx.workspace.repos["desired-state"]) ? { state: "active" } : { state: "inactive" },
};
