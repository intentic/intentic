import { mkdir, readFile, rm } from "node:fs/promises";
import type { ExitObservation } from "@intentic/sandbox-contract";
import { writeJsonFile } from "../store/json-file.js";
import type { ExitSelection } from "./exit-driver.js";
import { exitStateDir, observationPath, selectionPath, upMarkerPath } from "./exit-paths.js";

// The small facts an exit remembers between calls, not the source of truth: liveness is always probed off the machine,
// and country is always the last observation. Kept here is the intent, which country was asked for and which server
// serves it, so a card can render a cached reading without repolling.

// Creates the 0700 state dir directly, since writeJsonFile's mkdir is a no-op once it exists and skips the mode. Writes
// go through writeJsonFile (temp file + rename) so a poll never reads a half-written file as nothing remembered.
const writeJson = async (path: string, value: unknown, id: string): Promise<void> => {
    await mkdir(exitStateDir(id), { recursive: true, mode: 0o700 });
    await writeJsonFile(path, value, 0o600);
};

const readJson = async <T>(path: string): Promise<T | undefined> =>
    await readFile(path, "utf8")
        .then((raw) => JSON.parse(raw) as T)
        // Absent (never started) and unreadable (damage) both read as nothing remembered; every caller handles that.
        .catch(() => undefined);

export const readSelection = async (id: string): Promise<ExitSelection | undefined> => await readJson<ExitSelection>(selectionPath(id));
export const writeSelection = async (id: string, selection: ExitSelection): Promise<void> => await writeJson(selectionPath(id), selection, id);

export const readObservation = async (id: string): Promise<{ at: number; seen: ExitObservation } | undefined> =>
    await readJson<{ at: number; seen: ExitObservation }>(observationPath(id));
export const writeObservation = async (id: string, seen: ExitObservation, at: number): Promise<void> =>
    await writeJson(observationPath(id), { at, seen }, id);

// Called when an exit goes down, or a stale observation lets `list` claim a country nothing comes out of.
export const forgetLiveState = async (id: string): Promise<void> => {
    await rm(upMarkerPath(id), { force: true });
    await rm(observationPath(id), { force: true });
};
