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

export interface RegistryReader {
    // Every github repository the registry lists under `publisher`, deduped, in listing order.
    readonly reposOf: (publisher: string) => Promise<readonly string[]>;
}

/* The registry read, cached for a few minutes. Cached because a claim page reads it on every visit and the
 * file changes when somebody merges a pull request, not between two clicks; a few minutes stale costs a
 * creator one retry and costs GitHub nothing. A failed fetch is NOT cached — an outage must not pin an empty
 * answer in front of every claimant for the rest of the window. */
const CACHE_MS = 5 * 60 * 1000;

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
            const repos = plugins
                .filter((plugin) => publisherOf(plugin.name) === publisher)
                .map((plugin) => (plugin.source as { source?: string; repo?: string }).repo)
                .filter((repo): repo is string => typeof repo === `string` && repo !== ``);
            return [...new Set(repos)];
        },
    };
};

export interface ClaimCheck {
    // Which repository carried the proof — recorded on the claim, so a disputed slug can be retraced.
    readonly repo: string;
}

/* Read the challenge file from every repository the registry lists under this publisher, and answer with the
 * first that carries this user's token. Every repo is tried because a publisher with several listings should
 * not have to guess which one the platform will look at, and any of them proves the same thing.
 *
 * Reads run in parallel and a missing file is an ordinary answer, not an error: on a publisher with a dozen
 * listings, eleven 404s are the expected shape of a successful claim. */
export const checkClaim = async (
    config: Config,
    reader: RegistryReader,
    userId: string,
    publisher: string,
    fetchFn: typeof fetch = fetch,
): Promise<ClaimCheck | undefined> => {
    const repos = await reader.reposOf(publisher);
    if (repos.length === 0) {
        return undefined;
    }
    const expected = claimToken(config, userId, publisher);
    const attempts = await Promise.all(
        repos.map(async (repo) => {
            try {
                const response = await fetchFn(`https://raw.githubusercontent.com/${repo}/HEAD/${CLAIM_PATH}`, {
                    signal: AbortSignal.timeout(15_000),
                });
                if (!response.ok) {
                    return undefined;
                }
                return tokenMatches(await response.text(), expected) ? { repo } : undefined;
            } catch {
                // A repository that times out or refuses the connection has not disproved anything — it just
                // did not carry the proof this time. The claim fails as a whole only if none of them did.
                return undefined;
            }
        }),
    );
    return attempts.find((attempt): attempt is ClaimCheck => attempt !== undefined);
};
