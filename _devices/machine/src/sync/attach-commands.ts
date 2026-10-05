import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { homeDir, type Log } from "@intentic/local-agent";
import { isProjectDirName, projectRemoteDir } from "@intentic/sandbox-contract";
import { buildCommand, type CommandContext } from "@stricli/core";
import { baseDir } from "../config.js";
import { ensureResident } from "../resident.js";
import {
    attachedKey,
    isAttachedPairing,
    type Pairing,
    pairingKey,
    pairingTransport,
    readState,
    removePairing,
    upsertPairing,
} from "./config.js";
import { transportFor } from "./endpoint.js";
import { canonicalFolder, folderRefusal, overlappingPairing, sameFolder } from "./folders.js";
import { ensureMutagen, existingSyncSessions, MUTAGEN_CALL_TIMEOUT_MS, syncSessionNames } from "./mutagen.js";
import { answer, projectPairingFor } from "./project-commands.js";
import { assertFolder, listingRecordPath } from "./project-local.js";
import { pairingSshConfig, writeManagedSshConfig } from "./ssh.js";

// FOLDERS ATTACH TO THIS COMPUTER'S OWN SANDBOX. `sync setup --projects-host` enrolls that sandbox once, with no folder
// of its own; each folder the owner opens then attaches to it as `/work/<name>`, a pairing of its own filed under
// `<sandboxId>~<name>` (config.ts `pairingKey`), copy-first like any project, and taking landed work by itself
// (`deliver: "auto"`, project-delivery.ts). Both verbs are local: no enrollment, no network. Like setup, attach only
// records the pairing; the resident agent creates its Mutagen session on its next pass (mirror.ts), and `status --json`
// says when the first copy is done. With `--json` each prints one JSON object, as the copy-first commands do
// (project-commands.ts `answer`).

export interface AttachAsk {
    readonly sandboxUrl?: string | undefined;
    readonly dir?: string | undefined;
    readonly name?: string | undefined;
}

export interface AttachResult {
    readonly ok: true;
    // The new pairing's key, `<sandboxId>~<name>`.
    readonly pairing: string;
    readonly remoteDir: string;
    // The folder as it is recorded: as given, made absolute (links are resolved only to compare folders).
    readonly folder: string;
}

export interface DetachResult {
    readonly ok: true;
    readonly pairing: string;
    readonly folder: string;
}

// What attaching needs from the machine, injectable so the rules are checked without Docker or a resident agent.
export interface AttachSeams {
    // The container on this machine's engine that runs a sandbox (endpoint.ts localSandboxContainer).
    readonly locate?: (sandboxUrl: string) => Promise<string | undefined>;
    // The user's home folder, which a folder may neither be nor hold.
    readonly home?: string;
}

const hostOf = (url: string): string | undefined => (URL.canParse(url) ? new URL(url).host.toLowerCase() : undefined);

// The projects host whose sandbox answers at `sandboxUrl`, compared by host alone, so a trailing slash or a path on
// either spelling never reads as another sandbox.
export const projectsHostFor = (pairings: readonly Pairing[], sandboxUrl: string): Pairing | undefined => {
    const wanted = hostOf(sandboxUrl);
    return wanted === undefined ? undefined : pairings.find((pairing) => pairing.projectsHost === true && hostOf(pairing.sandboxUrl) === wanted);
};

// A `~` prefix can reach us verbatim (the desktop app passes data, no shell expands it).
const expandedFolder = (dir: string): string => resolve(dir.replace(/^~(?=[\\/]|$)/, homeDir()));

// The three flags, each said for when it is missing.
const asked = (ask: AttachAsk): { readonly sandboxUrl: string; readonly dir: string; readonly name: string } => {
    const missing = (value: string | undefined): boolean => value === undefined || value.trim() === "";
    if (missing(ask.sandboxUrl)) {
        throw new Error("pass --sandbox-url with the address of this computer's sandbox");
    }
    if (missing(ask.dir)) {
        throw new Error("pass --dir with the folder to attach");
    }
    if (missing(ask.name)) {
        throw new Error("pass --name with the folder's name in the sandbox (it becomes /work/<name>)");
    }
    return { sandboxUrl: ask.sandboxUrl ?? "", dir: ask.dir ?? "", name: ask.name ?? "" };
};

