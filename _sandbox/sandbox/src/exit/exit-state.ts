import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { ExitObservation } from "@intentic/sandbox-contract";
import { writeJsonFile } from "../store/json-file.js";
import type { ExitSelection } from "./exit-driver.js";
import { exitStateDir, observationPath, selectionPath, upMarkerPath } from "./exit-paths.js";

/* The small facts an exit remembers between calls, and a firm line about what they are NOT.
 *
 * None of this is the source of truth for whether an exit is up or where it comes out. Liveness is always
 * probed off the machine and the country is always the last OBSERVATION, made through the exit itself. What is
 * kept here is the intent behind those facts: which country was asked for, which server was picked to serve
 * it, and the last reading, so a Status card polling every few seconds can render "DE · 5.9.x.x, 2m ago"
 * without sending a fresh request through a volunteer relay on every poll.
 *
 * Written per exit under its own state directory so erasing one capability erases exactly its own memory.
 */

/* The state dir is created here rather than left to writeJsonFile, because its MODE matters: 0700, so an exit's
 * remembered selection is readable only by the daemon's own user. writeJsonFile's mkdir is a no-op once it
 * exists, so the mode survives, and the file it writes carries 0600 of its own.
 *
 * The write goes through writeJsonFile for the atomicity (temp file + rename): the reader below used to treat a
 * torn file as "nothing remembered", which is the right answer for a file that was never written and the wrong
 * one for a file being written right now. A poll landing in that window forgot which country the exit was
 * asked for. */
const writeJson = async (path: string, value: unknown, id: string): Promise<void> => {
    await mkdir(exitStateDir(id), { recursive: true, mode: 0o700 });
    await writeJsonFile(path, value, 0o600);
};

const readJson = async <T>(path: string): Promise<T | undefined> =>
    await readFile(path, "utf8")
        .then((raw) => JSON.parse(raw) as T)
        // Absent is the normal case (never started). Unreadable can now only mean damage from outside this
        // daemon, since its own writes are atomic; both mean "nothing remembered", which every caller handles.
        .catch(() => undefined);

export const readSelection = async (id: string): Promise<ExitSelection | undefined> => await readJson<ExitSelection>(selectionPath(id));
export const writeSelection = async (id: string, selection: ExitSelection): Promise<void> => await writeJson(selectionPath(id), selection, id);

export const readObservation = async (id: string): Promise<{ at: number; seen: ExitObservation } | undefined> =>
    await readJson<{ at: number; seen: ExitObservation }>(observationPath(id));
export const writeObservation = async (id: string, seen: ExitObservation, at: number): Promise<void> =>
    await writeJson(observationPath(id), { at, seen }, id);

// Epoch ms this exit came up, from the marker touched on a successful start. ADVISORY: liveness always comes
// from the driver's probe, so an exit raised outside the daemon shows no uptime rather than a wrong state.
export const upSince = async (id: string): Promise<number | undefined> => (await stat(upMarkerPath(id)).catch(() => undefined))?.mtimeMs;

export const markUp = async (id: string): Promise<void> => {
    await mkdir(exitStateDir(id), { recursive: true, mode: 0o700 });
    await writeFile(upMarkerPath(id), "", { mode: 0o600 });
};

// Everything an exit remembers, dropped. Called when it goes down: a stale observation outliving the tunnel
// that produced it would let `list` claim a country nothing is coming out of any more.
export const forgetLiveState = async (id: string): Promise<void> => {
    await rm(upMarkerPath(id), { force: true });
    await rm(observationPath(id), { force: true });
};
