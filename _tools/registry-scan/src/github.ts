import { z } from "zod";

/* The three GitHub reads the scan needs, behind an interface so the decision logic in scan.ts can be tested
 * without a network or a token. Plain fetch against the REST API rather than an SDK: three endpoints do not
 * earn a dependency, and this file ships into a registry repo that should stay readable by the people whose
 * listings it decides. */

export interface GithubRepo {
    /** owner/repo */
    fullName: string;
    stars: number;
    /** ISO-8601, last push to any branch. */
    pushedAt: string;
    defaultBranch: string;
    description?: string;
    archived: boolean;
}

export interface GithubReader {
    searchByTopic(topic: string): Promise<GithubRepo[]>;
    /** Undefined when the repo is gone or private to us — which is itself a finding about a live listing. */
    getRepo(fullName: string): Promise<GithubRepo | undefined>;
    headSha(fullName: string, ref: string): Promise<string | undefined>;
    readFile(fullName: string, ref: string, path: string): Promise<string | undefined>;
}

const RepoSchema = z.object({
    full_name: z.string(),
    stargazers_count: z.number(),
    pushed_at: z.string(),
    default_branch: z.string(),
    description: z.string().nullable(),
    archived: z.boolean(),
});

const SearchSchema = z.object({ total_count: z.number(), incomplete_results: z.boolean(), items: z.array(RepoSchema) });
const RefSchema = z.object({ object: z.object({ sha: z.string() }) });

const toRepo = (raw: z.infer<typeof RepoSchema>): GithubRepo => ({
    fullName: raw.full_name,
    stars: raw.stargazers_count,
    pushedAt: raw.pushed_at,
    defaultBranch: raw.default_branch,
    archived: raw.archived,
    ...(raw.description !== null ? { description: raw.description } : {}),
});

// Search caps out at 1000 results across 10 pages of 100. Well past that we would need a different discovery
// mechanism entirely, so stopping here is honest — the caller logs the total it saw against what it read.
const PER_PAGE = 100;
const MAX_PAGES = 10;

// A 404 is an answer, not a failure: an extension repo that has no manifest yet, or a ref that moved. Any
// other non-OK status is the API telling us something is wrong (rate limit, bad token, outage) and must not
// be smoothed into "nothing found" — a scan that silently reads nothing would propose deleting the world if
// a later step ever trusted its emptiness.
const optional = async (response: Response, what: string): Promise<Response | undefined> => {
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`GitHub ${response.status} reading ${what}: ${await response.text()}`);
    }
    return response;
};

export const githubReader = (token: string, fetchImpl: typeof fetch = fetch): GithubReader => {
    const call = async (path: string): Promise<Response> =>
        fetchImpl(`https://api.github.com${path}`, {
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "x-github-api-version": "2022-11-28",
            },
        });

    return {
        async searchByTopic(topic) {
            const repos: GithubRepo[] = [];
            for (let page = 1; page <= MAX_PAGES; page++) {
                const response = await call(`/search/repositories?q=${encodeURIComponent(`topic:${topic}`)}&per_page=${PER_PAGE}&page=${page}`);
                if (!response.ok) {
                    throw new Error(`GitHub ${response.status} searching topic:${topic}: ${await response.text()}`);
                }
                const { items } = SearchSchema.parse(await response.json());
                repos.push(...items.map(toRepo));
                if (items.length < PER_PAGE) {
                    break;
                }
            }
            return repos;
        },

        async getRepo(fullName) {
            const response = await optional(await call(`/repos/${fullName}`), fullName);
            return response === undefined ? undefined : toRepo(RepoSchema.parse(await response.json()));
        },

        async headSha(fullName, ref) {
            const response = await optional(await call(`/repos/${fullName}/git/ref/heads/${ref}`), `${fullName}@${ref}`);
            return response === undefined ? undefined : RefSchema.parse(await response.json()).object.sha;
        },

        async readFile(fullName, ref, path) {
            // The raw media type returns the file body itself rather than base64 in a JSON envelope.
            const response = await optional(
                await fetchImpl(`https://api.github.com/repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
                    headers: {
                        accept: "application/vnd.github.raw+json",
                        authorization: `Bearer ${token}`,
                        "x-github-api-version": "2022-11-28",
                    },
                }),
                `${fullName}:${path}@${ref}`,
            );
            return response === undefined ? undefined : response.text();
        },
    };
};
