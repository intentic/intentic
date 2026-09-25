import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { MainlinePushRecheckResult } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { isValidRepoId } from "../layout/repo-discovery.js";
import { openCount, parsePushReport, type PushChecksStore, type PushRefusal, type PushReportEntry } from "./push-checks-store.js";

// Files what the pre-push hook leaves in a repository's git common dir (`intentic-push-report.json`, newest first, at most
// ten entries) into the push-checks store, and measures a project again on request. A push is filed only once its head
// is on the remote-tracking ref it moved, so a push the remote refused leaves nothing behind; its measurement of the
// tree still counts. The ref feed says when to look (bootstrap/change-reactions.ts); nothing here polls.

export const PUSH_REPORT_FILE = "intentic-push-report.json";
// How long a push not yet on its remote-tracking ref is looked at again on each ref move before it is taken as refused.
const REFUSED_AFTER_MS = 60 * 60_000;
// A recheck measures every check and the linter over the main tree: seconds usually, never this long.
const RECHECK_TIMEOUT_MS = 3 * 60_000;
const RECHECK_BUFFER = 64 * 1024 * 1024;

export interface PushChecksDeps {
    readonly root: string;
    readonly store: PushChecksStore;
    readonly logger: Pick<Logger, "warn">;
    readonly git?: GitRunner;
    readonly now?: () => number;
}

// What one read of a project's report filed.
export interface PushIngest {
    // Whether any entry was filed or set aside, which is when the main line's readers are told.
    readonly changed: boolean;
    // How many recheck entries were filed.
    readonly rechecks: number;
    // How many findings their measurements found gone.
    readonly resolved: number;
}

export interface PushChecks {
    readonly store: PushChecksStore;
    // Files whatever the project's report holds that is new.
    readonly ingest: (project: string) => Promise<PushIngest>;
    // Runs the project's own recheck over its main tree and files what it measured; one at a time per project.
    readonly recheck: (project: string) => Promise<MainlinePushRecheckResult>;
    // The same, only when the project has an open finding to measure; undefined when it has none.
    readonly recheckIfOpen: (project: string) => Promise<MainlinePushRecheckResult | undefined>;
    // Sets open findings aside, or opens named dismissed ones again; how many changed.
    readonly dismiss: (project: string, ids: readonly string[] | undefined, restore: boolean) => Promise<number>;
    // The daemon's own push runs (git/ops/push-run.ts): one the repository's hook refused is filed as a push whose
    // finding is what the hook said, and one that went answers every refusal before it.
    readonly refused: (project: string, refusal: PushRefusal) => Promise<void>;
    readonly pushed: (project: string, at: number) => Promise<void>;
}

// The project a ref-feed repo id names: "root" is the workspace root, whose project folder is empty.
export const projectOfRepo = (repo: string): string => (repo === "root" ? "" : repo);

// The project's checkout, or undefined for a name that could step outside the workspace.
const repoDirOf = (root: string, project: string): string | undefined =>
    project === "" ? root : isValidRepoId(project) ? join(root, project) : undefined;

// The recheck argv's script, when it is `node <file inside the repository>`: nothing else a report names is run.
const recheckScript = async (dir: string, argv: readonly string[]): Promise<string | undefined> => {
    const script = argv[1];
    if (argv[0] !== "node" || script === undefined || script === "" || isAbsolute(script)) {
        return undefined;
    }
    const path = resolve(dir, script);
    const inside = relative(dir, path);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
        return undefined;
    }
    const found = await stat(path).catch(undefinedIfMissing);
    return found?.isFile() === true ? path : undefined;
};

// Stdin closed at once: a recheck that waits for input would otherwise hold its slot until the timeout.
const runNode = (args: readonly string[], cwd: string): Promise<void> =>
    new Promise((settle, fail) => {
        const child = execFile("node", [...args], { cwd, env: process.env, timeout: RECHECK_TIMEOUT_MS, maxBuffer: RECHECK_BUFFER }, (error) =>
            error === null ? settle() : fail(error),
        );
        child.stdin?.end();
    });

const NOTHING: PushIngest = { changed: false, rechecks: 0, resolved: 0 };

