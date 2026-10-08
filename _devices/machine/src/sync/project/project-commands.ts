import { readFile } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import { buildCommand, type CommandContext } from "@stricli/core";
import { z } from "zod";
import { baseDir } from "../../config.js";
import { readResidentPid } from "../../resident.js";
import { isProjectPairing, type Pairing, pairingKey, pairingRemoteDir, type ProjectDirection, readState, setProjectDirection } from "../config.js";
import { canonicalFolder, foldersOverlap, sameFolder } from "../folders.js";
import { ensureMutagen, sessionName } from "../mutagen.js";
import { pairingEndpoint } from "../endpoint.js";
import { mutagenSession, projectShell, realProjectRunner, sandboxCopy } from "./project-remote.js";
import {
    bringBack,
    type ListedChange,
    projectChanges,
    type ProjectContext,
    type ProjectPairing,
    restorePoint,
    restorePoints,
} from "./project-transfer.js";
import type { Skipped } from "../restore-points.js";
import { mutagenSshPath } from "../ssh.js";

// THE COPY-FIRST COMMANDS the desktop app's "Bring back changes" runs, under `intentic-machine sync`: `changes`,
// `bring-back`, `restore-points`, `restore` and `direction`. Each names its project by the folder (`--dir`), and with
// `--json` prints exactly one JSON object on stdout, `{ "ok": false, "error": "<sentence>" }` on failure with exit code 1.
// The app parses those objects field by field, so their fields are only ever added.

// The project pairing whose folder `dir` is: the same folder once links are resolved, and case folded where the platform
// folds it. A folder that is a workspace's, or one inside a project's, is named for what it is.
export const projectPairingFor = async (pairings: readonly Pairing[], dir: string, platform: NodeJS.Platform = process.platform): Promise<ProjectPairing> => {
    const wanted = await canonicalFolder(dir);
    const held = await Promise.all(
        pairings.flatMap((pairing) => (pairing.localDir === undefined ? [] : [{ ...pairing, localDir: pairing.localDir }])).map(async (pairing) => ({ pairing, folder: await canonicalFolder(pairing.localDir) })),
    );
    const same = held.filter(({ folder }) => sameFolder(wanted, folder, platform));
    const project = same.find(({ pairing }) => isProjectPairing(pairing));
    if (project !== undefined) {
        return project.pairing;
    }
    if (same[0] !== undefined) {
        throw new Error(`${dir} syncs with ${same[0].pairing.sandboxId} as its whole workspace, not as a project: only a project's changes are brought back`);
    }
    const holder = held.find(({ pairing, folder }) => isProjectPairing(pairing) && foldersOverlap(wanted, folder, platform));
    throw new Error(holder === undefined ? `no project on this machine syncs ${dir}` : `${dir} is inside the project folder ${holder.pairing.localDir}: pass that folder`);
};

// A message as the sentence the app shows: capitalised, ending in a full stop.
const sentence = (message: string): string => {
    const text = message.trim();
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
};

// What every one of these commands prints, and the one exit code a failure has; `sync attach` and `sync detach` answer
// the same way (attach-commands.ts).
export const answer = async <R extends { readonly ok: true }>(cli: CommandContext, json: boolean, work: () => Promise<R>, human: (result: R) => string): Promise<void> => {
    try {
        const result = await work();
        cli.process.stdout.write(`${json ? JSON.stringify(result) : human(result)}\n`);
    } catch (error) {
        const said = sentence(errorMessage(error));
        if (json) {
            cli.process.stdout.write(`${JSON.stringify({ ok: false, error: said })}\n`);
        } else {
            cli.process.stderr.write(`${said}\n`);
        }
        process.exitCode = 1;
    }
};

const pairingAt = async (dir: string | undefined): Promise<ProjectPairing> => {
    if (dir === undefined || dir.trim() === "") {
        throw new Error("pass --dir with the project's folder on this machine");
    }
    return await projectPairingFor((await readState()).pairings, dir);
};

