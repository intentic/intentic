import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { GitHubApi } from "./github-api.js";
import { githubApi } from "./github-api.js";

const githubSchema = z.object({
    token: z.string(),
    // Optional: explicit owner (org name). Defaults to the PAT's authenticated user.
    owner: z.string().optional(),
});
type GitHubInputs = z.infer<typeof githubSchema>;
const parse = (inputs: ResolvedInputs): GitHubInputs => parseInputs(githubSchema, inputs, "github");

// The GitHub inventory provider: resolves the PAT's authenticated user (or the explicit owner) and surfaces
// it as the `owner` output. All downstream gh-repo/gh-ci nodes use this owner to namespace repos + images.
export const createGitHubProvider = (api: GitHubApi = githubApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["token"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const user = await api.getAuthenticatedUser({ token: parsed.token });
            const owner = parsed.owner ?? user.login;
            return { outputs: { owner } };
        } catch (error) {
            ctx.log(`github "${ctx.id}": not reachable yet: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const user = await api.getAuthenticatedUser({ token: parsed.token });
        return { owner: parsed.owner ?? user.login };
    },
    delete: async () => {
        // Inventory node — nothing to clean up.
    },
});
