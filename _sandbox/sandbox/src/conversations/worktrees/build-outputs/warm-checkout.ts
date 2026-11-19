import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { undefinedIfMissing } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { readHistorySpace } from "../../../system/resources/storage/checkout-admission.js";
import { checkoutSpace, GIB, type HistorySpace } from "../../../system/resources/storage/checkout-space.js";
import { walkDirs } from "../../../workspace/layout/dir-walk.js";
import { cargoTagged } from "./build-outputs.js";
import { linksAcross, localPackages, profilesOf, type SeedOutcome, seedTarget, warmSeedsRoot } from "./warm-seed.js";

// WHICH BUILD A NEW CHECKOUT STARTS FROM (2026-11-19). warm-seed.ts copies one target into another; this picks, for each
// Cargo workspace of a new checkout, the target to copy: the checkout the caller names first (a spawned child's parent,
// the conversation asking for a base), else whichever of the main checkout and the other conversations' checkouts built
// that workspace with the same Cargo.lock, one it can link from before one it must copy, most recently. Runs behind the agent's start, one seed at a time across the
// daemon (each reads a source's whole target, and a fan-out's children all read their parent's), bounded by COPY_CAP,
// the history volume's floor and SEED_DEADLINE_MS. A seeded target is part of the checkout, so it goes with it: removal,
// retirement and the build-output sweeps take it like one the checkout built.

// The most one seed copies rather than links: about what one Rust checkout's build output was priced at
// (build-output-estimate.ts), since linking from a checkout on the same mount copies little and a source on another
// mount (the main checkout, where /work and /history are separate volumes) copies every byte.
const COPY_CAP = 8 * GIB;
const SEED_DEADLINE_MS = 10 * 60 * 1000;
// Other conversations' checkouts looked at as sources, most recently touched first.
const SIBLINGS_READ = 48;
// Folders walked for Cargo manifests, as deep as cargo-warm.ts walks for workspaces.
const WALK_DEPTH = 4;
const WALK_BUDGET = 5_000;
// A staging folder no seed finished: one older than this belongs to a daemon that stopped mid-copy.
const STAGING_STALE_MS = 2 * SEED_DEADLINE_MS;

export interface WarmCheckoutDeps {
    readonly historyRoot: string;
    // Every conversation's checkouts (worktrees.ts conversationDir's parent).
    readonly worktreesRoot: string;
    readonly mainDir: (repo: string) => string;
    readonly worktreeDir: (id: string, repo: string) => string;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly space?: () => Promise<HistorySpace>;
    readonly git?: GitRunner;
}

export interface WarmRequest {
    // What the new checkout holds, repo by repo, and where each stands on disk.
    readonly checkouts: readonly { readonly repo: string; readonly dir: string }[];
    // The conversation whose checkouts are the first choice of source, if any.
    readonly preferred: string | undefined;
    // Conversations never read as a source: the new checkout's own.
    readonly exclude: readonly string[];
    // Says which checkout was seeded in the log.
    readonly label: string;
}

// A checkout that may lend its target: whose it is (a conversation, or undefined for the main checkout), and where.
interface Candidate {
    readonly owner: string | undefined;
    readonly dir: string;
}

interface Lender extends Candidate {
    readonly lockMatches: boolean;
    // Whether its files can be hard-linked into the staging folder (the same mount), so it lends without copying.
    readonly linkable: boolean;
    readonly builtAt: number;
}

// Folders of a checkout holding a Cargo.toml, checkout-relative ("" the root); never into a target or the shelf.
export const cargoDirsOf = async (checkout: string): Promise<string[]> => {
    const found: string[] = [];
    await walkDirs(checkout, { maxDepth: WALK_DEPTH, maxDirs: WALK_BUDGET }, (dir, entries, subdirs) => {
        if (entries.some((entry) => entry.isFile() && entry.name === "Cargo.toml")) {
            found.push(dir.rel);
        }
        return Promise.resolve(subdirs.filter((subdir) => subdir.name !== "target" && (dir.rel !== "" || subdir.name !== "refs")));
    });
    return found.toSorted();
};

