import { execFile } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import type { DeviceScopes, StageArtifact, StageArtifactResult } from "@intentic/sandbox-contract";
import { baseDir } from "../../../config.js";
import { assertScope } from "../../policy.js";

const exec = promisify(execFile);

// PROGRAMS A SANDBOX SENT, FILED ON THIS MACHINE (schemas/device-artifacts.ts). Each sandbox has its own folder under
// ~/.intentic/machine/runs, and each push lands in `<sandbox>/<name>/<first 12 of its sha256>/`, written once and never
// overwritten: a second push of the same build is answered from what is there, and a running copy is never swapped from
// under its process. The bytes arrive in order, hashed as they come, and are filed only when size and hash match what
// the sandbox announced. Behind "Run programs this sandbox sends", checked on every op.

// A folder is "there" once this marker is in it; one without it is a filing that died half-way and is filed again.
const COMPLETE = ".intentic-complete";
// An upload nobody committed or aborted in this long is the sandbox giving up silently: its bytes are deleted.
const STALE_UPLOAD_MS = 60 * 60 * 1000;

export const runsRoot = (): string => join(baseDir, "runs");

// The sandbox's own folder, named for its address's first label: `sandbox-82789f4106b4.example.com` is
// `sandbox-82789f4106b4`. Plain characters only, so a crafted address cannot reach outside runs.
export const sandboxRunsDir = (sandboxUrl: string): string => {
    let label = "sandbox";
    try {
        label = new URL(sandboxUrl).hostname.split(".")[0] ?? label;
    } catch {
        // allow(silent-catch): an address that is not a URL still gets a folder, the generic one
    }
    const safe = label.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 63) || "sandbox";
    return join(runsRoot(), safe);
};

// Whether `path` is inside this sandbox's runs folder: what decides that starting it needs "Run programs" rather than
// "Run commands".
export const inRuns = (path: string, sandboxUrl: string): boolean => {
    const root = resolve(sandboxRunsDir(sandboxUrl));
    const target = resolve(path);
    return target === root || target.startsWith(`${root}${sep}`);
};

interface Upload {
    readonly handle: FileHandle;
    readonly hash: Hash;
    readonly path: string;
    received: number;
    touched: number;
}

const uploads = new Map<string, Upload>();

const incomingDir = (sandboxUrl: string): string => join(sandboxRunsDir(sandboxUrl), ".incoming");
const finalDir = (sandboxUrl: string, name: string, sha256: string): string => join(sandboxRunsDir(sandboxUrl), name, sha256.slice(0, 12));
const finalPath = (dir: string, kind: "file" | "tar", fileName: string): string => (kind === "file" ? join(dir, fileName) : dir);

const exists = async (path: string): Promise<boolean> =>
    await stat(path).then(
        () => true,
        () => false,
    );

const dropUpload = async (id: string): Promise<void> => {
    const upload = uploads.get(id);
    if (upload === undefined) {
        return;
    }
    uploads.delete(id);
    // allow(silent-catch): an upload being thrown away has nothing left to say if its handle or file is already gone
    await upload.handle.close().catch(() => undefined);
    await rm(upload.path, { force: true });
};

// Uploads left open past their hour, and their bytes.
const sweep = async (now: number): Promise<void> => {
    for (const [id, upload] of uploads) {
        if (now - upload.touched > STALE_UPLOAD_MS) {
            await dropUpload(id);
        }
    }
};