// Reaching the sandbox the way file sync does (endpoint.ts): the ssh client Mutagen drives over the pairing's alias, or
// `docker exec` into the container of a sandbox on this machine's own engine.
const contextFor = async (pairing: ProjectPairing): Promise<ProjectContext> => ({
    pairing,
    stateDir: baseDir,
    sandbox: sandboxCopy(
        realProjectRunner,
        projectShell(pairingEndpoint(pairing), mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"])),
        pairingRemoteDir(pairing),
    ),
    session: mutagenSession(realProjectRunner, await ensureMutagen(), sessionName(pairingKey(pairing))),
});

// A path as a line shows it: plain, or quoted where it holds a character a line would lose (a newline, a tab).
const shown = (path: string): string => (/[\u0000-\u001F\u007F]/.test(path) ? JSON.stringify(path) : path);

const skippedLines = (skipped: readonly Skipped[]): string[] => skipped.map((entry) => `  not brought back: ${shown(entry.path)} (${entry.reason})`);

const changeLine = (change: ListedChange): string =>
    `  ${change.kind.padEnd(8)}  ${shown(change.path)}${change.size === undefined ? "" : `  (${change.size} bytes)`}${change.conflict === true ? "  CONFLICT: bring-back leaves this folder's copy as it is" : ""}`;

interface ProjectFlags {
    readonly dir?: string;
    readonly json: boolean;
}

const projectFlags = {
    dir: { kind: "parsed", parse: String, optional: true, brief: "The project's folder on this machine" },
    json: { kind: "boolean", brief: "Print one JSON object, `ok` first (what the desktop app reads)" },
} as const;

const changes = buildCommand<ProjectFlags>({
    docs: { brief: "List what an agent changed in a copy-first project's sandbox copy, compared with the folder here" },
    parameters: { flags: projectFlags },
    async func(this: CommandContext, flags: ProjectFlags) {
        let dir = "";
        await answer(
            this,
            flags.json,
            async () => {
                const pairing = await pairingAt(flags.dir);
                dir = pairing.localDir;
                return await projectChanges(await contextFor(pairing));
            },
            (result) =>
                result.changes.length === 0
                    ? `The sandbox's copy of ${dir} has nothing to bring back.`
                    : [
                          `The sandbox's copy of ${dir} holds ${result.changes.length}${result.truncated === true ? "+" : ""} change(s) this folder does not (${result.direction}):`,
                          ...result.changes.map(changeLine),
                          ...(result.truncated === true ? [`  … and more: only the first ${result.changes.length} are listed.`] : []),
                          `Bring them back with \`intentic-machine sync bring-back --dir ${JSON.stringify(dir)}\`, which keeps a restore point first.`,
                      ].join("\n"),
        );
    },
});

interface BringBackFlags extends ProjectFlags {
    readonly path?: readonly string[];
    readonly pathsFile?: string;
}

const PathsFileSchema = z.array(z.string().min(1));

// What `--paths-file` names: a UTF-8 file holding a JSON array of relative paths, each meaning what one `--path` does.
// It exists because a Windows command line holds 32,767 characters, fewer than a long review's selection. An empty
// list is refused rather than read as no selection, which would bring every change back.
export const pathsFromFile = async (file: string): Promise<string[]> => {
    let raw: string;
    try {
        raw = await readFile(file, "utf8");
    } catch (error) {
        throw new Error(`the paths file ${file} could not be read (${errorMessage(error)})`, { cause: error });
    }
    let listed: z.infer<typeof PathsFileSchema> | undefined;
    try {
        // A byte-order mark is what some Windows writers put first; it is not part of the JSON.
        listed = PathsFileSchema.safeParse(JSON.parse(raw.replace(/^\uFEFF/, ""))).data;
    } catch {
        // allow(silent-catch): bytes that are not JSON are the malformed file reported just below.
        listed = undefined;
    }
    if (listed === undefined) {
        throw new Error(`the paths file ${file} is not a JSON array of relative paths`);
    }
    if (listed.length === 0) {
        throw new Error(`the paths file ${file} lists no paths: leave it out to bring every change back`);
    }
    return listed;
};

// Every path asked for, by `--path` and `--paths-file` together, each once.
export const requestedPaths = async (flags: Pick<BringBackFlags, "path" | "pathsFile">): Promise<string[]> => {
    const fromFile = flags.pathsFile === undefined ? [] : await pathsFromFile(flags.pathsFile);
    return [...new Set([...(flags.path ?? []), ...fromFile])];
};

const bringBackCommand = buildCommand<BringBackFlags>({
    docs: { brief: "Bring a copy-first project's changes from its sandbox into the folder here, keeping a restore point first" },
    parameters: {
        flags: {
            ...projectFlags,
            path: {
                kind: "parsed",
                parse: String,
                variadic: true,
                optional: true,
                brief: "Only this path, relative to the folder, or everything under it (repeatable). Default: every change",
            },
            pathsFile: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "A UTF-8 file holding a JSON array of such paths, taken together with any --path",
            },
        },
    },
    async func(this: CommandContext, flags: BringBackFlags) {
        let dir = "";
        await answer(
            this,
            flags.json,
            async () => {
                const pairing = await pairingAt(flags.dir);
                dir = pairing.localDir;
                const paths = await requestedPaths(flags);
                return await bringBack(await contextFor(pairing), paths);
            },
            (result) =>
                [
                    result.applied.length === 0
                        ? `Nothing was brought back into ${dir}.`
                        : `Brought ${result.applied.length} change(s) back into ${dir}. Restore point ${result.point} holds what they replaced: \`intentic-machine sync restore --dir ${JSON.stringify(dir)} --point ${result.point}\` puts it back.`,
                    ...skippedLines(result.skipped),
                ].join("\n"),
        );
    },
});