// ONE FOLDER, ONE SYNC (folders.ts): a folder another pairing is, holds or sits inside, said for which kind it is.
const refuseOverlap = async (folder: string, key: string, host: Pairing, pairings: readonly Pairing[]): Promise<void> => {
    const clash = await overlappingPairing(folder, key, pairings);
    if (clash === undefined) {
        return;
    }
    throw new Error(
        clash.sandboxId === host.sandboxId && isAttachedPairing(clash)
            ? `${folder} overlaps ${clash.localDir}, which is already attached as ${clash.remoteDir ?? "a folder of this sandbox"}: one folder is one sync. Detach that one first, or pick a folder that neither is, holds nor sits inside it.`
            : `${folder} overlaps ${clash.localDir}, which already syncs with ${clash.sandboxId}: two syncs over one folder overwrite each other's files. Choose a folder that neither is, holds nor sits inside one this machine syncs (\`intentic-machine status\` lists them).`,
    );
};

// The pairing `sync attach` records, or a sentence saying why not. Every refusal is asked before anything is written.
export const planAttach = async (pairings: readonly Pairing[], ask: AttachAsk, seams: AttachSeams = {}): Promise<Pairing> => {
    const { sandboxUrl, dir, name } = asked(ask);
    const host = projectsHostFor(pairings, sandboxUrl);
    if (host === undefined) {
        throw new Error(
            `this computer's sandbox is not set up for folders yet: no sandbox at ${sandboxUrl} was enrolled here with \`intentic-machine sync setup --projects-host\``,
        );
    }
    if (!isProjectDirName(name)) {
        throw new Error(
            `${JSON.stringify(name)} cannot name a folder in the sandbox: a name starts with a letter or digit, holds only letters, digits, ".", "_" and "-", is at most 64 characters, and is not one the sandbox keeps for itself`,
        );
    }
    const wanted = expandedFolder(dir);
    await assertFolder(wanted);
    const folder = await canonicalFolder(wanted);
    const refusal = folderRefusal(folder, await canonicalFolder(seams.home ?? homeDir()));
    if (refusal !== undefined) {
        throw new Error(refusal);
    }
    const key = attachedKey(host.sandboxId, name);
    // Recorded as given rather than with its links resolved, as `sync setup` records a folder: the desktop app finds its
    // folder in `status --json` by the path it passed, and on Fedora Atomic `/home` is itself a link to `/var/home`.
    const remoteDir = projectRemoteDir(name);
    const sameName = pairings.find((pairing) => pairingKey(pairing) === key);
    if (sameName?.localDir !== undefined && !sameFolder(await canonicalFolder(sameName.localDir), folder)) {
        throw new Error(`${sameName.localDir} is already attached as ${remoteDir}; detach it first (\`intentic-machine sync detach --dir ${JSON.stringify(sameName.localDir)}\`) or pick another name`);
    }
    await refuseOverlap(folder, key, host, pairings);
    // Docker whenever the sandbox's container runs here, as it does for the machine's own sandbox: the copy is then up in
    // seconds and nothing of it rides ssh.
    const reach = await transportFor("auto", { project: true }, host.sandboxUrl, seams.locate);
    return {
        sandboxUrl: host.sandboxUrl,
        sandboxId: host.sandboxId,
        key,
        mode: "sync",
        ...(host.syncToken === undefined ? {} : { syncToken: host.syncToken }),
        localDir: wanted,
        remoteDir,
        project: true,
        // Copy-first, unless the owner already chose both ways for this same folder and name.
        direction: sameName?.direction ?? "to-sandbox",
        deliver: "auto",
        // The sandbox's switch, carried so the report says of this folder what it says of its sandbox. A folder never
        // mirrors ports whatever it says (mirror.ts): the projects host does, once.
        ...(host.mirrorOff === true ? { mirrorOff: true } : {}),
        ...(sameName?.autoHealOff === true ? { autoHealOff: true } : {}),
        ...reach,
    };
};

// ATTACH: the pairing recorded, the ssh alias written when the folder rides ssh, and the resident agent made sure of,
// which creates the session. Returns as soon as the pairing is on disk: the first copy is the agent's, and a folder of
// any size would hold the command (and the window that asked) for as long as it took.
export const attachFolder = async (ask: AttachAsk, log: Log, seams: AttachSeams & { readonly ensureAgent?: (log: Log) => Promise<void> } = {}): Promise<AttachResult> => {
    const pairing = await planAttach((await readState()).pairings, ask, seams);
    await upsertPairing(pairing);
    if (pairingTransport(pairing) === "ssh") {
        await writeManagedSshConfig(pairingSshConfig((await readState()).pairings));
    }
    await (seams.ensureAgent ?? (async (say: Log) => await ensureResident(say)))(log);
    return { ok: true, pairing: pairingKey(pairing), remoteDir: pairing.remoteDir ?? "", folder: pairing.localDir ?? "" };
};

