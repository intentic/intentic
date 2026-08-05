import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { GitLabApi } from "./gitlab-api.js";
import { gitlabApi } from "./gitlab-api.js";

const gitlabSchema = z.object({
    token: z.string(),
    url: z.string(),
    // Optional: explicit owner (user or group path). Defaults to the PAT's authenticated user.
    owner: z.string().optional(),
});
type GitLabInputs = z.infer<typeof gitlabSchema>;
const parse = (inputs: ResolvedInputs): GitLabInputs => parseInputs(gitlabSchema, inputs, "gitlab");

// The GitLab inventory provider: resolves the PAT's authenticated user (or the explicit owner/group) and
// surfaces it as the `owner` output. All downstream gl-repo/gl-ci nodes namespace projects + images under it.
export const createGitLabProvider = (api: GitLabApi = gitlabApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["token"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const user = await api.getAuthenticatedUser({ url: parsed.url, token: parsed.token });
            return { outputs: { owner: parsed.owner ?? user.username } };
        } catch (error) {
            ctx.log(`gitlab "${ctx.id}": not reachable yet: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const user = await api.getAuthenticatedUser({ url: parsed.url, token: parsed.token });
        return { owner: parsed.owner ?? user.username };
    },
    delete: async () => {
        // Inventory node — nothing to clean up.
    },
});
