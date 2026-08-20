import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs, sshSchema } from "../core/inputs.js";
import { overSsh } from "../core/over-ssh.js";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import type { ForgejoApi } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";
import { FORGEJO_HTTP_PORT } from "./forgejo.js";

// The ssh block is the control-plane host's, the admin API is reached over an SSH port-forward.
const forgejoTeamSchema = sshSchema.extend({
    adminUser: z.string(),
    adminPassword: z.string(),
    org: z.string(),
    name: z.string(),
    // The Forgejo permission the team grants on its repos (read|write|admin), already resolved to the strongest
    // role across the apps that grant this team.
    permission: z.string(),
    // The member usernames and the repos (owner = the app's owning org, name = the app id) to attach.
    members: z.array(z.string()),
    repos: z.array(z.object({ owner: z.string(), name: z.string() })),
});
type ForgejoTeamInputs = z.infer<typeof forgejoTeamSchema>;
const parse = (inputs: ResolvedInputs): ForgejoTeamInputs => parseInputs(forgejoTeamSchema, inputs, "forgejo-team");

// A team inside its org: members + the repos they get access to at the team's permission. read keys on the
// team's existence + its current permission (so a permission change re-applies); membership and repo
// attachment are idempotent PUTs re-asserted on apply. Depends (via the resolver's refs) on the org, every
// member's account, and every attached repo, so all exist before apply runs. A pure sink, no outputs.
export const createForgejoTeamProvider = (api: ForgejoApi = forgejoApi, executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        try {
            return await overSsh(executor, parsed, FORGEJO_HTTP_PORT, async (baseUrl) => {
                const team = await api.findTeam({
                    baseUrl,
                    user: parsed.adminUser,
                    password: parsed.adminPassword,
                    org: parsed.org,
                    name: parsed.name,
                });
                return team === undefined ? undefined : { outputs: {}, detail: { permission: team.permission } };
            });
        } catch (error) {
            ctx.log(`forgejo-team "${ctx.id}": forgejo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: (inputs, observed) => {
        if (observed.detail?.["permission"] !== parse(inputs).permission) {
            return { action: "update", reason: "team permission differs from desired" };
        }
        return { action: "noop" };
    },
    apply: async (inputs) => {
        const parsed = parse(inputs);
        return overSsh(executor, parsed, FORGEJO_HTTP_PORT, async (baseUrl) => {
            const auth = { baseUrl, user: parsed.adminUser, password: parsed.adminPassword };
            const existing = await api.findTeam({ ...auth, org: parsed.org, name: parsed.name });
            const teamId = existing?.id ?? (await api.createTeam({ ...auth, org: parsed.org, name: parsed.name, permission: parsed.permission })).id;
            for (const username of parsed.members) {
                await api.addTeamMember({ ...auth, teamId, username });
            }
            for (const repo of parsed.repos) {
                await api.addTeamRepo({ ...auth, teamId, org: repo.owner, name: repo.name });
            }
            return {};
        });
    },
    delete: async (inputs) => {
        const parsed = parse(inputs);
        await overSsh(executor, parsed, FORGEJO_HTTP_PORT, async (baseUrl) => {
            const auth = { baseUrl, user: parsed.adminUser, password: parsed.adminPassword };
            const existing = await api.findTeam({ ...auth, org: parsed.org, name: parsed.name });
            if (existing === undefined) {
                return;
            }
            await api.deleteTeam({ ...auth, teamId: existing.id });
        });
    },
});
