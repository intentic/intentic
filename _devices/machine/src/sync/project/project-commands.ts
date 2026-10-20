import { readFile } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { explain, type Item, type Ui } from "@intentic/local-agent";
import type { DirectionResult } from "@intentic/sandbox-contract/schemas/project-bring-back";
import type { CommandContext } from "@stricli/core";
import { answeringUi, buildCommand, markFailed } from "../../cli-ui.js";
import { z } from "zod";
import { baseDir } from "../../config.js";
import { readResidentPid } from "../../resident/resident.js";
import { isProjectPairing, type Pairing, pairingKey, pairingRemoteDir, type ProjectDirection, readState, setProjectDirection } from "../config.js";
import { canonicalFolder, foldersOverlap, sameFolder } from "../folders.js";
import { sessionName } from "../mutagen.js";
import { ensureMutagen } from "../binary/mutagen-binary.js";
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
    throw new Error(holder === undefined ? `no project on this device syncs ${dir}` : `${dir} is inside the project folder ${holder.pairing.localDir}: pass that folder`);
};

// A part that opens with a command a person types, which stays as it is typed: "Intentic-machine sync …" runs nothing.
const COMMAND = /^(?:intentic-machine|intentic-sync|intentic|ic)(?:\s|$)/u;

// A message as the sentence the app shows: capitalised, ending in a full stop. Not a command, which is copied as typed.
const sentence = (message: string): string => {
    const text = message.trim();
    const opening = COMMAND.test(text) ? text.charAt(0) : text.charAt(0).toUpperCase();
    return `${opening}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
};

// A stop composed with explain, as the one sentence run a JSON reader shows: headline, why, and what to do.
const flatSentence = (message: string): string =>
    message
        .split("\n")
        .map((line) => line.replace(/^\s*(?:problem|fix):\s*/, ""))
        .filter((line) => line.trim() !== "")
        .map(sentence)
        .join(" ");

// How a command that answers through `answer` reads to a person: the live line while it works, and the headline its stop
// opens with when it does not (the thrown sentence then says why).
export interface Answering {
    readonly doing?: string;
    readonly failed: string;
}

// A thrown reason as a stop's `problem:`, or the whole stop when it was composed as one (explain) already. Its first
// letter is lowered to run on from the headline, unless it opens an acronym ("JSON Parse error"), which lowered reads
// as "jSON".
const asStop = (failed: string, message: string): string => {
    if (message.includes("\n   problem: ") || message.includes("\n   fix: ")) {
        return message;
    }
    const text = message.trim();
    const acronym = /^\p{Lu}\p{Lu}/u.test(text);
    return explain(failed, `${acronym ? text.charAt(0) : text.charAt(0).toLowerCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`);
};

// What every one of these commands prints, and the one exit code a failure has; `sync attach` and `sync detach` answer
// the same way (attach-commands.ts). Under --json stdout is the one object, every human line goes to stderr, and a
// failure is `{ ok: false, error }`; otherwise the result is drawn and a failure is the run's stop (cli-ui.ts).
export const answer = async <R extends { readonly ok: true }>(
    cli: CommandContext,
    json: boolean,
    work: (ui: Ui) => Promise<R>,
    human: (result: R, ui: Ui) => void,
    words: Answering,
): Promise<void> => {
    const ui = answeringUi(cli.process, json);
    if (!json && words.doing !== undefined) {
        ui.act(words.doing);
    }
    let result: R;
    try {
        result = await work(ui);
    } catch (error) {
        if (!json) {
            throw new Error(asStop(words.failed, errorMessage(error)), { cause: error });
        }
        ui.close();
        // allow(terminal-output): the --json failure object the desktop app reads
        cli.process.stdout.write(`${JSON.stringify({ ok: false, error: flatSentence(errorMessage(error)) })}\n`);
        markFailed(cli);
        return;
    }
    if (json) {
        ui.close();
        // allow(terminal-output): the --json result object the desktop app reads
        cli.process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    human(result, ui);
};

const pairingAt = async (dir: string | undefined): Promise<ProjectPairing> => {
    if (dir === undefined || dir.trim() === "") {
        throw new Error("pass --dir with the project's folder on this device");
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

// What a bring-back or a restore left alone, each said under the running line.
const sayLeft = (ui: Ui, skipped: readonly Skipped[], what: string): void => {
    for (const entry of skipped) {
        ui.warn(`${shown(entry.path)} was not ${what}: ${entry.reason}.`);
    }
};

const changeItem = (change: ListedChange): Item => ({
    tone: change.conflict === true ? "warn" : "ok",
    name: shown(change.path),
    meta: [
        change.kind,
        change.size === undefined ? undefined : plural(change.size, "byte"),
        change.conflict === true ? "conflict: bring-back leaves this folder's copy as it is" : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(" · "),
});

// A folder as one argument of a command a person may paste: quoted when it holds a space or a quote.
const asArgument = (dir: string): string => (/^[\w./:\\~-]+$/.test(dir) ? dir : JSON.stringify(dir));

interface ProjectFlags {
    readonly dir?: string;
    readonly json: boolean;
}

const projectFlags = {
    dir: { kind: "parsed", parse: String, optional: true, brief: "The project's folder on this device" },
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
            (result, ui) => {
                ui.report("intentic · changes to bring back", `${dir} · ${result.direction}`);
                if (result.changes.length === 0) {
                    ui.quiet(`The sandbox's copy of ${dir} has nothing to bring back.`);
                    return;
                }
                ui.items(result.changes.map(changeItem));
                if (result.truncated === true) {
                    ui.quiet(`Only the first ${plural(result.changes.length, "change")} are listed; there are more.`);
                }
                ui.later([["bring them back, a restore point first", `intentic-machine sync bring-back --dir ${asArgument(dir)}`]]);
            },
            { failed: "The sandbox's changes could not be listed." },
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
            (result, ui) => {
                sayLeft(ui, result.skipped, "brought back");
                if (result.applied.length === 0) {
                    ui.done(`Nothing was brought back into ${dir}.`);
                    return;
                }
                ui.note(`Restore point ${result.point} holds what they replaced.`);
                ui.done(`Brought ${plural(result.applied.length, "change")} back into ${dir}.`);
                ui.later([["undo it", `intentic-machine sync restore --dir ${asArgument(dir)} --point ${result.point}`]]);
            },
            { doing: "Bringing changes back from the sandbox", failed: "Nothing was brought back." },
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
            (result, ui) => {
                ui.report("intentic · restore points", `${dir} · newest first`);
                if (result.points.length === 0) {
                    ui.quiet("No restore points yet: one is kept at each bring-back.");
                    return;
                }
                ui.items(result.points.map((point) => ({ tone: "ok", name: point.id, meta: `${point.createdAt} · ${plural(point.entries, "file")}` })));
                ui.later([["undo a bring-back", `intentic-machine sync restore --dir ${asArgument(dir)} --point <id>`]]);
            },
            { failed: "The restore points could not be listed." },
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
                    throw new Error(
                        explain("Nothing was restored.", "no restore point was named: pass --point with one of the ids the listing shows.", "intentic-machine sync restore-points"),
                    );
                }
                const point = flags.point.trim();
                return await restorePoint(await contextFor(await pairingAt(flags.dir)), point);
            },
            (result, ui) => {
                sayLeft(ui, result.skipped, "restored");
                ui.done(`Restored ${plural(result.restored, "file")}.`);
            },
            { doing: "Restoring the folder from its restore point", failed: "Nothing was restored." },
        );
    },
});


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
                    throw new Error(`say which way, to-sandbox (copy-first) or both${value === undefined ? "" : `, not ${value}`}`);
                }
                const pairing = await pairingAt(flags.dir);
                dir = pairing.localDir;
                await setProjectDirection(pairingKey(pairing), direction);
                running = (await readResidentPid()) !== undefined;
                return { ok: true, direction };
            },
            (result, ui) => {
                if (result.direction === "both") {
                    ui.note("What an agent changes in the sandbox comes straight back here, deletions included. A file both sides changed is held as a conflict rather than overwritten.");
                } else {
                    ui.note("It flows into the sandbox, and what an agent changes there comes back only when you bring it back.");
                }
                ui.note(running ? "This device's agent switches its file sync over within a few seconds." : "This device's agent is not running, so the switch applies when it next starts.");
                ui.done(result.direction === "both" ? `${dir} now syncs both ways.` : `${dir} is copy-first.`);
                if (!running) {
                    ui.later([["start the agent", "intentic-machine run"]]);
                }
            },
            { doing: "Changing which way the project syncs", failed: "The direction was not changed." },
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
