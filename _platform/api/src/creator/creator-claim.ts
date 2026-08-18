import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.js";

/* PROVING A PUBLISHER NAME IS YOURS — the one question standing between "this listing earned $128" and "pay
 * this person $128".
 *
 * The platform cannot answer it from anything it already holds. Sign-in is Google-only, so there is no GitHub
 * identity to read repository permissions from, and the platform ingests no registry data at all: a donation
 * carries the extension id its manifest declared and nothing else. So the proof is assembled from two public
 * reads, neither of which needs an account anywhere:
 *
 *   1. THE REGISTRY SAYS WHICH REPOSITORIES BACK A PUBLISHER. The official registry's marketplace file is the
 *      existing authority for that — a listing's `name` is `publisher.name` read from its manifest, and its
 *      `source` is the sha-pinned repository the code comes from. Nothing new has to be maintained for this to
 *      be true, and a publisher that is not listed has nothing to claim yet.
 *   2. WRITE ACCESS TO ONE OF THEM IS THE PROOF. The claimant commits a challenge token to the repository's
 *      default branch; the platform reads it back raw. Push access to the source repository is exactly the
 *      capability the registry already vouched for when it accepted the listing, so this proves the same thing
 *      the listing does, to the same standard, without the platform holding a GitHub credential.
 *
 * The token is DERIVED, not stored: an HMAC over (user, publisher) keyed by the platform's own signing secret.
 * That makes it stable across visits — a creator can start the claim, push the file the next day and finish —
 * with no challenge table, no expiry sweep, and no way for one user's token to verify another's claim. It is
 * not a secret in the usual sense (it ends up in a public repository); its whole job is to be unguessable by
 * someone who is not the account it names. */

// Only a github source can be verified this way — a raw read of its default branch is the whole mechanism.
// Other source kinds (a bare git url, a subdirectory) list fine and earn fine; they simply cannot carry the
// proof yet, and the creator surface says so rather than pretending the publisher is unknown.
const RegistrySchema = z.object({
    plugins: z
        .array(
            z.object({
                name: z.string(),
                source: z.union([
                    z.object({ source: z.literal(`github`), repo: z.string() }),
                    // Every other shape parses and is discarded — an unrecognized source must not fail the
                    // whole file, or one new listing kind takes every claim down with it.
                    z.looseObject({}),
                ]),
            }),
        )
        .default([]),
});

// The file a claimant commits, at the repository root of any repo the registry lists under their publisher.
export const CLAIM_PATH = `.intentic-claim`;

// `publisher.name` → `publisher`. The registry's key is the full extension id; claims are per publisher.
const publisherOf = (entryName: string): string => entryName.split(`.`)[0] ?? ``;

/* The challenge for one (user, publisher). Keyed by the platform's session-signing secret because it is the
 * one key every deployment is required to have — a derivation nobody outside the platform can reproduce is the
 * entire security property, and a second configurable key would be one more thing to leave unset. */
export const claimToken = (config: Config, userId: string, publisher: string): string =>
    `intentic-claim-${createHmac(`sha256`, config.betterAuth.secret).update(`${userId}:${publisher}`).digest(`hex`).slice(0, 32)}`;

// Constant-time compare of what the repository served against what this user's claim should carry. The file
// is trimmed, not parsed: a trailing newline from an editor is not a failed proof.
const tokenMatches = (served: string, expected: string): boolean => {
    const a = Buffer.from(served.trim(), `utf8`);
    const b = Buffer.from(expected, `utf8`);
    return a.length === b.length && timingSafeEqual(a, b);
};

export interface PublisherRepos {
    readonly publisher: string;
    // The subset of the caller's own projects that back this publisher — what the screen names back to them.
    readonly repos: readonly string[];
}

