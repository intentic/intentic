import type { InventoryEntry, ServiceConfig } from "@intentic/sandbox-contract";
import { isTerminalExit } from "../../intentic/apply-events.js";
import { INFRA_APPLY_KEY } from "../../intentic/infra-apply.js";
import { hasManagedEntry, removeManagedEntry, upsertManagedEntry } from "../../inventory/managed-region.js";
import { panelSession } from "../../processes/managed-processes.js";
import type { CapabilityHandler } from "../capability.js";

// A self-hosted service, declared as i.want.service in deploy.config.ts, provisioned through the shared
// panel-infra-apply job. This handler relays its events into the add stream and fails on a non-zero terminal exit.
// Requires DevOps; a service's MCP is auto-wired by the resolver's catalog.
export const serviceHandler: CapabilityHandler = {
    echo: (config) => {
        const service = config as ServiceConfig;
        return { service: service.service, domain: service.domain, on: service.on, expose: service.expose };
    },
    requires: ["devops"],
    // A service's name isn't a label: it names the running container, volumes and domain. Renaming means declaring a
    // new one and retiring this, through the same apply as any other change.
    rename: {
        refuse: "A provisioned service is named in your infrastructure, where its containers and volumes carry that name, declare the new one and retire this, rather than renaming it here.",
    },
    async *apply(ctx, id, config) {
        const { service, domain, on, expose } = config as ServiceConfig;
        const entry: InventoryEntry = { kind: "service", service, name: id, on, expose, values: { domain } };
        await upsertManagedEntry(ctx.config, entry, `chore(intentic): add ${service} "${id}"`);
        yield { kind: "log", message: `Declared ${service} "${id}". Provisioning…` };
        if (!(await ctx.infraApply.start({ resolveFirst: true }))) {
            throw new Error("an infrastructure apply is already running: wait for it to finish, then retry");
        }
        yield { kind: "terminal", session: panelSession(INFRA_APPLY_KEY) };
        // Ends on any terminal exit or a silent kill; only adopt's own clean exit counts as success.
        let outcome: "running" | "ok" | "failed" = "running";
        for await (const line of ctx.infraApply.events()) {
            yield line;
            if (isTerminalExit(line)) {
                outcome = line["code"] === 0 ? "ok" : "failed";
            }
        }
        if (outcome !== "ok") {
            throw new Error(`provisioning failed: see the ${panelSession(INFRA_APPLY_KEY)} terminal`);
        }
        yield { kind: "log", message: `${service} "${id}" provisioned.` };
    },
    status: async (ctx, id) => ((await hasManagedEntry(ctx.config, id)) ? { state: "active" } : { state: "inactive" }),
    remove: async (ctx, id) => {
        await removeManagedEntry(ctx.config, id, `chore(intentic): remove "${id}"`);
    },
};
