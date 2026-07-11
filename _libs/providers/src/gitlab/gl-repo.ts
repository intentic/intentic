import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { GitLabApi } from "./gitlab-api.js";
import { gitlabApi } from "./gitlab-api.js";

const glRepoSchema = z.object({
    name: z.string(),
    owner: z.string(),
    private: z.boolean(),
    url: z.string(),
    token: z.string(),
});
type GlRepoInputs = z.infer<typeof glRepoSchema>;
const parse = (inputs: ResolvedInputs): GlRepoInputs => parseInputs(glRepoSchema, inputs, "gl-repo");

// The clone/ssh urls are derived from the instance host + owner + project name (like Forgejo's repo.ts, not
// hardcoded to gitlab.com), so a self-hosted instance produces correct urls.
const hostOf = (url: string): string => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
const outputsFor = (parsed: GlRepoInputs): Record<string, unknown> => ({
    cloneUrl: `https://${hostOf(parsed.url)}/${parsed.owner}/${parsed.name}.git`,
    sshUrl: `git@${hostOf(parsed.url)}:${parsed.owner}/${parsed.name}.git`,
});

// The GitLab project provider: create-or-skip a project under the resolved owner (user or group). Mirrors
// gh-repo.ts but against GitLab's API. The group-vs-user endpoint is picked by whether the owner is the
// authenticated user.
export const createGlRepoProvider = (api: GitLabApi = gitlabApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["token"] !== "string" || typeof inputs["owner"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const project = await api.findProject({ url: parsed.url, token: parsed.token, owner: parsed.owner, name: parsed.name });
            if (project === undefined) {
                return undefined;
            }
            return { outputs: outputsFor(parsed) };
        } catch (error) {
            ctx.log(`gl-repo "${ctx.id}": GitLab not reachable yet: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const existing = await api.findProject({ url: parsed.url, token: parsed.token, owner: parsed.owner, name: parsed.name });
        if (existing === undefined) {
            const user = await api.getAuthenticatedUser({ url: parsed.url, token: parsed.token });
            const ownerIsGroup = parsed.owner !== user.username;
            await api.createProject({
                url: parsed.url,
                token: parsed.token,
                owner: parsed.owner,
                name: parsed.name,
                private: parsed.private,
                ownerIsGroup,
            });
        }
        return outputsFor(parsed);
    },
    delete: async (inputs) => {
        if (typeof inputs["token"] !== "string" || typeof inputs["owner"] !== "string") {
            return;
        }
        const parsed = parse(inputs);
        await api.deleteProject({ url: parsed.url, token: parsed.token, owner: parsed.owner, name: parsed.name });
    },
});