export interface RegistryReader {
    // Every github repository the registry lists under `publisher`, deduped, in listing order.
    readonly reposOf: (publisher: string) => Promise<readonly string[]>;
    /* THE QUESTION IN REVERSE: given repositories somebody already has, which publisher names do they back?
     *
     * This is what turns the claim from a name the creator has to remember into a name the screen already
     * knows. The claim screen sends the projects open in their workspace; a publisher comes back only when one
     * of those projects is listed under it — which is exactly the condition for the claim being provable. */
    readonly publishersOf: (projects: readonly string[]) => Promise<readonly PublisherRepos[]>;
}

// Repository slugs are compared case-insensitively throughout: github treats `Acme/Web` and `acme/web` as one
// repository, a git remote preserves whatever case was typed into it, and the registry carries whatever the
// listing's author wrote. Matching on the raw strings would make a claim fail on somebody's capital letter.
const slug = (repo: string): string => repo.toLowerCase();

/* The registry read, cached for a few minutes. Cached because a claim page reads it on every visit and the
 * file changes when somebody merges a pull request, not between two clicks; a few minutes stale costs a
 * creator one retry and costs GitHub nothing. A failed fetch is NOT cached — an outage must not pin an empty
 * answer in front of every claimant for the rest of the window. */
const CACHE_MS = 5 * 60 * 1000;

// One listing's github repository, or nothing — the shape both reads below are built out of.
const repoOf = (plugin: { source: unknown }): string | undefined => {
    const repo = (plugin.source as { source?: string; repo?: string }).repo;
    return typeof repo === `string` && repo !== `` ? repo : undefined;
};

export const registryReader = (config: Config, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): RegistryReader => {
    let cached: { at: number; plugins: readonly { name: string; source: unknown }[] } | undefined;
    const load = async (): Promise<readonly { name: string; source: unknown }[]> => {
        if (cached !== undefined && now().getTime() - cached.at < CACHE_MS) {
            return cached.plugins;
        }
        const response = await fetchFn(config.pool.registryUrl, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
            throw new Error(`registry read failed (HTTP ${response.status})`);
        }
        const parsed = RegistrySchema.safeParse(await response.json());
        if (!parsed.success) {
            throw new Error(`registry read failed (unreadable marketplace file)`);
        }
        cached = { at: now().getTime(), plugins: parsed.data.plugins };
        return parsed.data.plugins;
    };
    return {
        reposOf: async (publisher) => {
            const plugins = await load();
            const repos = plugins.filter((plugin) => publisherOf(plugin.name) === publisher).map(repoOf);
            return [...new Set(repos.filter((repo): repo is string => repo !== undefined))];
        },
        publishersOf: async (projects) => {
            const wanted = new Set(projects.map(slug));
            const plugins = await load();
            // Publisher → the caller's own projects backing it, deduped and in listing order. A Map keeps that
            // order, which is the order the screen offers the names in.
            const found = new Map<string, string[]>();
            for (const plugin of plugins) {
                const repo = repoOf(plugin);
                const publisher = publisherOf(plugin.name);
                if (repo === undefined || publisher === `` || !wanted.has(slug(repo))) {
                    continue;
                }
                const already = found.get(publisher) ?? [];
                if (!already.some((seen) => slug(seen) === slug(repo))) {
                    already.push(repo);
                }
                found.set(publisher, already);
            }
            return [...found].map(([publisher, repos]) => ({ publisher, repos }));
        },
    };
};

/* WHAT ONE REPOSITORY SAID when the platform looked. The distinction that earns its keep is `mismatched` vs
 * `absent`: a file that is there but carries somebody else's line means the creator pushed a token minted for a
 * different account, or to a repository someone else already claimed with — and telling them "no file found"
 * there sends them to push it again, which will fail again. */
export type ClaimOutcome = "matched" | "absent" | "mismatched" | "unreadable";

export interface ClaimAttempt {
    readonly repo: string;
    readonly outcome: ClaimOutcome;
}

