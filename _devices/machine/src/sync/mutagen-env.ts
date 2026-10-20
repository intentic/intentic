import { basename, join } from "node:path";
import { pathExists, readJsonIfExists, writeFileAtomic } from "@intentic/base/fs";
import { z } from "zod";
import { baseDir } from "../config.js";

/* WHERE THIS AGENT'S MUTAGEN KEEPS ITS STATE (2026-10-18). Mutagen keeps its daemon, its sessions and its forwards in
   one data directory, `~/.mutagen` unless MUTAGEN_DATA_DIRECTORY says otherwise, and every Mutagen client of the user
   shares it. This agent never said otherwise, so its sessions lived in the user's own Mutagen state: a Windows user who
   uninstalled the app and deleted ~/.intentic still had both of her sandbox's sessions registered there, and the next
   `mutagen` anything started a daemon that went on filling her disk. Now every Mutagen this agent runs is pointed at a
   directory under the agent's own, so its state goes with the agent and never mixes with the user's.

   And no call starts a daemon by accident: a Mutagen client starts the daemon it cannot reach unless
   MUTAGEN_DISABLE_AUTOSTART=1, so a `status`, a report or a listing used to bring a stopped daemon back. Only
   `daemon start` starts one now, which that variable does not govern: setup, the watcher's own start, and the
   watcher's recovery of a daemon that went down (mutagen.ts). */

// Short on purpose: Windows paths under it run deep (sessions, caches, staging), and the daemon's socket on macOS is
// held to about a hundred bytes.
export const mutagenDataDir = join(baseDir, "mutagen");

// The whole environment a Mutagen child of this agent runs with.
export const mutagenEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
    ...base,
    MUTAGEN_DATA_DIRECTORY: mutagenDataDir,
    MUTAGEN_DISABLE_AUTOSTART: "1",
});

// Whether a command is a Mutagen binary, by its file name: this agent's own copy and a user's on PATH alike, each an
// absolute path (mutagen-binary.ts ensureMutagen).
export const isMutagenCommand = (command: string): boolean => /^mutagen(?:\.exe)?$/i.test(basename(command.replaceAll("\\", "/")));

// The environment for one child: what the caller set, else Mutagen's own for a Mutagen binary, else this process's
// (undefined, which every spawn reads as inherit). The one rule every door that starts a child applies (exec.ts,
// mutagen.ts runMutagen, project-remote.ts), so no call site can forget it.
export const childEnv = (command: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined =>
    env ?? (isMutagenCommand(command) ? mutagenEnv() : undefined);

// THE MOVE OFF THE SHARED DIRECTORY'S RECORD (mutagen-move.ts): written once every session of this agent's there has
// ended, so a move that failed is tried at the next start, and holding the pauses still to carry over to the sessions
// the watcher makes again (mutagen.ts createSession).
const movedPath = join(baseDir, "mutagen-moved.json");
const MovedSchema = z.object({ movedAt: z.string(), paused: z.array(z.string()) });
type Moved = z.infer<typeof MovedSchema>;

const writeMoved = async (moved: Moved): Promise<void> => await writeFileAtomic(movedPath, `${JSON.stringify(moved)}\n`);

export const movedAlready = async (): Promise<boolean> => await pathExists(movedPath);

export const recordMove = async (paused: readonly string[]): Promise<void> => await writeMoved({ movedAt: new Date().toISOString(), paused: [...paused] });

// Whether a session of this name was paused when the move ended it.
export const carriedPause = async (name: string): Promise<boolean> => (await readJsonIfExists(movedPath, MovedSchema))?.paused.includes(name) === true;

// Taken off once its session is made again, so a later create (after an unpair, say) starts as it should.
export const dropCarriedPause = async (name: string): Promise<void> => {
    const moved = await readJsonIfExists(movedPath, MovedSchema);
    if (moved?.paused.includes(name) === true) {
        await writeMoved({ ...moved, paused: moved.paused.filter((held) => held !== name) });
    }
};
