import type { IntegrationConfig, InventoryEntry } from "@intentic/sandbox-contract";
import { hasManagedEntry, removeManagedEntry, upsertManagedEntry } from "../../inventory/managed-region.js";
import type { CapabilityHandler } from "../capability.js";

// An external integration (Stripe/Redmine/Outline/IMAP): declare it as i.have.<provider> in deploy.config.ts.
// The non-secret coordinates (url / host / port / username) are carried straight through to the entry; the secret
// key is read from the sandbox env (e.g. STRIPE_API_KEY) at provision time — never sent over the wire. Requires DevOps.
export const integrationHandler: CapabilityHandler = {
    requires: ["devops"],
    apply: async function* (ctx, id, config) {
        const { provider, ...values } = config as IntegrationConfig;
        const entry: InventoryEntry = { kind: "backend", provider, name: id, values };
        await upsertManagedEntry(ctx.config, entry, `chore(intentic): add ${provider} "${id}"`);
        yield { kind: "log", message: `Connected ${provider}. Its key is read from the sandbox env on the next provision.` };
    },
    status: async (ctx, id) => ((await hasManagedEntry(ctx.config, id)) ? { state: "active" } : { state: "inactive" }),
    remove: async (ctx, id) => {
        await removeManagedEntry(ctx.config, id, `chore(intentic): remove "${id}"`);
    },
};
