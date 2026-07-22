import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs, sshSchema } from "../core/inputs.js";
import { overSsh } from "../core/over-ssh.js";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import type { ForgejoApi } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";
import { FORGEJO_HTTP_PORT } from "./forgejo.js";

// The ssh block is the control-plane host's — the admin API is reached over an SSH port-forward.
const forgejoOrgSchema = sshSchema.extend({
    adminUser: z.string(),
    adminPassword: z.string(),
    org: z.string(),
});
type ForgejoOrgInputs = z.infer<typeof forgejoOrgSchema>;
const parse = (inputs: ResolvedInputs): ForgejoOrgInputs => parseInputs(forgejoOrgSchema, inputs, "forgejo-org");

// A team's Forgejo organization — the namespace its apps' repos + registry images live under. Created owned by
// the admin so the admin stays in the org Owners team and its git + packages tokens keep full access (what
// Komodo clones and pulls with). read returns undefined while Forgejo is unreachable; apply create-or-skips.
export const createForgejoOrgProvider = (api: ForgejoApi = forgejoApi, executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        try {
            return await overSsh(executor, parsed, FORGEJO_HTTP_PORT, async (baseUrl) => {
                const exists = await api.findOrg({ baseUrl, user: parsed.adminUser, password: parsed.adminPassword, org: parsed.org });
                return exists ? { outputs: {} } : undefined;
            });
        } catch (error) {
            ctx.log(`forgejo-org "${ctx.id}": forgejo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        return overSsh(executor, parsed, FORGEJO_HTTP_PORT, async (baseUrl) => {
            const auth = { baseUrl, user: parsed.adminUser, password: parsed.adminPassword };
            if (!(await api.findOrg({ ...auth, org: parsed.org }))) {
                await api.createOrg({ ...auth, org: parsed.org });
            }
            return {};
        });
    },
    delete: async (inputs) => {
        const parsed = parse(inputs);
        await overSsh(executor, parsed, FORGEJO_HTTP_PORT, (baseUrl) =>
            api.deleteOrg({ baseUrl, user: parsed.adminUser, password: parsed.adminPassword, org: parsed.org }),
        );
    },
});
