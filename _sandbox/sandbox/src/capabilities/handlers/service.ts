import type { InventoryEntry, ServiceConfig } from "@intentic/sandbox-contract";
import { isTerminalExit } from "../../intentic/apply-events.js";
import { INFRA_APPLY_KEY } from "../../intentic/infra-apply.js";
import { hasManagedEntry, removeManagedEntry, upsertManagedEntry } from "../../inventory/managed-region.js";
import { panelSession } from "../../processes/managed-processes.js";
import type { CapabilityHandler } from "../capability.js";

// A self-hosted service (e.g. SigNoz): declare it as i.want.service in deploy.config.ts, then provision it via
// the ONE infra apply pipeline, the shared panel-infra-apply one-shot job (`intentic deploy resolve && intentic deploy apply
// --yes && intentic deploy adopt` with the durable events file), the same job InfraDeclare's Apply launches. That
// buys the visible terminal, serialization with a concurrent InfraDeclare apply, restart adoption, and the
// ApplyProgress tail, this handler just relays the job's events into the add stream and fails on its terminal
// non-zero exit. Requires DevOps (the intent repo). SigNoz's MCP is auto-wired by the resolver's service
// catalog, so the agent gets its tools with no extra work here.
export const serviceHandler: CapabilityHandler = {
    echo: (config) => {
        const service = config as ServiceConfig;
        return { service: service.service, domain: service.domain, on: service.on, expose: service.expose };
    },
    requires: ["devops"],
    // A provisioned service's name is not a label on a row: it names the running thing, its container, its
    // volumes, the domain pointed at it, and moving that is a deployment, not an edit. Declaring the new one
    // and retiring the old is the honest way to do it, and it goes through the same apply as any other change.
    rename: {
        refuse: "A provisioned service is named in your infrastructure, where its containers and volumes carry that name — declare the new one and retire this, rather than renaming it here.",
    },
    apply: async function* (ctx, id, config) {
        const { service, domain, on, expose } = config as ServiceConfig;
        const entry: InventoryEntry = { kind: "service", service, name: id, on, expose, values: { domain } };
        await upsertManagedEntry(ctx.config, entry, `chore(intentic): add ${service} "${id}"`);
        yield { kind: "log", message: `Declared ${service} "${id}". Provisioning…` };
        if (!(await ctx.infraApply.start({ resolveFirst: true }))) {
            throw new Error("an infrastructure apply is already running — wait for it to finish, then retry");
        }
        yield { kind: "terminal", session: panelSession(INFRA_APPLY_KEY) };
        // Relay the job's structured events (the dialog renders their messages; heartbeats keep the stream
        // alive). The tail ends on the chain's terminal exit, adopt's clean one, or any command's failure,
        // or when the job died without one (SIGKILL); only adopt's clean exit is success.
        let outcome: "running" | "ok" | "failed" = "running";
        for await (const line of ctx.infraApply.events()) {
            yield line;
            if (isTerminalExit(line)) {
                outcome = line["code"] === 0 ? "ok" : "failed";
            }
        }
        if (outcome !== "ok") {
            throw new Error(`provisioning failed — see the ${panelSession(INFRA_APPLY_KEY)} terminal`);
        }
        yield { kind: "log", message: `${service} "${id}" provisioned.` };
    },
    status: async (ctx, id) => ((await hasManagedEntry(ctx.config, id)) ? { state: "active" } : { state: "inactive" }),
    remove: async (ctx, id) => {
        await removeManagedEntry(ctx.config, id, `chore(intentic): remove "${id}"`);
    },
};
