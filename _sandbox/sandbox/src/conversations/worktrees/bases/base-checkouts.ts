import { randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { undefinedIfMissing } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { BaseAsk, BaseCheckout, BaseEnsured } from "@intentic/sandbox-contract/schemas/bases";
import type { Logger } from "pino";
import type { Services } from "../../../composition.js";
import { mainLineSha } from "../../../git/main-line-tip.js";
import { commonDirOf, gitDirOf } from "../../../store/git/git-dir.js";
import { readHistorySpace } from "../../../system/resources/storage/checkout-admission.js";
import { checkoutRefusal, checkoutSpace, type HistorySpace } from "../../../system/resources/storage/checkout-space.js";
import { namedByProgram, readRunningPrograms, type RunningProgram } from "../../../system/resources/storage/running-programs.js";
import { removeQuietly } from "../build-outputs/build-outputs.js";
import { warmCheckout, type WarmRequest } from "../build-outputs/warm-checkout.js";
import type { SeedOutcome } from "../build-outputs/warm-seed.js";
import { discoverRepos } from "../../../workspace/layout/repo-discovery.js";

// "BEFORE" IS ONE COMMAND (2026-11-19). To compare their change with what it changed, agents built the old version by
// hand in 11 of 14 deep-read build sessions of the shinobi-society audit: `git archive HEAD | tar -x` and a 9-minute
// cold build, binaries copied aside 18 times, their own uncommitted work reverted to build a baseline and re-applied
// three times, and a private clone whose edits were lost. The copies broke, since a binary carries the absolute paths it
// was built at. A base is that old version kept by the sandbox: a detached worktree of one repository at one commit,
// at `<history>/bases/<repo>/<sha12>`, made by the daemon under the repository's lock like a conversation's checkout and
// never inside one, its Cargo targets seeded from a build that already ran (build-outputs/warm-checkout.ts).
//
// - One per commit, shared: a conversation asking for it holds it (a file under `<sha12>.holds/` named for it, its time
//   the last ask), and it goes once no live conversation asked for HOLD_IDLE_MS and nothing runs inside it, at the
//   hourly sweep, at once when its last holder lets go, or first under disk pressure, least recently used first.
// - Read-only by contract, not by mode bits (the agent runs as root, which they would not stop): it is handed out
//   restored to its commit, so a stray edit lasts until the next ask.
// - Builds write into it (its own `target/`), which is what keeps a "before" binary's embedded paths alive as long as
//   the base is. Nothing is mirrored in from the main checkout: an install run there would write through a link into the
//   main checkout's node_modules, so a JavaScript base gets its own install (`base run pnpm install --offline`).

export const basesRoot = (historyRoot: string): string => join(historyRoot, "bases");

// A hold no conversation renewed for this long no longer keeps its base.
export const HOLD_IDLE_MS = 24 * 60 * 60 * 1000;
// Who holds a base asked for from a shell no conversation owns.
export const SHELL_HOLDER = "shell";
const HOLDS = ".holds";
const REMOVING = ".removing-";
const FULL_SHA = /^[0-9a-f]{40}$/u;

// A refusal worded for the agent asking: what is wrong with the ask, and what to do instead.
export class BaseRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BaseRefused";
    }
}

export interface BaseCheckoutsDeps {
    readonly historyRoot: string;
    readonly mainDir: (repo: string) => string;
    readonly withRepoLock: <T>(repo: string, task: () => Promise<T>) => Promise<T>;
    // Every repository of the workspace by id ("root" and the nested ones).
    readonly repos: () => Promise<readonly string[]>;
    // Whether a conversation is still on the board: only a live one's hold keeps a base.
    readonly live: (id: string) => boolean;
    // Seeds the base's Cargo targets (warm-checkout.ts warmCheckout).
    readonly warm: (request: WarmRequest) => Promise<SeedOutcome[]>;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly git?: GitRunner;
    readonly space?: () => Promise<HistorySpace>;
    readonly programs?: () => Promise<readonly RunningProgram[]>;
}

interface Located {
    readonly repo: string;
    readonly commit: string;
    readonly dir: string;
}

interface Hold {
    readonly holder: string;
    readonly at: number;
}

export interface BaseCheckouts {
    readonly ensure: (ask: BaseAsk, holder: string) => Promise<BaseEnsured>;
    readonly list: () => Promise<BaseCheckout[]>;
    // Lets go of the base an ask names, or of every base the holder holds; answers the paths let go and those removed.
    readonly release: (holder: string, ask: BaseAsk | "all") => Promise<{ released: string[]; removed: string[] }>;
    // The hourly pass: holds past HOLD_IDLE_MS or of conversations gone are dropped, and unheld bases removed.
    readonly sweep: (now: number) => Promise<string[]>;
    // Under disk pressure: unused bases removed, the unheld then the least recently used first, until `enough`.
    readonly relieve: (enough: () => Promise<boolean>) => Promise<number>;
}

