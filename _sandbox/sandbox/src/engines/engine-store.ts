import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { type EngineId, type EngineQuarantine, EngineQuarantineSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { opt } from "../agent/run/opt.js";
import { type JsonFile, jsonFile } from "../store/json-file.js";

// Versions of the upstream engines, held on the daemon's volume (/history) outside the image so they survive container
// recreate and stay off the workspace sync. Each version gets its own directory, never upgraded in place; the pointer
// only moves after the new copy verifies. `state.json` is data, not a symlink: it names active, previous, and every
// refusal.

export interface EngineState {
    // Store version turns use; absent means the image's copy (fresh sandbox, failed install, or image channel).
    readonly active?: string;
    // Kept one step back so revert is a pointer move; absent until a second version is ever activated.
    readonly previous?: string;
    // Versions installed then refused, with reason; keeps a bad publish from being retried every check.
    readonly quarantined: readonly EngineQuarantine[];
}

const EngineStateSchema = z.object({
    active: z.string().optional(),
    previous: z.string().optional(),
    quarantined: z.array(EngineQuarantineSchema).default([]),
});

// Refusals remembered per engine; enough to show a pattern on the card, bounded against a runaway upstream.
const QUARANTINE_KEPT = 6;

// Read per call rather than cached, so a suite can point it at a fixture tree; defaults to the daemon volume, beside
// the activity and usage ledgers.
const enginesRoot = (): string => process.env["INTENTIC_ENGINES_DIR"] ?? join(HISTORY_ROOT, "engines");

export const engineDir = (id: EngineId): string => join(enginesRoot(), id);
export const engineVersionDir = (id: EngineId, version: string): string => join(engineDir(id), "versions", version);

const states = new Map<string, JsonFile<EngineState>>();

// One JsonFile per engine per store root; a suite that moves the root mid-run gets a fresh handle instead of the old
// tree's.
const stateFile = (id: EngineId): JsonFile<EngineState> => {
    const path = join(engineDir(id), "state.json");
    const existing = states.get(path);
    if (existing !== undefined) {
        return existing;
    }
    const file = jsonFile<EngineState>(path, {
        // Via `opt`, not a spread: exactOptionalPropertyTypes treats absent and undefined fields as different.
        parse: (raw) => {
            const parsed = EngineStateSchema.safeParse(raw).data;
            return parsed === undefined
                ? undefined
                : { ...opt("active", parsed.active), ...opt("previous", parsed.previous), quarantined: parsed.quarantined };
        },
        fallback: () => ({ quarantined: [] }),
    });
    states.set(path, file);
    return file;
};

export const readEngineState = (id: EngineId): Promise<EngineState> => stateFile(id).read();

// Every version on disk; order is not promised; a directory listing is alphabetical, so "2.1.9" sorts after "2.1.10".
// Callers needing order compare versions themselves.
export const installedVersions = async (id: EngineId): Promise<string[]> =>
    readdir(join(engineDir(id), "versions"), { withFileTypes: true })
        .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
        .catch(() => []);

// Makes a version the one turns use, keeping what it replaced as `previous`. Only set when the outgoing version was
// itself a store version; activating over the image leaves `previous` alone.
export const activateVersion = async (id: EngineId, version: string): Promise<EngineState> =>
    stateFile(id).update((current) => ({
        ...current,
        active: version,
        ...(current.active === undefined || current.active === version ? {} : { previous: current.active }),
        quarantined: current.quarantined.filter((entry) => entry.version !== version),
    }));

// Stops using the store; the image's copy serves the next turn. `previous` is kept deliberately, so reverting to stock
// does not lose the download.
export const deactivate = async (id: EngineId): Promise<EngineState> => stateFile(id).update(({ active: _active, ...rest }) => ({ ...rest }));

// Refuses a version for automatic selection and falls back off it if it was active; the path for a copy that installs
// cleanly but will not run.
export const quarantineVersion = async (id: EngineId, version: string, reason: string, at: string): Promise<EngineState> =>
    stateFile(id).update(({ active, ...rest }) => ({
        ...rest,
        // Dropped, not set to undefined: an absent `active` means the image's copy serves the next turn.
        ...opt("active", active === version ? undefined : active),
        quarantined: [{ version, reason, at }, ...rest.quarantined.filter((entry) => entry.version !== version)].slice(0, QUARANTINE_KEPT),
    }));

export const isQuarantined = (state: EngineState, version: string): boolean =>
    state.quarantined.some((entry) => entry.version === version);

// Deletes every version except active and previous; called after an install so the store holds at most those two, never
// a stale extra download.
export const collectGarbage = async (id: EngineId): Promise<string[]> => {
    const { active, previous } = await readEngineState(id);
    const keep = new Set([active, previous].filter((version): version is string => version !== undefined));
    const removable = (await installedVersions(id)).filter((version) => !keep.has(version));
    await Promise.all(removable.map((version) => rm(engineVersionDir(id, version), { recursive: true, force: true })));
    return removable;
};

// Disk cost of this engine's kept versions, for the card. Walked fresh each time so it stays true after a GC or a
// manual rm -rf.
export const engineDiskBytes = async (id: EngineId): Promise<number> => {
    const versions = await installedVersions(id);
    const sizes = await Promise.all(versions.map((version) => directoryBytes(engineVersionDir(id, version))));
    return sizes.reduce((total, size) => total + size, 0);
};

const directoryBytes = async (dir: string): Promise<number> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const sizes = await Promise.all(
        entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                return directoryBytes(path);
            }
            // Sizes, not blocks: answers what deleting this would free; a symlink's own size is noise here.
            return stat(path)
                .then((info) => (info.isFile() ? info.size : 0))
                .catch(() => 0);
        }),
    );
    return sizes.reduce((total, size) => total + size, 0);
};

// Test seam: clears per-path JsonFile handles so a suite can move INTENTIC_ENGINES_DIR between cases.
export const forgetEngineStates = (): void => states.clear();
