import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { GitHubApi } from "./github-api.js";
import { githubApi } from "./github-api.js";

const ghRepoSchema = z.object({
    name: z.string(),
    owner: z.string(),
    private: z.boolean(),
    token: z.string(),
});
type GhRepoInputs = z.infer<typeof ghRepoSchema>;
const parse = (inputs: ResolvedInputs): GhRepoInputs => parseInputs(ghRepoSchema, inputs, "gh-repo");

const outputsFor = (parsed: GhRepoInputs): Record<string, unknown> => ({
    cloneUrl: `https://github.com/${parsed.owner}/${parsed.name}.git`,
    sshUrl: `git@github.com:${parsed.owner}/${parsed.name}.git`,
});

// The GitHub repo provider: create-or-skip a GitHub repo under the resolved owner. Mirrors repo.ts but
// against GitHub's API. The owner is either an org or the authenticated user.
export const createGhRepoProvider = (api: GitHubApi = githubApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["token"] !== "string" || typeof inputs["owner"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const repo = await api.findRepo({ token: parsed.token, owner: parsed.owner, name: parsed.name });
            if (repo === undefined) {
                return undefined;
            }
            return { outputs: outputsFor(parsed) };
        } catch (error) {
            ctx.log(`gh-repo "${ctx.id}": GitHub not reachable yet: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const existing = await api.findRepo({ token: parsed.token, owner: parsed.owner, name: parsed.name });
        if (existing === undefined) {
            // Detect org vs. user: try org first, fall back to user.
            const user = await api.getAuthenticatedUser({ token: parsed.token });
            const ownerIsOrg = parsed.owner !== user.login;
            await api.createRepo({ token: parsed.token, owner: parsed.owner, name: parsed.name, private: parsed.private, ownerIsOrg });
        }
        return outputsFor(parsed);
    },
    delete: async (inputs) => {
        if (typeof inputs["token"] !== "string" || typeof inputs["owner"] !== "string") {
            return;
        }
        const parsed = parse(inputs);
        await api.deleteRepo({ token: parsed.token, owner: parsed.owner, name: parsed.name });
    },
});