const repoDirName = (repo: string): string => encodeURIComponent(repo);
const holdsOf = (dir: string): string => `${dir}${HOLDS}`;

const readHolds = async (dir: string): Promise<Hold[]> => {
    const names = (await readdir(holdsOf(dir)).catch(undefinedIfMissing)) ?? [];
    const holds = await Promise.all(names.map(async (holder) => ({ holder, at: (await stat(join(holdsOf(dir), holder)).catch(undefinedIfMissing))?.mtimeMs ?? 0 })));
    return holds.toSorted((left, right) => right.at - left.at);
};

// What every step below shares: the deps, the git it runs, where bases live, and the per-base lock.
interface Context {
    readonly deps: BaseCheckoutsDeps;
    readonly git: GitRunner;
    readonly root: string;
    // One ask, release or removal of a base at a time (baseLock).
    readonly locked: <T>(dir: string, task: () => Promise<T>) => Promise<T>;
    readonly programs: () => Promise<readonly RunningProgram[]>;
}

const commonOf = async (checkout: string): Promise<string | undefined> => {
    const gitDir = await gitDirOf(checkout);
    return gitDir === undefined ? undefined : realpath(await commonDirOf(gitDir)).catch(undefinedIfMissing);
};

// The workspace repository whose git dir the asking checkout shares.
const repoOf = async (ctx: Context, gitDir: string): Promise<string> => {
    const asked = await realpath(gitDir).catch(() => gitDir);
    for (const repo of await ctx.deps.repos()) {
        if ((await commonOf(ctx.deps.mainDir(repo))) === asked) {
            return repo;
        }
    }
    throw new BaseRefused(`${gitDir} is not the git dir of a repository in this workspace: run base from inside one of its checkouts.`);
};

// The commit an ask names: the fork point (merge-base of the asker's HEAD and the main line), main's tip, or a sha.
const commitOf = async (ctx: Context, repo: string, ask: BaseAsk): Promise<string> => {
    const main = ctx.deps.mainDir(repo);
    const at = ask.at ?? "fork";
    if (at !== "fork" && at !== "main") {
        const found = await ctx.git(main, ["cat-file", "-e", `${at}^{commit}`]).then(
            () => true,
            () => false,
        );
        if (!found) {
            throw new BaseRefused(`${at} is not a commit of ${repo}.`);
        }
        return at;
    }
    const tip = await mainLineSha(main, ctx.git);
    if (tip === undefined) {
        throw new BaseRefused(`${repo} has no commit on its main line yet.`);
    }
    if (at === "main") {
        return tip;
    }
    if (ask.head === undefined) {
        throw new BaseRefused("Name the checkout's HEAD to measure the fork point from, or ask for --at main or a commit.");
    }
    const { stdout } = await ctx.git(main, ["merge-base", ask.head, tip]).catch(() => {
        throw new BaseRefused(`${ask.head ?? ""} shares no history with ${repo}'s main line: ask for --at main or a commit.`);
    });
    return stdout.trim();
};

const locate = async (ctx: Context, ask: BaseAsk): Promise<Located> => {
    const repo = await repoOf(ctx, ask.gitDir);
    const commit = await commitOf(ctx, repo, ask);
    if (!FULL_SHA.test(commit)) {
        throw new BaseRefused(`could not read the commit to make a base of in ${repo}.`);
    }
    return { repo, commit, dir: join(ctx.root, repoDirName(repo), commit.slice(0, 12)) };
};

const headOf = (ctx: Context, dir: string): Promise<string | undefined> =>
    ctx.git(dir, ["rev-parse", "HEAD"]).then(
        ({ stdout }) => stdout.trim(),
        // allow(silent-catch): a folder git cannot read there is no base, which is the answer.
        () => undefined,
    );

// Takes a base off the disk: moved aside and its worktree link pruned under the repo's lock, then removed at low
// priority, so the repository is never held while gigabytes of build output go.
const removeBase = async (ctx: Context, base: Located): Promise<void> => {
    const aside = join(ctx.root, `${REMOVING}${randomBytes(4).toString("hex")}`);
    await ctx.deps.withRepoLock(base.repo, async () => {
        await rename(base.dir, aside).catch(undefinedIfMissing);
        // allow(silent-catch): a link prune cannot drop is dropped by the next; the folder is gone either way.
        await ctx.git(ctx.deps.mainDir(base.repo), ["worktree", "prune"]).catch(() => undefined);
    });
    await rm(holdsOf(base.dir), { recursive: true, force: true });
    await removeQuietly(aside);
};