const mtimeOf = async (path: string): Promise<number> => (await stat(path).catch(undefinedIfMissing))?.mtimeMs ?? 0;

// When a target was last built into, near enough to rank lenders: the newest of its profile folders and the folders
// Cargo adds a unit to.
const builtAtOf = async (target: string): Promise<number> => {
    const times = await Promise.all(
        (await profilesOf(target)).flatMap((profile) => ["", "build", "deps", ".fingerprint"].map((part) => mtimeOf(join(target, profile, part)))),
    );
    return Math.max(0, ...times);
};

const sameLock = async (left: string, right: string): Promise<boolean> => {
    const [one, two] = await Promise.all([readFile(left).catch(undefinedIfMissing), readFile(right).catch(undefinedIfMissing)]);
    return one !== undefined && two !== undefined && one.equals(two);
};

// The other conversations whose checkouts may lend, most recently touched first.
const siblingsOf = async (deps: WarmCheckoutDeps, exclude: readonly string[]): Promise<string[]> => {
    const ids = ((await readdir(deps.worktreesRoot).catch(undefinedIfMissing)) ?? []).filter((id) => !exclude.includes(id));
    const touched = await Promise.all(ids.map(async (id) => ({ id, at: await mtimeOf(join(deps.worktreesRoot, id)) })));
    return touched
        .toSorted((left, right) => right.at - left.at)
        .slice(0, SIBLINGS_READ)
        .map(({ id }) => id);
};

const dirOf = (deps: WarmCheckoutDeps, owner: string | undefined, repo: string): string => (owner === undefined ? deps.mainDir(repo) : deps.worktreeDir(owner, repo));

// The lender for one workspace: the preferred checkout when it built it, else the best of the rest by lock, then by
// whether it lends by links rather than copies (another conversation's checkout on the history volume over the main
// checkout on its own), then age.
const lenderFor = async (deps: WarmCheckoutDeps, rel: string, dest: string, preferred: Candidate | undefined, rest: readonly Candidate[]): Promise<Candidate | undefined> => {
    if (preferred !== undefined && (await cargoTagged(join(preferred.dir, rel, "target")))) {
        return preferred;
    }
    const staging = warmSeedsRoot(deps.historyRoot);
    await mkdir(staging, { recursive: true });
    const lenders: Lender[] = [];
    for (const candidate of rest) {
        const target = join(candidate.dir, rel, "target");
        if (await cargoTagged(target)) {
            const [lockMatches, linkable, builtAt] = await Promise.all([
                sameLock(join(dest, rel, "Cargo.lock"), join(candidate.dir, rel, "Cargo.lock")),
                linksAcross(join(target, "CACHEDIR.TAG"), staging),
                builtAtOf(target),
            ]);
            lenders.push({ ...candidate, lockMatches, linkable, builtAt });
        }
    }
    return lenders.toSorted(
        (left, right) => Number(right.lockMatches) - Number(left.lockMatches) || Number(right.linkable) - Number(left.linkable) || right.builtAt - left.builtAt,
    )[0];
};

// Whether git ignores the target's place in the new checkout: a seed git would stage is never made.
const ignored = (git: GitRunner, checkout: string, rel: string): Promise<boolean> =>
    git(checkout, ["check-ignore", "-q", "--", rel === "" ? "target" : `${rel}/target`]).then(
        () => true,
        // allow(silent-catch): check-ignore exits 1 for a path it does not ignore, which is its answer.
        () => false,
    );

// Staging folders a stopped daemon left; only ever called inside the seed queue, so none of them is in flight.
const sweepStaging = async (root: string, now: number): Promise<void> => {
    for (const name of (await readdir(root).catch(undefinedIfMissing)) ?? []) {
        if (now - (await mtimeOf(join(root, name))) > STAGING_STALE_MS) {
            await rm(join(root, name), { recursive: true, force: true });
        }
    }
};

