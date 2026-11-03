import { sleep } from "@intentic/base/async";
import { type CloseAsked, askWindowsTreeToClose, execBounded, forcedBecause, forceWindowsTree } from "@intentic/base/process";

// A PROGRAM AND EVERYTHING IT STARTED, as the operating system lists them: what app_status reads a run's windows from,
// and what app_stop ends. A stop reads the tree before it signals anything, because a program closed gracefully can end
// before what it started: taskkill /T then finds no parent to walk from, and those processes stay running (holding the
// port the next run of it wants) while the run reads as stopped.

// (pid, parent pid) for every process.
export type ProcessRows = readonly (readonly [number, number])[];

// Every process descended from `root`, root included, from (pid, parent) rows.
export const descendantsOf = (rows: ProcessRows, root: number): Set<number> => {
    const tree = new Set<number>([root]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [pid, parent] of rows) {
            if (!tree.has(pid) && tree.has(parent) && pid !== parent) {
                tree.add(pid);
                grew = true;
            }
        }
    }
    return tree;
};

export const parseRows = (text: string): [number, number][] =>
    text.split(/\r?\n/).flatMap((line): [number, number][] => {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        return pid !== undefined && parent !== undefined && Number.isInteger(pid) && Number.isInteger(parent) ? [[pid, parent]] : [];
    });

export const processRows = async (): Promise<[number, number][]> => {
    if (process.platform === "win32") {
        const { stdout } = await execBounded(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
            { timeoutMs: 30_000, maxOutput: 8 * 1024 * 1024 },
        );
        return parseRows(stdout);
    }
    // A zombie has already ended and holds nothing (no port, no file); it stays listed only until its parent reaps it,
    // and in a container whose first process reaps no orphans (CI's) that is never, so it is not a survivor.
    const { stdout } = await execBounded("ps", ["-A", "-o", "pid=,ppid=,stat="], { timeoutMs: 30_000, maxOutput: 8 * 1024 * 1024 });
    return parseRows(
        stdout
            .split(/\r?\n/)
            .filter((line) => !/^\s*\d+\s+\d+\s+Z/.test(line))
            .join("\n"),
    );
};

// The rows as they are now, or none when they cannot be read: a stop then has only the root's own tree kill to go on.
const rowsOrNone = async (): Promise<[number, number][]> => {
    try {
        return await processRows();
    } catch {
        // allow(silent-catch): an unreadable list names no process; the caller works with the root alone
        return [];
    }
};

// The processes of a tree read before a stop that are still there after it. On Windows, the same pid under the same
// parent: a process keeps its dead parent's id, so a child the root left behind still reads as the root's, while a pid
// the system handed to an unrelated program meanwhile (Windows reuses them within seconds) has another parent and is
// left alone. Elsewhere an orphan is handed to init or a subreaper, and pids count up before they wrap, so the pid alone.
export const survivorsOf = (before: ProcessRows, tree: ReadonlySet<number>, root: number, after: ProcessRows, windows = process.platform === "win32"): number[] => {
    const now = new Set(after.map(([pid, parent]) => (windows ? `${pid} ${parent}` : `${pid}`)));
    return before.filter(([pid, parent]) => pid !== root && tree.has(pid) && now.has(windows ? `${pid} ${parent}` : `${pid}`)).map(([pid]) => pid);
};

// How a program was asked to stop: on Windows through its window or its console, or not at all (windows-stop.ts in
// @intentic/base); elsewhere SIGTERM to its process group.
export type StopAsked = CloseAsked | "sigterm";

// Asks the tree rooted at `pid` to close. `consoleOf` is the program a launcher stands in for (programs.ts, Windows).
const askTree = async (pid: number, consoleOf?: number): Promise<StopAsked> => {
    if (process.platform === "win32") {
        return await askWindowsTreeToClose(pid, consoleOf === undefined ? {} : { consoleOf });
    }
    try {
        process.kill(-pid, "SIGTERM");
    } catch {
        // allow(silent-catch): a group already gone is the outcome a stop wants
    }
    return "sigterm";
};

// Ends the tree rooted at `pid` at once.
const forceTree = async (pid: number): Promise<void> => {
    if (process.platform === "win32") {
        await forceWindowsTree(pid);
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        // allow(silent-catch): a group already gone is the outcome a stop wants
    }
};

// Why a stop had to force a program that was asked first: on Windows whether it could be asked at all.
const forcedReason = (asked: StopAsked, graceMs: number): string =>
    asked === "sigterm" ? `it was sent SIGTERM and had not finished after ${Math.round(graceMs / 100) / 10} s` : forcedBecause(asked, graceMs);

// One leftover process, forced: on Windows with what it started, elsewhere the process itself (it may lead no group).
const signalOne = async (pid: number): Promise<void> => {
    if (process.platform === "win32") {
        await forceWindowsTree(pid);
        return;
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        // allow(silent-catch): already gone is the outcome a stop wants
    }
};

// A run's tree read before its stop, and the end of whatever of it outlived its root.
export interface TreeSnapshot {
    // Forces what is left of the tree once the root is gone; answers the pids still there after that.
    readonly endSurvivors: () => Promise<number[]>;
}

export const snapshotTree = async (root: number): Promise<TreeSnapshot> => {
    const before = await rowsOrNone();
    const tree = descendantsOf(before, root);
    return {
        endSurvivors: async () => {
            if (tree.size <= 1) {
                return [];
            }
            const left = survivorsOf(before, tree, root, await rowsOrNone());
            if (left.length === 0) {
                return [];
            }
            for (const pid of left) {
                await signalOne(pid);
            }
            await sleep(500);
            return survivorsOf(before, tree, root, await rowsOrNone());
        },
    };
};

// How a stop went: whether the program is gone, whether it had to be forced, and (for a stop not asked to force) why.
export interface StopOutcome {
    readonly gone: boolean;
    readonly forced: boolean;
    readonly why?: string | undefined;
}

// How long a forced program gets to be gone before the stop says something still holds it.
const FORCED_WAIT_MS = 5000;

// THE ONE STOP app_stop AND `uninstall --purge` GIVE A PROGRAM: asked first (unless `force`), `graceMs` to finish, then
// forced with everything it started. `gone(ms)` waits up to `ms` for the program to have ended.
export const askThenForce = async (
    pid: number,
    { consoleOf, graceMs, force, gone }: { readonly consoleOf?: number | undefined; readonly graceMs: number; readonly force: boolean; readonly gone: (ms: number) => Promise<boolean> },
): Promise<StopOutcome> => {
    let why: string | undefined;
    if (!force) {
        const asked = await askTree(pid, consoleOf);
        if (await gone(graceMs)) {
            return { gone: true, forced: false };
        }
        why = forcedReason(asked, graceMs);
    }
    await forceTree(pid);
    return { gone: await gone(FORCED_WAIT_MS), forced: true, why };
};