const restorePointsCommand = buildCommand<ProjectFlags>({
    docs: { brief: "List a copy-first project's restore points, newest first" },
    parameters: { flags: projectFlags },
    async func(this: CommandContext, flags: ProjectFlags) {
        let dir = "";
        await answer(
            this,
            flags.json,
            async () => {
                const pairing = await pairingAt(flags.dir);
                dir = pairing.localDir;
                return await restorePoints({ pairing, stateDir: baseDir });
            },
            (result) =>
                result.points.length === 0
                    ? `No restore points for ${dir}: one is kept at each bring-back.`
                    : [`Restore points for ${dir}, newest first:`, ...result.points.map((point) => `  ${point.id}  ${point.createdAt}  ${point.entries} file(s)`)].join("\n"),
        );
    },
});

interface RestoreFlags extends ProjectFlags {
    readonly point?: string;
}

const restoreCommand = buildCommand<RestoreFlags>({
    docs: { brief: "Undo a bring-back: put back what it replaced and remove what it added, where nothing changed since" },
    parameters: { flags: { ...projectFlags, point: { kind: "parsed", parse: String, optional: true, brief: "The restore point's id (`sync restore-points` lists them)" } } },
    async func(this: CommandContext, flags: RestoreFlags) {
        await answer(
            this,
            flags.json,
            async () => {
                if (flags.point === undefined || flags.point.trim() === "") {
                    throw new Error("pass --point with a restore point's id (`intentic-machine sync restore-points` lists them)");
                }
                const point = flags.point.trim();
                return await restorePoint(await contextFor(await pairingAt(flags.dir)), point);
            },
            (result) =>
                [`Restored ${result.restored} file(s).`, ...result.skipped.map((entry) => `  not restored: ${shown(entry.path)} (${entry.reason})`)].join("\n"),
        );
    },
});

interface DirectionResult {
    readonly ok: true;
    readonly direction: ProjectDirection;
}

const DIRECTIONS: readonly ProjectDirection[] = ["to-sandbox", "both"];

const directionCommand = buildCommand<ProjectFlags, [string?]>({
    docs: { brief: "Make a project copy-first (to-sandbox, the default) or sync it both ways (both)" },
    parameters: {
        flags: projectFlags,
        positional: { kind: "tuple", parameters: [{ brief: "to-sandbox or both", parse: String, optional: true, placeholder: "direction" }] },
    },
    async func(this: CommandContext, flags: ProjectFlags, value?: string) {
        let dir = "";
        let running = true;
        await answer(
            this,
            flags.json,
            async (): Promise<DirectionResult> => {
                const direction = DIRECTIONS.find((known) => known === value);
                if (direction === undefined) {
                    throw new Error(`say which way: \`to-sandbox\` (copy-first) or \`both\`${value === undefined ? "" : `, not ${JSON.stringify(value)}`}`);
                }
                const pairing = await pairingAt(flags.dir);
                dir = pairing.localDir;
                await setProjectDirection(pairingKey(pairing), direction);
                running = (await readResidentPid()) !== undefined;
                return { ok: true, direction };
            },
            (result) =>
                [
                    result.direction === "both"
                        ? `${dir} now syncs both ways: what an agent changes in the sandbox comes straight back here, deletions included. A file both sides changed is held as a conflict rather than overwritten.`
                        : `${dir} is copy-first: it flows into the sandbox, and what an agent changes there comes back only when you bring it back.`,
                    running
                        ? "This machine's agent switches its file sync over within a few seconds."
                        : "This machine's agent is not running, so the switch applies when it next starts (`intentic-machine run`).",
                ].join("\n"),
        );
    },
});

export const projectCommands = {
    changes,
    "bring-back": bringBackCommand,
    "restore-points": restorePointsCommand,
    restore: restoreCommand,
    direction: directionCommand,
};
