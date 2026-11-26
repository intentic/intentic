import type { WatchCheckAnswer } from "@intentic/extension-api";
import { z } from "zod";
import { type CheckFetch, timedFetch } from "./watch-http.js";

// The `github-release` watch kind (intentic-extension.json `watchKinds`): a repository's newest release, prereleases
// only when asked, for `fireOn: change`. Moved from the daemon (2026-11-26) with the same parameters. A private
// repository is read through a connected GitHub card: the check is handed that card's credential-gateway address
// (`GITHUB_API_URL_<CARD>`, the kind declares `capabilities: ["github"]`), which signs the request itself, never the
// token. Without one, a token in this process's own environment (GITHUB_TOKEN or GH_TOKEN, the owner's), else no login.

const ReleaseParamsSchema = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u), prereleases: z.boolean().optional() });

const ReleaseSchema = z.object({
    tag_name: z.string().optional(),
    name: z.string().nullable().optional(),
    html_url: z.string().optional(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
});
type Release = z.infer<typeof ReleaseSchema>;

export interface GithubReach {
    // The gateway addresses the daemon handed the check, by variable name.
    readonly reach: Readonly<Record<string, string>>;
    // This process's own environment, for a token the owner set.
    readonly env: Readonly<Record<string, string | undefined>>;
}

// Where a request goes, and what it carries to sign in there.
export interface GithubEndpoint {
    readonly base: string;
    readonly headers: Readonly<Record<string, string>>;
}

// GitHub's API as this check reaches it: a connected card's gateway first, else directly, with a token when one is set.
// Unauthenticated requests share an hourly limit per address that a datacentre's address is often past already.
export const githubApi = ({ reach, env }: GithubReach): GithubEndpoint => {
    const gateway = Object.entries(reach)
        .toSorted(([left], [right]) => (left < right ? -1 : 1))
        .find(([key, value]) => key.startsWith("GITHUB_API_URL_") && value !== "");
    if (gateway !== undefined) {
        return { base: gateway[1].replace(/\/$/u, ""), headers: {} };
    }
    const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
    return { base: "https://api.github.com", headers: token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` } };
};

// Only what names the release, never its notes: a typo fixed in the notes is not a new release.
const releaseWords = (release: Release & { readonly tag_name: string }): string => {
    const named = release.name !== undefined && release.name !== null && release.name !== "" && release.name !== release.tag_name;
    return [`${release.tag_name}${named ? ` (${release.name})` : ""}`, ...(release.html_url === undefined ? [] : [release.html_url])].join("\n");
};

const refusal = (repo: string, status: number): string =>
    status === 404
        ? `GitHub has no repository ${repo} this sandbox can see`
        : `GitHub answered ${status}${status === 403 ? " (likely its hourly limit for requests without a token)" : ""}`;

/** One check of a GitHub release watch. */
export const checkGithubRelease = async (params: Readonly<Record<string, string | boolean>>, fetch: CheckFetch, github: GithubReach, signal?: AbortSignal): Promise<WatchCheckAnswer> => {
    const parsed = ReleaseParamsSchema.safeParse(params);
    if (!parsed.success) {
        return { pass: false, detail: "a GitHub release watch names a repository as owner/name" };
    }
    const { repo, prereleases } = parsed.data;
    const api = githubApi(github);
    const fetched = await timedFetch(fetch, `${api.base}/repos/${repo}/releases?per_page=20`, { accept: "application/vnd.github+json", ...api.headers }, signal);
    if ("unreachable" in fetched) {
        return { pass: false, detail: fetched.unreachable };
    }
    const { response } = fetched;
    if (!response.ok) {
        return { pass: false, detail: refusal(repo, response.status) };
    }
    const releases = z.array(ReleaseSchema).safeParse(await response.json());
    if (!releases.success) {
        return { pass: false, detail: `GitHub answered something other than ${repo}'s releases` };
    }
    const newest = releases.data.find((release) => release.draft !== true && (prereleases === true || release.prerelease !== true));
    return newest?.tag_name === undefined
        ? { pass: false, detail: `${repo} has published no ${prereleases === true ? "" : "full "}release yet` }
        : { pass: true, output: releaseWords({ ...newest, tag_name: newest.tag_name }) };
};
