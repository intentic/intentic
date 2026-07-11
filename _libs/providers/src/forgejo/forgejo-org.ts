import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { ForgejoApi } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";

const forgejoOrgSchema = z.object({
    forgejoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    org: z.string(),
});
type ForgejoOrgInputs = z.infer<typeof forgejoOrgSchema>;
const parse = (inputs: ResolvedInputs): ForgejoOrgInputs => parseInputs(forgejoOrgSchema, inputs, "forgejo-org");

// A team's Forgejo organization — the namespace its apps' repos + registry images live under. Created owned by
// the admin so the admin stays in the org Owners team and its git + packages tokens keep full access (what
// Komodo clones and pulls with). read returns undefined until Forgejo is up or unreachable; apply create-or-skips.
export const createForgejoOrgProvider = (api: ForgejoApi = forgejoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["forgejoUrl"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const exists = await api.findOrg({ baseUrl: parsed.forgejoUrl, user: parsed.adminUser, password: parsed.adminPassword, org: parsed.org });
            return exists ? { outputs: {} } : undefined;
        } catch (error) {
            ctx.log(`forgejo-org "${ctx.id}": forgejo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const auth = { baseUrl: parsed.forgejoUrl, user: parsed.adminUser, password: parsed.adminPassword };
        if (!(await api.findOrg({ ...auth, org: parsed.org }))) {
            await api.createOrg({ ...auth, org: parsed.org });
        }
        return {};
    },
    delete: async (inputs) => {
        if (typeof inputs["forgejoUrl"] !== "string") {
            return;
        }
        const parsed = parse(inputs);
        await api.deleteOrg({ baseUrl: parsed.forgejoUrl, user: parsed.adminUser, password: parsed.adminPassword, org: parsed.org });
    },
});