// Adds the base under the repo's lock, or restores one standing to its commit; true when this call made it.
const standUp = async (ctx: Context, base: Located): Promise<boolean> => {
    if ((await headOf(ctx, base.dir)) === base.commit) {
        const { stdout } = await ctx.git(base.dir, ["status", "--porcelain", "--untracked-files=no"]);
        if (stdout.trim() !== "") {
            ctx.deps.logger.warn({ base: base.dir }, "bases: a base's tracked files were edited; restored to its commit");
            await ctx.git(base.dir, ["reset", "--hard", "-q"]);
        }
        return false;
    }
    if ((await stat(base.dir).catch(undefinedIfMissing)) !== undefined) {
        await removeBase(ctx, base);
    }
    const space = await (ctx.deps.space ?? (() => readHistorySpace(ctx.deps.historyRoot)))();
    if (!checkoutSpace(space, 0).allowed) {
        throw new BaseRefused(checkoutRefusal(space.freeBytes, 0, space.limitedBy));
    }
    await mkdir(dirname(base.dir), { recursive: true });
    await ctx.deps.withRepoLock(base.repo, () => ctx.git(ctx.deps.mainDir(base.repo), ["worktree", "add", "--detach", "-q", base.dir, base.commit]));
    return true;
};

const hold = async (dir: string, holder: string): Promise<void> => {
    await mkdir(holdsOf(dir), { recursive: true });
    const path = join(holdsOf(dir), encodeURIComponent(holder));
    await writeFile(path, "");
    const now = new Date();
    await utimes(path, now, now);
};

const describe = async (base: Located): Promise<BaseCheckout> => {
    const holds = await readHolds(base.dir);
    return { repo: base.repo, commit: base.commit, path: base.dir, holders: holds.map((entry) => decodeURIComponent(entry.holder)), usedAt: holds[0]?.at ?? 0 };
};

// Every base on disk, read off its folder and its HEAD.
const standing = async (ctx: Context): Promise<Located[]> => {
    const found: Located[] = [];
    for (const repoDir of (await readdir(ctx.root).catch(undefinedIfMissing)) ?? []) {
        for (const name of (await readdir(join(ctx.root, repoDir)).catch(undefinedIfMissing)) ?? []) {
            const dir = join(ctx.root, repoDir, name);
            const commit = name.endsWith(HOLDS) ? undefined : await headOf(ctx, dir);
            if (commit !== undefined) {
                found.push({ repo: decodeURIComponent(repoDir), commit, dir });
            }
        }
    }
    return found;
};

const holdKeeps = (ctx: Context, entry: Hold, now: number): boolean => {
    const holder = decodeURIComponent(entry.holder);
    return now - entry.at < HOLD_IDLE_MS && (holder === SHELL_HOLDER || ctx.deps.live(holder));
};

const heldAt = (ctx: Context, holds: readonly Hold[], now: number): boolean => holds.some((entry) => holdKeeps(ctx, entry, now));

// Removes a base nothing runs in and `keep` lets go of, under its lock; true when it went.
const removeIfUnused = (ctx: Context, base: Located, keep: (holds: readonly Hold[]) => boolean): Promise<boolean> =>
    ctx.locked(base.dir, async () => {
        if (keep(await readHolds(base.dir)) || namedByProgram(await ctx.programs(), base.dir)) {
            return false;
        }
        await removeBase(ctx, base);
        return true;
    });

// Removing-aside folders a stopped daemon left, and holds of bases no longer standing.
const sweepLeftovers = async (root: string): Promise<void> => {
    for (const name of (await readdir(root).catch(undefinedIfMissing)) ?? []) {
        if (name.startsWith(REMOVING)) {
            await removeQuietly(join(root, name));
            continue;
        }
        for (const entry of (await readdir(join(root, name)).catch(undefinedIfMissing)) ?? []) {
            const dir = join(root, name, entry.slice(0, -HOLDS.length));
            if (entry.endsWith(HOLDS) && (await stat(dir).catch(undefinedIfMissing)) === undefined) {
                await rm(join(root, name, entry), { recursive: true, force: true });
            }
        }
    }
};