// One seed at a time across the daemon.
const queue = keyedLock<string>();

interface RepoSeed {
    // The new checkout of one repo.
    readonly dir: string;
    readonly candidates: { readonly preferred: Candidate | undefined; readonly rest: readonly Candidate[] };
    // Every repo the new checkout holds, and where each stands.
    readonly repos: readonly string[];
    readonly ownDirs: readonly string[];
}

// Every workspace of one repo's new checkout seeded from its lender, one after another.
const seedRepo = async (deps: WarmCheckoutDeps, request: RepoSeed, deadline: number): Promise<SeedOutcome[]> => {
    const git = deps.git ?? defaultGit;
    const space = deps.space ?? (() => readHistorySpace(deps.historyRoot));
    const outcomes: SeedOutcome[] = [];
    for (const rel of await cargoDirsOf(request.dir)) {
        const target = rel === "" ? "target" : `${rel}/target`;
        if ((await lstat(join(request.dir, target)).catch(undefinedIfMissing)) !== undefined) {
            continue;
        }
        const lender = await lenderFor(deps, rel, request.dir, request.candidates.preferred, request.candidates.rest);
        if (lender === undefined) {
            continue;
        }
        if (!(await ignored(git, request.dir, rel))) {
            outcomes.push({ rel: target, state: "skipped", reason: "git does not ignore it here, so a seeded target would be staged" });
            continue;
        }
        // The lender's own checkouts of every repo the new checkout holds: a path dependency into a sibling repo is
        // the checkout's own crate as much as one in this repo.
        const lenderDirs = request.repos.map((repo) => dirOf(deps, lender.owner, repo));
        const local = await localPackages([...request.ownDirs, ...lenderDirs], git);
        outcomes.push(
            await seedTarget({
                source: join(lender.dir, target),
                dest: join(request.dir, target),
                rel: target,
                local,
                stagingRoot: warmSeedsRoot(deps.historyRoot),
                limits: { copyBytes: COPY_CAP, deadline },
                roomFor: async (bytes) => checkoutSpace(await space(), bytes).allowed,
            }),
        );
    }
    return outcomes;
};

/**
 * Seeds every Cargo target a new checkout lacks from the best lender, and answers what it did per target. Queued behind
 * any seed already running; never throws.
 */
export const warmCheckout = (deps: WarmCheckoutDeps, request: WarmRequest): Promise<SeedOutcome[]> =>
    queue("seed", async () => {
        const deadline = Date.now() + SEED_DEADLINE_MS;
        try {
            await sweepStaging(warmSeedsRoot(deps.historyRoot), Date.now());
            const siblings = await siblingsOf(deps, [...request.exclude, ...(request.preferred === undefined ? [] : [request.preferred])]);
            const outcomes: SeedOutcome[] = [];
            for (const { repo, dir } of request.checkouts) {
                const preferred = request.preferred === undefined ? undefined : { owner: request.preferred, dir: deps.worktreeDir(request.preferred, repo) };
                const rest = [undefined, ...siblings].map((owner) => ({ owner, dir: dirOf(deps, owner, repo) }));
                const repos = request.checkouts.map((checkout) => checkout.repo);
                const ownDirs = request.checkouts.map((checkout) => checkout.dir);
                outcomes.push(...(await seedRepo(deps, { dir, candidates: { preferred, rest }, repos, ownDirs }, deadline)));
            }
            for (const outcome of outcomes) {
                deps.logger.info({ checkout: request.label, ...outcome }, outcome.state === "seeded" ? "warm builds: seeded a new checkout's Cargo target" : "warm builds: left a Cargo target cold");
            }
            return outcomes;
        } catch (error) {
            deps.logger.warn({ err: error, checkout: request.label }, "warm builds: could not seed a new checkout's build output; it builds cold");
            return [];
        }
    });