const uploadFor = async (sandboxUrl: string, id: string, offset: number): Promise<Upload> => {
    const known = uploads.get(id);
    if (known !== undefined) {
        return known;
    }
    if (offset !== 0) {
        throw new Error(`upload ${id} is not open here (the agent restarted mid-push?): push again`);
    }
    const dir = incomingDir(sandboxUrl);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}.part`);
    const created: Upload = { handle: await open(path, "w"), hash: createHash("sha256"), path, received: 0, touched: Date.now() };
    uploads.set(id, created);
    return created;
};

// A tar's entries all stay inside the folder it is unpacked into: bsdtar (Windows, macOS) and GNU tar both refuse `..`
// and strip a leading `/` by default, and the folder is a fresh one nobody else writes into.
const unpack = async (archive: string, into: string): Promise<void> => {
    await mkdir(into, { recursive: true });
    try {
        await exec("tar", ["-xf", archive, "-C", into], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
        throw new Error(`could not unpack the pushed folder: ${errorMessage(error)}`, { cause: error });
    }
};

const file = async (upload: Upload, op: Extract<StageArtifact, { op: "commit" }>, sandboxUrl: string): Promise<string> => {
    const dir = finalDir(sandboxUrl, op.name, op.sha256);
    const target = finalPath(dir, op.kind, op.fileName);
    if (await exists(join(dir, COMPLETE))) {
        await rm(upload.path, { force: true });
        return target;
    }
    // A half-filed folder from a filing that died is cleared first; nothing runs from one, since it was never answered.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    if (op.kind === "file") {
        await rename(upload.path, target);
    } else {
        try {
            await unpack(upload.path, dir);
        } finally {
            await rm(upload.path, { force: true });
        }
    }
    await writeFile(join(dir, COMPLETE), `${op.sha256}\n`);
    return target;
};

export const stageArtifact = async (op: StageArtifact, scopes: DeviceScopes, sandboxUrl: string): Promise<StageArtifactResult> => {
    assertScope(scopes, "programs");
    const now = Date.now();
    await sweep(now);
    switch (op.op) {
        case "have": {
            const dir = finalDir(sandboxUrl, op.name, op.sha256);
            return (await exists(join(dir, COMPLETE))) ? { path: finalPath(dir, op.kind, op.fileName) } : {};
        }
        case "chunk": {
            const upload = await uploadFor(sandboxUrl, op.upload, op.offset);
            if (op.offset !== upload.received) {
                await dropUpload(op.upload);
                throw new Error(`piece at ${op.offset} arrived when ${upload.received} bytes were held: push again`);
            }
            const bytes = Buffer.from(op.data, "base64");
            await upload.handle.write(bytes);
            upload.hash.update(bytes);
            upload.received += bytes.byteLength;
            upload.touched = now;
            return { received: upload.received };
        }
        case "commit": {
            // An empty build arrives with no chunk at all; it is still a file.
            const upload = uploads.get(op.upload) ?? (op.size === 0 ? await uploadFor(sandboxUrl, op.upload, 0) : undefined);
            if (upload === undefined) {
                throw new Error(`upload ${op.upload} is not open here: push again`);
            }
            uploads.delete(op.upload);
            await upload.handle.close();
            const sha256 = upload.hash.digest("hex");
            if (upload.received !== op.size || sha256 !== op.sha256) {
                await rm(upload.path, { force: true });
                throw new Error(`what arrived (${upload.received} bytes, sha256 ${sha256.slice(0, 12)}) is not what was sent (${op.size} bytes, ${op.sha256.slice(0, 12)})`);
            }
            return { path: await file(upload, op, sandboxUrl) };
        }
        case "abort": {
            await dropUpload(op.upload);
            return {};
        }
    }
};

// What this sandbox has filed here, newest first, for app_status to list when nothing runs.
export const listArtifacts = async (sandboxUrl: string): Promise<{ name: string; version: string; path: string; at: Date }[]> => {
    const root = sandboxRunsDir(sandboxUrl);
    const names = await readdir(root).catch(() => [] as string[]);
    const found: { name: string; version: string; path: string; at: Date }[] = [];
    for (const name of names.filter((entry) => !entry.startsWith("."))) {
        for (const version of await readdir(join(root, name)).catch(() => [] as string[])) {
            const marker = await stat(join(root, name, version, COMPLETE)).catch(undefinedIfMissing);
            if (marker !== undefined) {
                found.push({ name, version, path: join(root, name, version), at: marker.mtime });
            }
        }
    }
    return found.toSorted((a, b) => b.at.getTime() - a.at.getTime());
};