const ensureBase = async (ctx: Context, ask: BaseAsk, holder: string): Promise<BaseEnsured> => {
    const base = await locate(ctx, ask);
    const created = await ctx.locked(base.dir, async () => {
        const made = await standUp(ctx, base);
        await hold(base.dir, holder);
        return made;
    });
    if (created) {
        ctx.deps.logger.info({ repo: base.repo, commit: base.commit, holder }, "bases: made a base checkout");
    }
    const warm = await ctx.deps.warm({
        checkouts: [{ repo: base.repo, dir: base.dir }],
        preferred: holder === SHELL_HOLDER ? undefined : holder,
        exclude: [],
        label: `base ${base.repo}@${base.commit.slice(0, 12)}`,
    });
    return { ...(await describe(base)), created, warm: warm.map(({ rel, state, from, reason }) => ({ rel, state, from, reason })) };
};

const releaseBases = async (ctx: Context, holder: string, ask: BaseAsk | "all"): Promise<{ released: string[]; removed: string[] }> => {
    const bases = ask === "all" ? await standing(ctx) : [await locate(ctx, ask)];
    const released: string[] = [];
    const removed: string[] = [];
    for (const base of bases) {
        const path = join(holdsOf(base.dir), encodeURIComponent(holder));
        if ((await stat(path).catch(undefinedIfMissing)) === undefined) {
            continue;
        }
        await ctx.locked(base.dir, () => rm(path, { force: true }));
        released.push(base.dir);
        if (await removeIfUnused(ctx, base, (holds) => heldAt(ctx, holds, Date.now()))) {
            removed.push(base.dir);
        }
    }
    return { released, removed };
};

const sweepBases = async (ctx: Context, now: number): Promise<string[]> => {
    await sweepLeftovers(ctx.root);
    const removed: string[] = [];
    for (const base of await standing(ctx)) {
        if (await removeIfUnused(ctx, base, (holds) => heldAt(ctx, holds, now))) {
            removed.push(base.dir);
        }
    }
    if (removed.length > 0) {
        ctx.deps.logger.info({ removed }, "bases: removed base checkouts no conversation asked for lately");
    }
    return removed;
};

const relieveBases = async (ctx: Context, enough: () => Promise<boolean>): Promise<number> => {
    const now = Date.now();
    const ranked = await Promise.all((await standing(ctx)).map(async (base) => ({ base, holds: await readHolds(base.dir) })));
    // Unheld first, then the least recently asked for.
    ranked.sort(
        (left, right) => Number(heldAt(ctx, left.holds, now)) - Number(heldAt(ctx, right.holds, now)) || (left.holds[0]?.at ?? 0) - (right.holds[0]?.at ?? 0),
    );
    let removed = 0;
    for (const { base } of ranked) {
        if (await enough()) {
            break;
        }
        if (await removeIfUnused(ctx, base, () => false)) {
            removed += 1;
        }
    }
    return removed;
};

// One ask, release or removal of a base at a time, across every instance: the routes' and the housekeeping's.
const baseLock = keyedLock<string>();

export const createBaseCheckouts = (deps: BaseCheckoutsDeps): BaseCheckouts => {
    const ctx: Context = {
        deps,
        git: deps.git ?? defaultGit,
        root: basesRoot(deps.historyRoot),
        locked: baseLock,
        programs: deps.programs ?? readRunningPrograms,
    };
    return {
        ensure: (ask, holder) => ensureBase(ctx, ask, holder),
        list: async () => Promise.all((await standing(ctx)).map((base) => describe(base))),
        release: (holder, ask) => releaseBases(ctx, holder, ask),
        sweep: (now) => sweepBases(ctx, now),
        relieve: (enough) => relieveBases(ctx, enough),
    };
};

// The daemon's base checkouts over its own worktrees, registry and workspace; the routes and the housekeeping share
// them, and their per-base lock is the module's.
export const baseCheckoutsOf = (services: Pick<Services, "config" | "agentWorktrees" | "agents" | "workspace" | "logger">): BaseCheckouts => {
    const { agentWorktrees, logger } = services;
    const historyRoot = services.config.historyRoot;
    return createBaseCheckouts({
        historyRoot,
        mainDir: agentWorktrees.mainDir,
        withRepoLock: agentWorktrees.withRepoLock,
        repos: async () => ["root", ...(await discoverRepos(services.workspace.root))],
        live: (id) => {
            const entry = services.agents.entry(id);
            return entry !== undefined && entry.archivedAt === undefined;
        },
        warm: (request) =>
            warmCheckout({ historyRoot, worktreesRoot: join(historyRoot, "worktrees"), mainDir: agentWorktrees.mainDir, worktreeDir: agentWorktrees.worktreeDir, logger }, request),
        logger,
    });
};