export const createPushChecks = (deps: PushChecksDeps): PushChecks => {
    const git = deps.git ?? defaultGit;
    const now = deps.now ?? Date.now;
    // Asked of git once per checkout: a relocated git dir and a linked worktree both answer here, and neither moves.
    const commonDirs = new Map<string, string>();
    const commonDirOf = async (dir: string): Promise<string | undefined> => {
        const known = commonDirs.get(dir);
        if (known !== undefined) {
            return known;
        }
        try {
            const { stdout } = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
            const common = stdout.trim();
            commonDirs.set(dir, common);
            return common;
        } catch {
            // allow(silent-catch): not a repository (yet), or one mid-removal, has no report; the next ref move asks again
            return undefined;
        }
    };
    const reportOf = async (project: string): Promise<{ readonly dir: string; readonly entries: PushReportEntry[] } | undefined> => {
        const dir = repoDirOf(deps.root, project);
        const common = dir === undefined ? undefined : await commonDirOf(dir);
        if (dir === undefined || common === undefined) {
            return undefined;
        }
        const text = await readFile(join(common, PUSH_REPORT_FILE), "utf8").catch(undefinedIfMissing);
        return text === undefined ? undefined : { dir, entries: parsePushReport(text) };
    };

    // Whether the push's head is on the remote-tracking ref it moved. One that cannot be asked (no remote named, a branch
    // with no tracking ref, a ref outside refs/heads/) is taken as arrived: nothing here can say otherwise.
    const reachedRemote = async (dir: string, entry: PushReportEntry): Promise<boolean> => {
        const first = entry.pushes?.[0];
        if (first === undefined || entry.remote === undefined || !first.ref.startsWith("refs/heads/")) {
            return true;
        }
        const tracking = `refs/remotes/${entry.remote}/${first.ref.slice("refs/heads/".length)}`;
        try {
            await git(dir, ["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`]);
        } catch {
            // allow(silent-catch): `--verify --quiet` exits non-zero exactly when the ref is absent, which is the answer asked for
            return true;
        }
        try {
            await git(dir, ["merge-base", "--is-ancestor", first.head, tracking]);
            return true;
        } catch {
            // allow(silent-catch): `--is-ancestor` exits 1 for "not on it"; the push is looked at again on the next ref move
            return false;
        }
    };

    const ingestNow = async (project: string): Promise<PushIngest> => {
        const report = await reportOf(project);
        if (report === undefined || report.entries.length === 0) {
            return NOTHING;
        }
        const seen = new Set((await deps.store.read()).seen);
        let changed = false;
        let rechecks = 0;
        let resolved = 0;
        for (const entry of report.entries.filter((each) => !seen.has(each.id))) {
            if (entry.kind === "recheck") {
                resolved += (await deps.store.measure(project, entry)).resolved;
                rechecks += 1;
            } else if (await reachedRemote(report.dir, entry)) {
                resolved += (await deps.store.ingest(project, entry)).resolved;
            } else if (now() - entry.at >= REFUSED_AFTER_MS) {
                // Refused, or pushed somewhere the tracking ref never follows: nothing to file, but the tree was measured.
                resolved += (await deps.store.measure(project, entry)).resolved;
            } else {
                continue;
            }
            changed = true;
        }
        if (changed) {
            publishRuntimeChange("mainline");
        }
        return { changed, rechecks, resolved };
    };

    // One read of a project's report at a time, so two ref moves in a row never file one entry twice.
    const ingesting = new Map<string, Promise<PushIngest>>();
    const ingest = (project: string): Promise<PushIngest> => {
        const next = (ingesting.get(project) ?? Promise.resolve(NOTHING)).then(
            () => ingestNow(project),
            () => ingestNow(project),
        );
        ingesting.set(project, next);
        // The caller hears how it ended; this only forgets the chain once nothing is queued behind it.
        const forget = (): void => {
            if (ingesting.get(project) === next) {
                ingesting.delete(project);
            }
        };
        void next.then(forget, forget);
        return next;
    };

    const openIn = async (project: string): Promise<number> => openCount((await deps.store.read()).pushes, project);

    const recheckNow = async (project: string): Promise<MainlinePushRecheckResult> => {
        const report = await reportOf(project);
        // The newest entry's command: the hook that wrote it knows how this repository measures itself today.
        const argv = report?.entries.at(-1)?.recheck ?? [];
        if (report === undefined || (await recheckScript(report.dir, argv)) === undefined) {
            return { measured: false, resolved: 0, open: await openIn(project) };
        }
        let failure: unknown;
        try {
            await runNode(argv.slice(1), report.dir);
        } catch (error) {
            // A recheck may exit non-zero while findings stand; whether it measured is what its report says, below.
            failure = error;
        }
        const filed = await ingest(project);
        if (filed.rechecks === 0) {
            deps.logger.warn({ err: failure, project, argv }, "push checks: the recheck left no measurement");
        }
        return { measured: filed.rechecks > 0, resolved: filed.resolved, open: await openIn(project) };
    };

    const rechecking = new Map<string, Promise<MainlinePushRecheckResult>>();
    const recheck = (project: string): Promise<MainlinePushRecheckResult> => {
        const running = rechecking.get(project);
        if (running !== undefined) {
            return running;
        }
        const started = recheckNow(project).finally(() => rechecking.delete(project));
        rechecking.set(project, started);
        return started;
    };

    return {
        store: deps.store,
        ingest,
        recheck,
        recheckIfOpen: async (project) => ((await openIn(project)) === 0 ? undefined : recheck(project)),
        refused: async (project, refusal) => {
            await deps.store.refuse(project, refusal);
            publishRuntimeChange("mainline");
        },
        pushed: async (project, at) => {
            await deps.store.pushed(project, at);
            publishRuntimeChange("mainline");
        },
        dismiss: async (project, ids, restore) => {
            const changed = await deps.store.dismiss(project, ids, restore);
            if (changed > 0) {
                publishRuntimeChange("mainline");
            }
            return changed;
        },
    };
};

// Files each repository's report when its refs move (a push moves its remote-tracking ref), and once at boot for every
// repository the workspace holds. A failure is logged and never reaches the feed.
export const watchPushReports = (
    checks: Pick<PushChecks, "ingest">,
    feeds: {
        readonly refs: (listener: (repos: string[]) => void) => () => void;
        readonly repos: () => Promise<readonly string[]>;
    },
    logger: Pick<Logger, "warn">,
): (() => void) => {
    const file = (repo: string): void => {
        void checks
            .ingest(projectOfRepo(repo))
            .catch((error: unknown) => logger.warn({ err: error, repo }, "push checks: the push report could not be filed"));
    };
    const stop = feeds.refs((repos) => {
        for (const repo of repos) {
            file(repo);
        }
    });
    void feeds.repos().then(
        (repos) => {
            for (const repo of ["root", ...repos]) {
                file(repo);
            }
        },
        (error: unknown) => logger.warn({ err: error }, "push checks: the repositories could not be listed to file their push reports"),
    );
    return stop;
};
