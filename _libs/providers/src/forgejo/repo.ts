import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { ForgejoApi } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";

const repoSchema = z.object({
    name: z.string(),
    // The repo owner: a team's org for a team-owned app, or the admin user for the single-admin fallback. The
    // admin still authenticates every call; it owns the org, so it can create repos under it.
    owner: z.string(),
    private: z.boolean(),
    forgejoUrl: z.string(),
    domain: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
});
type RepoInputs = z.infer<typeof repoSchema>;
const parse = (inputs: ResolvedInputs): RepoInputs => parseInputs(repoSchema, inputs, "repo");

// The clone/ssh urls are re-derived deterministically from the git domain + owner + repo name, so a healthy
// noop produces a stable output set without depending on how Forgejo formats them.
const outputsFor = (parsed: RepoInputs): Record<string, unknown> => ({
    cloneUrl: `https://${parsed.domain}/${parsed.owner}/${parsed.name}.git`,
    sshUrl: `git@${parsed.domain}:${parsed.owner}/${parsed.name}.git`,
});

// The app's source repository, created under its owner (a team's org, or the admin user when team-less). read
// returns undefined when Forgejo is not yet up (its url input is still PENDING) or unreachable, so a plan
// proceeds; apply create-or-skips. The org-vs-admin endpoint is picked by whether the owner is the admin user.
export const createRepoProvider = (api: ForgejoApi = forgejoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["forgejoUrl"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const repo = await api.findRepo({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.owner,
                name: parsed.name,
            });
            if (repo === undefined) {
                return undefined;
            }
            return { outputs: outputsFor(parsed) };
        } catch (error) {
            ctx.log(`repo "${ctx.id}": forgejo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const existing = await api.findRepo({
            baseUrl: parsed.forgejoUrl,
            user: parsed.adminUser,
            password: parsed.adminPassword,
            owner: parsed.owner,
            name: parsed.name,
        });
        if (existing === undefined) {
            await api.createRepo({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.owner,
                ownerIsOrg: parsed.owner !== parsed.adminUser,
                name: parsed.name,
                private: parsed.private,
                autoInit: true,
            });
        }
        return outputsFor(parsed);
    },
    delete: async (inputs) => {
        if (typeof inputs["forgejoUrl"] !== "string") {
            return;
        }
        const parsed = parse(inputs);
        await api.deleteRepo({
            baseUrl: parsed.forgejoUrl,
            user: parsed.adminUser,
            password: parsed.adminPassword,
            owner: parsed.owner,
            name: parsed.name,
        });
    },
});