export interface ClaimReport {
    // The repository that carried the proof — recorded on the claim, so a disputed slug can be retraced.
    readonly repo?: string;
    // Every repository looked at and what it said, in listing order. This is the whole point of the report: a
    // failed verify has to be able to say what was actually read, not just that it did not work.
    readonly attempts: readonly ClaimAttempt[];
}

/* Read the challenge file from every repository the registry lists under this publisher. Every repo is tried
 * because a publisher with several listings should not have to guess which one the platform will look at, and
 * any of them proves the same thing.
 *
 * Reads run in parallel and a missing file is an ordinary answer, not an error: on a publisher with a dozen
 * listings, eleven absences are the expected shape of a SUCCESSFUL claim. */
export const checkClaim = async (
    config: Config,
    reader: RegistryReader,
    userId: string,
    publisher: string,
    fetchFn: typeof fetch = fetch,
): Promise<ClaimReport> => {
    const repos = await reader.reposOf(publisher);
    if (repos.length === 0) {
        return { attempts: [] };
    }
    const expected = claimToken(config, userId, publisher);
    const attempts = await Promise.all(
        repos.map(async (repo): Promise<ClaimAttempt> => {
            try {
                const response = await fetchFn(`https://raw.githubusercontent.com/${repo}/HEAD/${CLAIM_PATH}`, {
                    signal: AbortSignal.timeout(15_000),
                });
                if (!response.ok) {
                    // 404 is the ordinary "not pushed yet". Anything else from a public raw read is the same
                    // absence as far as the claim goes, and splitting them would buy a distinction nobody acts on.
                    return { repo, outcome: `absent` };
                }
                return { repo, outcome: tokenMatches(await response.text(), expected) ? `matched` : `mismatched` };
            } catch {
                // A repository that times out or refuses the connection has not disproved anything — it just
                // could not be read this time. The claim fails as a whole only if none of them matched.
                return { repo, outcome: `unreadable` };
            }
        }),
    );
    const matched = attempts.find((attempt) => attempt.outcome === `matched`);
    return { ...(matched !== undefined ? { repo: matched.repo } : {}), attempts };
};

/* WHY THE CLAIM DID NOT GO THROUGH, as the sentence the creator reads. Written here rather than in the route
 * because it is the same domain knowledge as the check itself: which of these four shapes a report is in
 * decides what the creator should do next, and each of them has exactly one useful next move.
 *
 * Naming the repositories that were read is the part that matters most. The old message said only that nothing
 * carrying the token was readable, which is indistinguishable — from the creator's chair — from the platform
 * not having looked. */
export const claimFailureReason = (publisher: string, report: ClaimReport): string => {
    const { attempts } = report;
    if (attempts.length === 0) {
        return `The registry lists no GitHub-backed extension under ${publisher}, so there is nothing to prove ownership against yet.`;
    }
    const mismatched = attempts.filter((attempt) => attempt.outcome === `mismatched`).map((attempt) => attempt.repo);
    if (mismatched.length > 0) {
        return (
            `${mismatched.join(`, `)} already carries a ${CLAIM_PATH}, but not the line minted for your account. ` +
            `Replace its contents with the line shown here and push again.`
        );
    }
    const unreadable = attempts.filter((attempt) => attempt.outcome === `unreadable`).map((attempt) => attempt.repo);
    if (unreadable.length === attempts.length) {
        return `None of ${attempts.map((attempt) => attempt.repo).join(`, `)} could be read just now. That is GitHub, not you — try again in a moment.`;
    }
    const read = attempts.length - unreadable.length;
    const looked =
        attempts.length === 1
            ? `Read ${attempts[0]?.repo}`
            : read === attempts.length
              ? `Read all ${read} repositories listed under ${publisher}`
              : `Read ${read} of the ${attempts.length} repositories listed under ${publisher}`;
    return (
        `${looked} — no ${CLAIM_PATH} on the default branch yet. ` +
        `A push that landed on another branch does not count: the file has to be on the branch GitHub shows first.`
    );
};
