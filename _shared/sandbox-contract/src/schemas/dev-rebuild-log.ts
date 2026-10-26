// What a detached `dev-rebuild` leaves behind on the machine that runs it, and how `dev-rebuild-log` reads it back.
// devices.ts re-exports all of it beside the device commands that name it.

// WHERE A DETACHED REBUILD REPORTS ITSELF. `dev-rebuild` returns the moment the build is under way and nothing streams
// back from it — a cold build outruns any timeout this door has, and the container swap at the end kills the daemon that
// would have read the answer — so the build writes here instead, in the folder ic logs its own recreates into, and
// `dev-rebuild-log` reads it back. Spelled once, here, because the daemon builds both command lines from it and the
// browser names the same path to a reader whose rebuild never came back.
export const devRebuildLogPath = (slug: string): string => `~/.intentic/logs/dev-rebuild-${slug}.log`;

// THE SWAP GATE'S FILE. While it exists, ic stops a dev recreate after the images are built and before anything touches
// the container (INTENTIC_SWAP_GATE, recreate.rs), and waits for it to go. `dev-rebuild-hold` makes it, `dev-rebuild-release`
// removes it, and `dev-rebuild` clears one a previous run left behind before it starts.
export const devRebuildHoldPath = (slug: string): string => `~/.intentic/logs/dev-rebuild-${slug}.hold`;

// The build's process: its session leader, written by the build's own shell as it starts, so `dev-rebuild-cancel` can
// stop the whole tree (pnpm, turbo, docker's client, ic) rather than the one shell it would otherwise know about.
export const devRebuildPidPath = (slug: string): string => `~/.intentic/logs/dev-rebuild-${slug}.pid`;

// The build's own shell appends this when the build ends, with its exit status: since the log outlives the daemon, the
// container and the page that started it, this mark is the only thing that can say a rebuild is OVER rather than slow.
export const DEV_REBUILD_EXIT_MARK = "@intentic-rebuild-exit";
// `dev-rebuild-log` prints this first, then how many seconds it is since the log last grew — `-` when there is no log on
// that machine at all. A running build goes quiet for a minute at a time inside a docker layer; a build whose machine
// slept never writes its exit mark, and only this tells the two apart.
export const DEV_REBUILD_QUIET_MARK = "@intentic-rebuild-quiet";
// `dev-rebuild-log` prints whether the hold file is there right now: `1` held, `0` not. Absent from an older daemon's read.
export const DEV_REBUILD_HOLD_MARK = "@intentic-rebuild-hold";
// `dev-rebuild-log` prints how many of turbo's tasks have started in the WHOLE log, not the tail — the tail is 80 lines
// of a log that runs to thousands, so a count kept from it would miss most of them. Turbo names no total up front (its
// "Running build in N packages" is the packages in scope, a quarter of the tasks), so the total is `-` until turbo's own
// summary line says it at the end; a reader that remembers the last run's total is what gives "of 48" before then.
export const DEV_REBUILD_TASKS_MARK = "@intentic-rebuild-tasks";
// The gate's own words, printed into the log by ic: it is holding (built, waiting for the hold file to go), and it let
// the swap through. Past the second, the container is being replaced and nothing may stop the build any more.
export const DEV_REBUILD_WAITING_MARK = "@intentic-rebuild-waiting";
export const DEV_REBUILD_SWAP_MARK = "@intentic-rebuild-swap";
// `dev-rebuild-cancel` appends this, then an exit mark of 130, once it has stopped the build: a run that ended because
// somebody asked, rather than one that failed.
export const DEV_REBUILD_CANCEL_MARK = "@intentic-rebuild-cancelled";

export interface DevRebuildTasks {
    /** Turbo's tasks that have started, cache hits included. */
    readonly started: number;
    /** How many it runs in all, once its summary has said; undefined before. */
    readonly total: number | undefined;
}

export interface DevRebuildLog {
    /** Nothing has ever rebuilt this sandbox from a checkout on that machine. */
    readonly missing: boolean;
    /** Seconds since the log last grew; undefined when the machine's `stat` wouldn't say. */
    readonly quietFor: number | undefined;
    /** The build's own exit status, present only once it has ended. */
    readonly exitCode: number | undefined;
    /** Ended because somebody cancelled it (`dev-rebuild-cancel`), not because it failed. */
    readonly cancelled: boolean;
    /** Whether the hold file is there; undefined from a daemon too old to say. */
    readonly hold: boolean | undefined;
    /** The gate is holding right now: the images are built, the container untouched, the restart waiting to be let through. */
    readonly waiting: boolean;
    /** The gate let the swap through: the container is being replaced. */
    readonly swapping: boolean;
    /** Turbo's count, from the whole log; undefined from a daemon too old to count. */
    readonly tasks: DevRebuildTasks | undefined;
    /** The tail as the machine printed it, every mark removed. */
    readonly lines: readonly string[];
}

// Reads `dev-rebuild-log`'s stdout. Shared rather than parsed at the reader, so the shell line that produces this and the
// card that draws it cannot drift apart. Unparseable is never an error: an answer with no marks at all is simply a log
// with nothing to say yet.
const markValue = (line: string, mark: string): string | undefined =>
    line === mark ? `` : line.startsWith(`${mark} `) ? line.slice(mark.length + 1).trim() : undefined;
const wholeNumber = (value: string): number | undefined => (/^\d+$/.test(value) ? Number(value) : undefined);

const readTasks = (value: string): DevRebuildTasks | undefined => {
    const [started, total] = value.split(/\s+/);
    const count = wholeNumber(started ?? ``);
    return count === undefined ? undefined : { started: count, total: wholeNumber(total ?? ``) };
};

export const readDevRebuildLog = (text: string): DevRebuildLog => {
    let missing = false;
    let quietFor: number | undefined;
    let exitCode: number | undefined;
    let cancelled = false;
    let hold: boolean | undefined;
    let tasks: DevRebuildTasks | undefined;
    // The last of the gate's two words: the tail is in order, so whichever came last is where the gate stands.
    let gate: `waiting` | `swap` | undefined;
    let swapping = false;
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const quiet = markValue(line, DEV_REBUILD_QUIET_MARK);
        const exit = markValue(line, DEV_REBUILD_EXIT_MARK);
        const held = markValue(line, DEV_REBUILD_HOLD_MARK);
        const counted = markValue(line, DEV_REBUILD_TASKS_MARK);
        if (quiet !== undefined) {
            missing = quiet === "-";
            quietFor = wholeNumber(quiet);
        } else if (exit !== undefined) {
            // A mark whose status is unreadable still means the build ENDED, and not well.
            exitCode = wholeNumber(exit) ?? 1;
        } else if (held !== undefined) {
            hold = held === `1`;
        } else if (counted !== undefined) {
            tasks = readTasks(counted);
        } else if (markValue(line, DEV_REBUILD_CANCEL_MARK) !== undefined) {
            cancelled = true;
        } else if (markValue(line, DEV_REBUILD_WAITING_MARK) !== undefined) {
            gate = `waiting`;
        } else if (markValue(line, DEV_REBUILD_SWAP_MARK) !== undefined) {
            gate = `swap`;
            swapping = true;
        } else {
            lines.push(line);
        }
    }
    while (lines.at(-1)?.trim() === "") {
        lines.pop();
    }
    // A gate still holding has printed nothing since its word, and a build that ended is holding nothing.
    const waiting = gate === `waiting` && exitCode === undefined;
    return { missing, quietFor, exitCode, cancelled, hold, waiting, swapping, tasks, lines };
};
