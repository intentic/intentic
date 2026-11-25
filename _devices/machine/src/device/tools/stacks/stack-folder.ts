import { copyFile, lstat, mkdir, readdir, readFile, readlink, stat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { insideRel, realInside, realPathThrough } from "@intentic/base/contained";
import { undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import { ScopeError } from "../../policy.js";
import { sandboxRunsDir } from "../programs/artifacts.js";
import { COMPLETE } from "../programs/builds.js";

/* WHAT A DEPLOY WRITES INTO A STACK'S FOLDER, AND FROM WHERE (deploy_stack, stacks.ts). The repository arrives the way
   every pushed build does, unpacked into this sandbox's runs folder (programs/artifacts.ts), and only a folder filed
   there is copied: deploy_stack is no way to copy any other folder on this machine. The stack's folder is the stack's
   home for good, where its services may keep their data in bind mounts and where the owner puts its secrets, so a copy
   only adds and overwrites. It deletes nothing, never writes a `.env` (one in the repository is not copied, and one
   already there is not touched), and never writes through, or replaces, a link it finds in the folder: a link a
   container or an earlier deploy left there could otherwise send the repository's files anywhere on this machine.
   (2026-11-25) A managed deploy's own `.env`, docker config and pins are written after the copy, by stack-state.ts. */

// What a deploy records beside the stack: the commit whose files are in the folder, and when they were put there.
export const DEPLOY_RECORD = ".intentic-deploy.json";

// (2026-11-25) The stack's own state, which only the agent writes: its docker config and its image pins (stack-state.ts).
// Not `.intentic/`, which a deployed repository may hold for itself (its run.json, its stacks manifest).
export const STACK_STATE_DIR = ".intentic-stack";

// The real path of a folder inside a build this sandbox pushed here and filed whole (`<runs>/<name>/<version>/…`, its
// COMPLETE marker written last), or undefined for any other path, a half-unpacked build's included.
const filedFolder = async (source: string, sandboxUrl: string): Promise<string | undefined> => {
    const runs = await realPathThrough(sandboxRunsDir(sandboxUrl));
    const real = await realInside(runs, source);
    const [name = "", version = ""] = real === undefined ? [] : (insideRel(runs, real) ?? "").split("/");
    if (real === undefined || name === "" || name.startsWith(".") || version === "") {
        return undefined;
    }
    // allow(silent-catch): a marker or a folder that cannot be read is a build that is not filed whole here
    const [marker, folder] = await Promise.all([stat(join(runs, name, version, COMPLETE)).catch(() => undefined), stat(real).catch(() => undefined)]);
    return marker !== undefined && folder?.isDirectory() === true ? real : undefined;
};

// `source` as the folder to copy from, or a refusal naming the only folders a deploy is taken from.
export const stagedSource = async (source: string, sandboxUrl: string): Promise<string> => {
    const real = await filedFolder(source, sandboxUrl);
    if (real === undefined) {
        throw new ScopeError(
            `Refused to deploy from "${source}": a stack is deployed only from a folder this sandbox pushed to this device ` +
                `(inside ${sandboxRunsDir(sandboxUrl)}), and deploy_stack copies no other folder.`,
        );
    }
    return real;
};

// The compose file inside `dir`, as the path compose is handed (under `dir` as spelled, so the working folder compose
// records stays inside the stacks root), once its real path is a file inside `dir`.
export const composeFileIn = async (dir: string, composeFile: string, where: string): Promise<string> => {
    const path = join(dir, ...composeFile.split("/"));
    const real = await realInside(dir, path);
    // allow(silent-catch): a compose file that cannot be read is one that is not there, which the refusal below says
    const found = real === undefined ? undefined : await stat(real).catch(() => undefined);
    if (found?.isFile() !== true) {
        throw new Error(`There is no compose file at ${composeFile} in ${where}${real === undefined ? " (it leads out of it)" : ""}.`);
    }
    return path;
};

type EntryKind = "folder" | "file" | "link";

// A link first: a Dirent and an lstat both answer for the link itself, never for what it leads to. A socket, a pipe or a
// device is none of the three, and is not copied.
const kindOf = (entry: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): EntryKind | undefined => {
    if (entry.isSymbolicLink()) {
        return "link";
    }
    if (entry.isDirectory()) {
        return "folder";
    }
    return entry.isFile() ? "file" : undefined;
};

// Never written by a copy: a `.env` at any depth, in any case, since Windows and macOS would let a `.ENV` overwrite one;
// and at the top, a filed build's marker, the record a deploy writes itself and the stack's own state folder.
const neverCopied = (name: string, top: boolean): boolean => {
    const lower = name.toLowerCase();
    return lower === ".env" || (top && (lower === COMPLETE || lower === DEPLOY_RECORD || lower === STACK_STATE_DIR));
};

export type CopyStep =
    | { readonly kind: "folder"; readonly to: string }
    | { readonly kind: "file"; readonly from: string; readonly to: string }
    // A link in the repository replaces a link of the same name, never a file or a folder: a link is only a name.
    | { readonly kind: "link"; readonly target: string; readonly to: string; readonly replaces: boolean };

export interface CopyPlan {
    // In the order they are applied: each folder before what goes in it.
    readonly steps: readonly CopyStep[];
    // The paths whose kind in the stack's folder differs from the repository's, each with both; any one stops the copy
    // before it writes anything.
    readonly clashes: readonly string[];
}

// One entry of the repository against whatever is at its place in the stack's folder: a clash, or what to write there
// and whether to go on into it.
type EntryPlan = { readonly clash: string } | { readonly step?: CopyStep; readonly descend: boolean };

const planEntry = async (from: string, to: string, path: string, kind: EntryKind): Promise<EntryPlan> => {
    const there = await lstat(to).catch(undefinedIfMissing);
    const found = there === undefined ? undefined : (kindOf(there) ?? "something that is not a file");
    if (found !== undefined && found !== kind) {
        return { clash: `${path} (a ${found} in the stack's folder, a ${kind} in the repository)` };
    }
    if (kind === "folder") {
        return found === undefined ? { step: { kind, to }, descend: true } : { descend: true };
    }
    if (kind === "file") {
        return { step: { kind, from, to }, descend: false };
    }
    return { step: { kind, target: await readlink(from), to, replaces: found !== undefined }, descend: false };
};

// What copying `source` over `dest` would do, read off both trees without writing. Links in the repository are copied
// as links and never followed, so the copy reads nothing outside the pushed folder.
export const planCopy = async (source: string, dest: string): Promise<CopyPlan> => {
    const steps: CopyStep[] = [];
    const clashes: string[] = [];
    const walk = async (at: readonly string[]): Promise<void> => {
        const entries = await readdir(join(source, ...at), { withFileTypes: true });
        for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
            const kind = kindOf(entry);
            if (kind === undefined || neverCopied(entry.name, at.length === 0)) {
                continue;
            }
            const path = [...at, entry.name];
            // one entry at a time: a folder's own clash decides whether what is under it is read at all
            const planned = await planEntry(join(source, ...path), join(dest, ...path), path.join("/"), kind);
            if ("clash" in planned) {
                clashes.push(planned.clash);
                continue;
            }
            steps.push(...(planned.step === undefined ? [] : [planned.step]));
            if (planned.descend) {
                await walk(path);
            }
        }
    };
    await walk([]);
    return { steps, clashes };
};

const applyStep = async (step: CopyStep): Promise<void> => {
    if (step.kind === "folder") {
        await mkdir(step.to, { recursive: true });
        return;
    }
    if (step.kind === "file") {
        // A regular file is overwritten in place, its mode taken from the repository's (an entrypoint stays executable).
        await copyFile(step.from, step.to);
        return;
    }
    if (step.replaces) {
        await unlink(step.to);
    }
    await symlink(step.target, step.to);
};

// The pushed tree copied into the stack's folder, which is made when it is not there yet.
export const copyIntoStack = async (source: string, dir: string): Promise<void> => {
    const plan = await planCopy(source, dir);
    if (plan.clashes.length > 0) {
        const shown = plan.clashes.slice(0, 10).join("; ");
        const more = plan.clashes.length > 10 ? `; and ${plan.clashes.length - 10} more` : "";
        throw new Error(
            `Nothing was copied into ${dir}: a deploy never replaces what is in a stack's folder with something of another kind, ` +
                `and here the repository disagrees with it: ${shown}${more}. Move those aside on this device, or change the repository, and deploy again.`,
        );
    }
    await mkdir(dir, { recursive: true });
    for (const step of plan.steps) {
        // in order: a folder is made before anything goes into it
        await applyStep(step);
    }
};

// (2026-11-25) The record also names the sandbox that deployed the stack (`owner`, from the link, never from the call's
// arguments), which alone may deploy, drive or read it from then on, and the sha256 of the `.env` the last managed deploy
// wrote (`envDigest`), so a `.env` changed since by hand is told from the agent's own. A record from before either is
// ownerless, and the next deploy claims it.
export const DeployRecordSchema = z.object({
    commit: z.string(),
    composeFile: z.string(),
    deployedAt: z.string(),
    owner: z.string().optional(),
    envDigest: z.string().optional(),
});
export type DeployRecord = z.infer<typeof DeployRecordSchema>;

// The record beside the stack, renamed into place, so a link left under its name is replaced rather than written through.
export const recordDeploy = async (dir: string, record: DeployRecord): Promise<void> =>
    await writeFileAtomic(join(dir, DEPLOY_RECORD), `${JSON.stringify(record, undefined, 2)}\n`);

// The record a deploy left in `dir`, or undefined where there is none. One that does not read as a record is no record:
// the folder is nobody's until a deploy writes one.
export const readDeployRecord = async (dir: string): Promise<DeployRecord | undefined> => {
    const text = await readFile(join(dir, DEPLOY_RECORD), "utf8").catch(undefinedIfMissing);
    return text === undefined ? undefined : parseJsonWith(text, DeployRecordSchema);
};

// A stack another sandbox deployed is that sandbox's: deploying over it, driving it or reading its logs from here is
// refused, naming whose it is (which is no secret). A record with no owner is from before owners were recorded.
export const refuseOtherOwner = (name: string, record: DeployRecord | undefined, caller: string): void => {
    if (record?.owner !== undefined && record.owner !== caller) {
        throw new ScopeError(
            `"${name}" on this device was deployed by another sandbox (${record.owner}): only that sandbox may deploy it, drive it or read its logs. Deploy under another name.`,
        );
    }
};
