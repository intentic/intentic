import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { type EngineId, type EngineQuarantine, EngineQuarantineSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { opt } from "../agent/opt.js";
import { type JsonFile, jsonFile } from "../store/json-file.js";

/* THE ENGINE STORE: versions of the upstream agent programs, kept beside the daemon rather than inside its
 * image, so moving one is a download instead of a release.
 *
 * IT LIVES ON THE DAEMON'S VOLUME (/history), and each of those three words is load-bearing:
 *   - a VOLUME, so an installed version survives the container recreate that an image rebuild, a settings
 *     change or a machine reboot performs. A store under / would be thrown away by the very events this
 *     mechanism exists to stop depending on;
 *   - the DAEMON's, not the workspace's, because these are 300 MB platform binaries compiled for THIS
 *     container's architecture. Under /work they would ride the workspace sync to the owner's laptop, be
 *     carried by a workspace export to a machine they cannot run on, and sit in the agent's own writable tree;
 *   - and outside the image, so what is running is a fact this daemon can read, revert and re-download rather
 *     than a property of a published artefact.
 *
 * ONE DIRECTORY PER VERSION, never a shared prefix that gets upgraded in place. An install that fails halfway
 * leaves a directory nothing points at; the pointer only ever moves after the new copy has answered for itself
 * (engine-install.ts). That is also what makes reverting free: the previous version is still on disk, so going
 * back is a pointer move, not a download, which matters exactly when the network is the thing that broke.
 *
 * THE POINTER IS DATA, NOT A SYMLINK. state.json names the active version, the one kept behind it, and every
 * version this daemon has refused. A symlink would carry the first fact and none of the others, and swapping
 * one under a running turn is not atomic in any sense the reader can rely on. */

export interface EngineState {
    // The store version turns should use. Absent means the image's copy, which is also what a fresh sandbox,
    // a failed install and an owner on the `image` channel all read as.
    readonly active?: string;
    // Kept one step back so a revert is a pointer move. Absent until a second version has ever been activated.
    readonly previous?: string;
    // Versions this daemon installed and then refused, with the reason. Kept so a bad publish is not retried
    // on every check, and so the card can say why the sandbox is back on the image's copy.
    readonly quarantined: readonly EngineQuarantine[];
}

const EngineStateSchema = z.object({
    active: z.string().optional(),
    previous: z.string().optional(),
    quarantined: z.array(EngineQuarantineSchema).default([]),
});

// How many refusals to remember per engine. Enough to show a pattern on the card ("three of the last four
// versions would not launch"), bounded so a runaway upstream cannot grow the file without limit.
const QUARANTINE_KEPT = 6;

/* THE ONE FACT HERE THAT COMES FROM THE MACHINE, so it is read per call and can be pointed elsewhere: suites
 * set it to a fixture tree, and a dev daemon sharing a host's /history can keep its own. The default is the
 * daemon volume, the same place the activity and usage ledgers live. */
const enginesRoot = (): string => process.env["INTENTIC_ENGINES_DIR"] ?? join(HISTORY_ROOT, "engines");

export const engineDir = (id: EngineId): string => join(enginesRoot(), id);
export const engineVersionDir = (id: EngineId, version: string): string => join(engineDir(id), "versions", version);

const states = new Map<string, JsonFile<EngineState>>();

// One JsonFile per engine per store root, so a suite that moves the root mid-run gets a new one rather than a
// handle onto the tree it left behind.
const stateFile = (id: EngineId): JsonFile<EngineState> => {
    const path = join(engineDir(id), "state.json");
    const existing = states.get(path);
    if (existing !== undefined) {
        return existing;
    }
    const file = jsonFile<EngineState>(path, {
        // Through `opt` rather than spread whole: the schema's optional fields parse as `key: undefined`, and
        // this daemon's exactOptionalPropertyTypes means an absent field and a field holding undefined are
        // different types (agent/opt.ts).
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

// Every version currently on disk for this engine, newest-installed last is NOT promised: callers that care
// about order compare versions themselves (engine-channel.ts), because a directory listing is alphabetical and
// "2.1.9" sorts after "2.1.10" there.
export const installedVersions = async (id: EngineId): Promise<string[]> =>
    readdir(join(engineDir(id), "versions"), { withFileTypes: true })
        .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
        .catch(() => []);

/* Make a version the one turns use, keeping what it replaced as the way back.
 *
 * The outgoing version becomes `previous` only when it is a DIFFERENT store version: activating over the
 * image's copy leaves `previous` alone, because "go back" there means "stop using the store", which is what
 * clearing `active` already says. */
export const activateVersion = async (id: EngineId, version: string): Promise<EngineState> =>
    stateFile(id).update((current) => ({
        ...current,
        active: version,
        ...(current.active === undefined || current.active === version ? {} : { previous: current.active }),
        quarantined: current.quarantined.filter((entry) => entry.version !== version),
    }));

/* Stop using the store for this engine: the image's copy serves the next turn. `previous` is deliberately
 * kept, so an owner who reverts to stock and then changes their mind still has the download. */
export const deactivate = async (id: EngineId): Promise<EngineState> => stateFile(id).update(({ active: _active, ...rest }) => ({ ...rest }));

/* Refuse a version, permanently as far as automatic selection is concerned (engine-channel.ts skips
 * quarantined versions), and fall back off it if it was the active one. This is the path a copy that installs
 * cleanly but will not RUN takes, which is the failure npm's own integrity check cannot see. */
export const quarantineVersion = async (id: EngineId, version: string, reason: string, at: string): Promise<EngineState> =>
    stateFile(id).update(({ active, ...rest }) => ({
        ...rest,
        // Dropped rather than set to undefined: an absent `active` IS "the image's copy serves the next turn".
        ...opt("active", active === version ? undefined : active),
        quarantined: [{ version, reason, at }, ...rest.quarantined.filter((entry) => entry.version !== version)].slice(0, QUARANTINE_KEPT),
    }));

export const isQuarantined = (state: EngineState, version: string): boolean =>
    state.quarantined.some((entry) => entry.version === version);

/* Delete every version except the two the state names. Called after an install, so the store holds at most
 * "what runs" and "what going back means" — two copies of a 300 MB binary is a cost worth paying for an
 * instant revert; a fifth copy of one is just an old download nobody will choose. */
export const collectGarbage = async (id: EngineId): Promise<string[]> => {
    const { active, previous } = await readEngineState(id);
    const keep = new Set([active, previous].filter((version): version is string => version !== undefined));
    const removable = (await installedVersions(id)).filter((version) => !keep.has(version));
    await Promise.all(removable.map((version) => rm(engineVersionDir(id, version), { recursive: true, force: true })));
    return removable;
};

// What this engine's kept versions cost on the volume, for the card. Walked rather than remembered: the
// number has to be true after a GC, a failed install and a manual `rm -rf` alike.
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
            // Sizes, not blocks: the point is "what would deleting this free", and a symlink's own size is
            // noise beside a 300 MB binary.
            return stat(path)
                .then((info) => (info.isFile() ? info.size : 0))
                .catch(() => 0);
        }),
    );
    return sizes.reduce((total, size) => total + size, 0);
};

// Test seam: forget the per-path JsonFile handles so a suite can move INTENTIC_ENGINES_DIR between cases.
export const forgetEngineStates = (): void => states.clear();
