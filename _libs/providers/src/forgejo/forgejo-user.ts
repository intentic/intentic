import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { ForgejoApi } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";

const forgejoUserSchema = z.object({
    forgejoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    username: z.string(),
    email: z.string(),
    // The intentic-generated login password, set so it works for the API + git push immediately.
    accountPassword: z.string(),
});
type ForgejoUserInputs = z.infer<typeof forgejoUserSchema>;
const parse = (inputs: ResolvedInputs): ForgejoUserInputs => parseInputs(forgejoUserSchema, inputs, "forgejo-user");

// A declared person's Forgejo git account, created over the admin API (the admin already exists, so no SSH/CLI
// bootstrap is needed). read returns undefined while Forgejo is not yet up (its url is PENDING) or unreachable,
// so a plan proceeds; apply create-or-skips. A pure sink: account existence is all it reconciles (a password
// rotation would break the stable-output contract, like the persisted forgejo tokens), so diff is a noop.
export const createForgejoUserProvider = (api: ForgejoApi = forgejoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["forgejoUrl"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const exists = await api.findUser({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                username: parsed.username,
            });
            return exists ? { outputs: {} } : undefined;
        } catch (error) {
            ctx.log(`forgejo-user "${ctx.id}": forgejo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const auth = { baseUrl: parsed.forgejoUrl, user: parsed.adminUser, password: parsed.adminPassword };
        if (!(await api.findUser({ ...auth, username: parsed.username }))) {
            await api.createUser({ ...auth, username: parsed.username, email: parsed.email, accountPassword: parsed.accountPassword });
        }
        return {};
    },
    delete: async (inputs) => {
        if (typeof inputs["forgejoUrl"] !== "string") {
            return;
        }
        const parsed = parse(inputs);
        await api.deleteUser({ baseUrl: parsed.forgejoUrl, user: parsed.adminUser, password: parsed.adminPassword, username: parsed.username });
    },
});