// What detaching needs from the machine: the sessions it ends, injectable for the same reason.
export interface DetachSeams {
    readonly terminate?: (names: readonly string[]) => Promise<void>;
}

// The sessions named, those Mutagen holds, ended: `sync terminate a b` fails whole on one name it does not know.
const terminateSessions = async (names: readonly string[]): Promise<void> => {
    const mutagen = await ensureMutagen();
    const live = existingSyncSessions(mutagen, names);
    if (live.length > 0) {
        spawnSync(mutagen, ["sync", "terminate", ...live], { stdio: "ignore", windowsHide: true, timeout: MUTAGEN_CALL_TIMEOUT_MS });
    }
};

// DETACH: the folder's pairing removed first (so the agent recreates nothing), then its session ended and its listing
// record dropped. Its restore points stay, so a delivery or a bring-back can still be undone from the folder's side.
export const detachFolder = async (dir: string | undefined, stateDir: string, seams: DetachSeams = {}): Promise<DetachResult> => {
    if (dir === undefined || dir.trim() === "") {
        throw new Error("pass --dir with the attached folder");
    }
    const pairing = await projectPairingFor((await readState()).pairings, dir);
    if (!isAttachedPairing(pairing)) {
        throw new Error(
            `${pairing.localDir} has a sandbox of its own (${pairing.sandboxId}), not attached to this computer's: \`intentic-machine sync uninstall --sandbox ${pairing.sandboxId}\` unpairs it`,
        );
    }
    const key = pairingKey(pairing);
    await removePairing(key);
    await (seams.terminate ?? terminateSessions)(syncSessionNames(pairing));
    await rm(listingRecordPath(stateDir, key), { force: true });
    return { ok: true, pairing: key, folder: pairing.localDir };
};

interface AttachFlags {
    readonly sandboxUrl?: string;
    readonly dir?: string;
    readonly name?: string;
    readonly json: boolean;
}

const attach = buildCommand<AttachFlags>({
    docs: { brief: "Attach a folder to this computer's sandbox as /work/<name>: copied one way into it, landed work delivered back" },
    parameters: {
        flags: {
            sandboxUrl: { kind: "parsed", parse: String, optional: true, brief: "This computer's sandbox, as `sync setup --projects-host` enrolled it" },
            dir: { kind: "parsed", parse: String, optional: true, brief: "The folder to attach" },
            name: { kind: "parsed", parse: String, optional: true, brief: "Its name in the sandbox: it becomes /work/<name>" },
            json: { kind: "boolean", brief: "Print one JSON object, `ok` first (what the desktop app reads)" },
        },
    },
    async func(this: CommandContext, flags: AttachFlags) {
        // Whatever starting the agent says goes to stderr under --json, so stdout stays the one object.
        const log: Log = (message) => void (flags.json ? this.process.stderr : this.process.stdout).write(`${message}\n`);
        await answer(
            this,
            flags.json,
            async () => await attachFolder(flags, log),
            (result) =>
                `Attached ${result.folder} as ${result.remoteDir}. Its first copy into the sandbox starts within a few seconds (\`intentic-machine status\` shows when it is done); landed work comes back into it by itself, a restore point first.`,
        );
    },
});

interface DetachFlags {
    readonly dir?: string;
    readonly json: boolean;
}

const detach = buildCommand<DetachFlags>({
    docs: { brief: "Detach a folder from this computer's sandbox; its restore points are kept" },
    parameters: {
        flags: {
            dir: { kind: "parsed", parse: String, optional: true, brief: "The attached folder" },
            json: { kind: "boolean", brief: "Print one JSON object, `ok` first (what the desktop app reads)" },
        },
    },
    async func(this: CommandContext, flags: DetachFlags) {
        await answer(
            this,
            flags.json,
            async () => await detachFolder(flags.dir, baseDir),
            (result) => `Detached ${result.folder}: it no longer syncs with the sandbox. Its restore points are kept.`,
        );
    },
});

export const attachCommands = { attach, detach };
