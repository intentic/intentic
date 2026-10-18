// What a detached `dev-rebuild` leaves behind on the machine that runs it, and how `dev-rebuild-log` reads it back.
// devices.ts re-exports all of it beside the device commands that name it.

// WHERE A DETACHED REBUILD REPORTS ITSELF. `dev-rebuild` returns the moment the build is under way and nothing streams
// back from it — a cold build outruns any timeout this door has, and the container swap at the end kills the daemon that
// would have read the answer — so the build writes here instead, in the folder ic logs its own recreates into, and
// `dev-rebuild-log` reads it back. Spelled once, here, because the daemon builds both command lines from it and the
// browser names the same path to a reader whose rebuild never came back.
export const devRebuildLogPath = (slug: string): string => `~/.intentic/logs/dev-rebuild-${slug}.log`;

// The build's own shell appends this when the build ends, with its exit status: since the log outlives the daemon, the
// container and the page that started it, this mark is the only thing that can say a rebuild is OVER rather than slow.
export const DEV_REBUILD_EXIT_MARK = "@intentic-rebuild-exit";
// `dev-rebuild-log` prints this first, then how many seconds it is since the log last grew — `-` when there is no log on
// that machine at all. A running build goes quiet for a minute at a time inside a docker layer; a build whose machine
// slept never writes its exit mark, and only this tells the two apart.
export const DEV_REBUILD_QUIET_MARK = "@intentic-rebuild-quiet";

export interface DevRebuildLog {
    /** Nothing has ever rebuilt this sandbox from a checkout on that machine. */
    readonly missing: boolean;
    /** Seconds since the log last grew; undefined when the machine's `stat` wouldn't say. */
    readonly quietFor: number | undefined;
    /** The build's own exit status, present only once it has ended. */
    readonly exitCode: number | undefined;
    /** The tail as the machine printed it, both marks removed. */
    readonly lines: readonly string[];
}

// Reads `dev-rebuild-log`'s stdout. Shared rather than parsed at the reader, so the shell line that produces this and the
// card that draws it cannot drift apart. Unparseable is never an error: an answer with no marks at all is simply a log
// with nothing to say yet.
const markValue = (line: string, mark: string): string | undefined => (line.startsWith(`${mark} `) ? line.slice(mark.length + 1).trim() : undefined);
const wholeNumber = (value: string): number | undefined => (/^\d+$/.test(value) ? Number(value) : undefined);

export const readDevRebuildLog = (text: string): DevRebuildLog => {
    let missing = false;
    let quietFor: number | undefined;
    let exitCode: number | undefined;
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const quiet = markValue(line, DEV_REBUILD_QUIET_MARK);
        const exit = markValue(line, DEV_REBUILD_EXIT_MARK);
        if (quiet !== undefined) {
            missing = quiet === "-";
            quietFor = wholeNumber(quiet);
        } else if (exit !== undefined) {
            // A mark whose status is unreadable still means the build ENDED, and not well.
            exitCode = wholeNumber(exit) ?? 1;
        } else {
            lines.push(line);
        }
    }
    while (lines.at(-1)?.trim() === "") {
        lines.pop();
    }
    return { missing, quietFor, exitCode, lines };
};
