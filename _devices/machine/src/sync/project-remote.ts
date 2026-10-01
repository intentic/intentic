import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type RemoteShell, remoteShell, type SandboxEndpoint } from "./endpoint.js";
import { type Listing, parseListing } from "./project-files.js";

// THE SANDBOX'S SIDE of a copy-first project, reached the way file sync reaches it: over the pairing's ssh alias, one
// command per listing and one per fetch, and its Mutagen session, by name. Both go through ProjectRunner, which a test
// answers with a local folder and a fake Mutagen (src/testing.ts), so the programs below run for real either way.

export interface Exited {
    // Null when the process was killed (a timeout) or never started.
    readonly status: number | null;
    // The tail of what it said there, for the sentence a failure is reported in.
    readonly stderr: string;
}

export interface Spawned {
    readonly stdout: AsyncIterable<Buffer>;
    readonly exit: Promise<Exited>;
}

export interface SpawnOptions {
    // Written to the process's stdin, which is then closed.
    readonly input?: string;
    // A hang bound: a transport that stops answering must not hold a bring-back open for good.
    readonly timeoutMs: number;
}

export interface ProjectRunner {
    readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => Spawned;
}

const STDERR_TAIL = 4096;

export const realProjectRunner: ProjectRunner = {
    spawn: (command, args, options) => {
        // windowsHide: no console window for a child of a console-less parent (the desktop app runs these).
        const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL);
        });
        // A process that exits without reading its input (ssh that cannot connect) is reported by its status, not by
        // an EPIPE thrown here.
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.input ?? "");
        const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
        const exit = new Promise<Exited>((resolve) => {
            child.on("error", (error) => {
                clearTimeout(timer);
                resolve({ status: null, stderr: `${stderr}${error.message}` });
            });
            child.on("close", (status) => {
                clearTimeout(timer);
                resolve({ status, stderr });
            });
        });
        return { stdout: child.stdout, exit };
    },
};

export interface Collected extends Exited {
    readonly stdout: Buffer;
}

export const collect = async (spawned: Spawned): Promise<Collected> => {
    const chunks: Buffer[] = [];
    for await (const chunk of spawned.stdout) {
        chunks.push(chunk);
    }
    return { ...(await spawned.exit), stdout: Buffer.concat(chunks) };
};

// What ssh runs on the far side: node, the sandbox image's own, with the program and its input as base64. That is the
// one spelling every remote shell (sh, bash, zsh) and every local ssh (OpenSSH, Git for Windows' build) passes through
// untouched, whatever the program and the paths in it hold.
export const remoteNodeCommand = (program: string, input: string): string =>
    `node -e 'eval(Buffer.from("${Buffer.from(program).toString("base64")}","base64").toString())' ${Buffer.from(input).toString("base64")}`;

// The sandbox's copy, walked by the same ignore expressions this device's walk prunes by (project-files.ts), and every
// regular file hashed, since that listing is the only look at it this device gets. NUL after every field: see
// parseListing. Exit 3 is a sandbox without the folder at all, told apart so it is never read as an empty one.
export const LISTING_PROGRAM = String.raw`
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { root, ignore } = JSON.parse(Buffer.from(process.argv[1], "base64").toString());
const rules = ignore.map((source) => new RegExp(source));
const fields = [];
const hashed = (file) => new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    let size = 0;
    fs.createReadStream(file)
        .on("data", (chunk) => { digest.update(chunk); size += chunk.length; })
        .on("error", reject)
        .on("end", () => resolve([String(size), digest.digest("hex")]));
});
const walk = async (relative) => {
    for (const entry of await fs.promises.readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = relative === "" ? entry.name : relative + "/" + entry.name;
        if (rules.some((rule) => rule.test(name))) continue;
        if (entry.isDirectory()) { await walk(name); continue; }
        if (!entry.isFile()) { fields.push(name, "-", "-"); continue; }
        try { fields.push(name, ...(await hashed(path.join(root, name)))); }
        catch (error) { if (error.code !== "ENOENT") fields.push(name, "-", "-"); }
    }
};
fs.promises.stat(root).then(
    (info) => info.isDirectory() ? walk("").then(() => process.stdout.write(fields.map((field) => field + "\0").join(""))) : Promise.reject(new Error(root + " is not a folder")),
    (error) => { if (error.code === "ENOENT") process.exitCode = 3; else throw error; },
).catch((error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
`;

// The files asked for (NUL-separated on stdin), in that order, each as a header line and then exactly its bytes:
// `{"i":n,"size":bytes,"x":executable}`, or `{"i":n,"skip":reason}` for one that is not a regular file reached through
// plain folders any more. Opened without following a link and without blocking on a pipe; a file that shrank while it
// was read is padded to the size its header promised, which its hash then tells.
export const FETCH_PROGRAM = String.raw`
const fs = require("fs");
const path = require("path");
const { root } = JSON.parse(Buffer.from(process.argv[1], "base64").toString());
const write = (data) => new Promise((resolve, reject) => process.stdout.write(data, (error) => (error ? reject(error) : resolve())));
const header = (frame) => write(JSON.stringify(frame) + "\n");
const plainFolders = async (name) => {
    let at = root;
    for (const part of name.split("/").slice(0, -1)) {
        at = path.join(at, part);
        if (!(await fs.promises.lstat(at)).isDirectory()) return false;
    }
    return true;
};
const send = async (i, name) => {
    let handle;
    try {
        if (!(await plainFolders(name))) return header({ i, skip: "a folder on its way in the sandbox is not a plain folder" });
        handle = await fs.promises.open(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
        return header({ i, skip: error.code === "ENOENT" ? "it is no longer in the sandbox" : error.code === "ELOOP" ? "it is a link in the sandbox" : String(error.code || error.message) });
    }
    try {
        const info = await handle.stat();
        if (!info.isFile()) return header({ i, skip: "it is not a regular file in the sandbox" });
        await header({ i, size: info.size, x: (info.mode & 0o111) !== 0 });
        let sent = 0;
        while (sent < info.size) {
            const buffer = Buffer.alloc(Math.min(1 << 20, info.size - sent));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, sent);
            if (bytesRead === 0) { await write(Buffer.alloc(info.size - sent)); break; }
            await write(buffer.subarray(0, bytesRead));
            sent += bytesRead;
        }
    } finally {
        await handle.close();
    }
};
const input = [];
process.stdin.on("data", (chunk) => input.push(chunk));
process.stdin.on("end", () => {
    const names = Buffer.concat(input).toString().split("\0").filter((name) => name !== "");
    (async () => { for (const [i, name] of names.entries()) await send(i, name); })()
        .catch((error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
});
`;

// A file the fetch put in the staging folder, as it arrived.
export interface Fetched {
    readonly staged: string;
    readonly size: number;
    readonly hash: string;
    readonly executable: boolean;
}

// One the sandbox did not send, and why, in words for the `skipped` list.
export interface NotFetched {
    readonly skipped: string;
}

const FrameSchema = z.union([
    z.object({ i: z.number().int().nonnegative(), size: z.number().int().nonnegative(), x: z.boolean() }),
    z.object({ i: z.number().int().nonnegative(), skip: z.string() }),
]);

// Longer than any header the fetch writes; past it the stream is not the fetch's.
const HEADER_MAX = 64 * 1024;

const writeAll = async (handle: FileHandle, data: Buffer): Promise<void> => {
    for (let offset = 0; offset < data.length; ) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a short write continues where it stopped
        const { bytesWritten } = await handle.write(data, offset);
        offset += bytesWritten;
    }
};

interface Receiving {
    readonly at: number;
    readonly staged: string;
    readonly handle: FileHandle;
    readonly digest: Hash;
    readonly size: number;
    readonly executable: boolean;
    remaining: number;
}

// Reads the fetch's stream into `<staging>/<n>`, one file per header, and answers per path. Never a path from the
// stream: files are named by their place in the request, so the sandbox cannot name where anything lands.
export const receiveFiles = async (stdout: AsyncIterable<Buffer>, paths: readonly string[], staging: string): Promise<Map<string, Fetched | NotFetched>> => {
    const answers = new Map<string, Fetched | NotFetched>();
    let pending = Buffer.alloc(0);
    let body: Receiving | undefined;
    const finish = async (file: Receiving): Promise<void> => {
        await file.handle.close();
        answers.set(paths[file.at] ?? "", { staged: file.staged, size: file.size, hash: file.digest.digest("hex"), executable: file.executable });
        body = undefined;
    };
    const begin = async (line: string): Promise<void> => {
        const frame = FrameSchema.parse(JSON.parse(line));
        if (frame.i !== answers.size || frame.i >= paths.length) {
            throw new Error("the sandbox answered the fetch out of order");
        }
        if ("skip" in frame) {
            answers.set(paths[frame.i] ?? "", { skipped: frame.skip });
            return;
        }
        const staged = join(staging, String(frame.i));
        const file: Receiving = { at: frame.i, staged, handle: await open(staged, "wx", 0o600), digest: createHash("sha256"), size: frame.size, executable: frame.x, remaining: frame.size };
        body = file;
        if (file.remaining === 0) {
            await finish(file);
        }
    };
    for await (const chunk of stdout) {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length > 0) {
            if (body !== undefined) {
                const piece = pending.subarray(0, body.remaining);
                // oxlint-disable-next-line eslint/no-await-in-loop -- the stream is one file after another
                await writeAll(body.handle, piece);
                body.digest.update(piece);
                body.remaining -= piece.length;
                pending = pending.subarray(piece.length);
                if (body.remaining === 0) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
                    await finish(body);
                }
                continue;
            }
            const newline = pending.indexOf(10);
            if (newline === -1) {
                if (pending.length > HEADER_MAX) {
                    throw new Error("the sandbox's answer to the fetch is not one this agent asked for");
                }
                break;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await begin(pending.subarray(0, newline).toString("utf8"));
            pending = pending.subarray(newline + 1);
        }
    }
    // A stream that stopped inside a file leaves that file unfinished: closed, and not answered as fetched.
    await body?.handle.close();
    return answers;
};

// ssh as file sync's own transport uses it: never a prompt, a bounded dial, and a dead connection noticed within a
// minute rather than held open until the hang bound.
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"];

// A listing hashes the whole copy and a fetch carries whole files; both are bounded far above a slow case, as a hang
// bound only (the ssh options above end a dead connection much sooner).
const TRANSFER_TIMEOUT_MS = 60 * 60_000;

export interface SandboxCopy {
    readonly list: (ignoreExpressions: readonly string[]) => Promise<Listing>;
    // Fetches regular files into `staging`, answering for every path asked for.
    readonly fetch: (paths: readonly string[], staging: string) => Promise<ReadonlyMap<string, Fetched | NotFetched>>;
}

// How the bring-back reaches the sandbox's copy, the way its pairing does (endpoint.ts): ssh with the options above, or
// `docker exec` into the container on this machine's engine.
export const projectShell = (endpoint: SandboxEndpoint, ssh: string): RemoteShell => remoteShell(endpoint, ssh, SSH_OPTIONS);

const failure = (what: string, exited: Exited, shell?: RemoteShell): Error => {
    const said = exited.stderr.trim().split("\n").at(-1) ?? "";
    const why =
        shell?.unreachable !== undefined && exited.status === shell.unreachable.status
            ? shell.unreachable.sentence
            : exited.status === null
              ? "it did not finish in time"
              : `it exited with ${exited.status}`;
    return new Error(`${what} failed: ${why}${said === "" ? "" : ` (${said})`}`);
};

export const sandboxCopy = (runner: ProjectRunner, shell: RemoteShell, remoteDir: string): SandboxCopy => {
    const command = (program: string, input: string): readonly string[] => shell.argsFor(remoteNodeCommand(program, input));
    return {
        list: async (ignoreExpressions) => {
            const listed = await collect(
                runner.spawn(shell.command, command(LISTING_PROGRAM, JSON.stringify({ root: remoteDir, ignore: ignoreExpressions })), { timeoutMs: TRANSFER_TIMEOUT_MS }),
            );
            if (listed.status === 3) {
                throw new Error(`the sandbox has no ${remoteDir}: its copy of this folder is gone`);
            }
            if (listed.status !== 0) {
                throw failure(`listing the sandbox's copy (${remoteDir})`, listed, shell);
            }
            return parseListing(listed.stdout.toString("utf8"));
        },
        fetch: async (paths, staging) => {
            if (paths.length === 0) {
                return new Map();
            }
            const spawned = runner.spawn(shell.command, command(FETCH_PROGRAM, JSON.stringify({ root: remoteDir })), {
                input: paths.map((path) => `${path}\0`).join(""),
                timeoutMs: TRANSFER_TIMEOUT_MS,
            });
            const answers = await receiveFiles(spawned.stdout, paths, staging);
            const exited = await spawned.exit;
            // Whatever did not arrive says why the transfer stopped.
            const stopped = exited.status === 0 ? "the sandbox did not send it" : failure("fetching from the sandbox", exited, shell).message;
            return new Map(paths.map((path) => [path, answers.get(path) ?? { skipped: stopped }]));
        },
    };
};

// A project's Mutagen session, by the name the watcher gives it (mutagen.ts sessionName), so whichever session holds
// the name when a command runs is the one it acts on: a replacement the watcher made in between included.
// A file Mutagen reported in conflict: its digests (SHA-1, Mutagen's own hash) of this device's copy when the two copies
// last agreed and now, either absent where Mutagen had none (a session that never saw them agree).
export interface ReportedConflict {
    readonly agreed?: string | undefined;
    readonly here?: string | undefined;
}

export interface SessionView {
    readonly state: "absent" | "paused" | "running";
    // The file conflicts Mutagen listed, by path: ten at most, however many it counts.
    readonly conflicts: ReadonlyMap<string, ReportedConflict>;
}

export interface SessionControl {
    readonly inspect: () => Promise<SessionView>;
    // A cycle now, so the listing that follows is not ahead of what the session has carried; false when it could not.
    readonly flush: () => Promise<boolean>;
    readonly pause: () => Promise<void>;
    readonly resume: () => Promise<void>;
}

// What `sync list --template {{json .}}` prints of a session that is read here (mutagen.ts LiveSession has the rest):
// a conflict's changes on this device's side, `old` the entry both last agreed on and `new` this device's now.
const EntrySchema = z.object({ kind: z.string().optional(), digest: z.string().optional() }).nullable().optional();
const SessionListSchema = z
    .array(
        z.object({
            paused: z.boolean().optional(),
            conflicts: z
                .array(z.object({ root: z.string().optional(), alphaChanges: z.array(z.object({ path: z.string().optional(), old: EntrySchema, new: EntrySchema })).nullable().optional() }))
                .nullable()
                .optional(),
        }),
    )
    .nullable();

type ListedSession = NonNullable<z.infer<typeof SessionListSchema>>[number];

const sessionsIn = (listed: string): readonly ListedSession[] => {
    try {
        return SessionListSchema.safeParse(JSON.parse(listed)).data ?? [];
    } catch {
        // allow(silent-catch): an answer that is not Mutagen's JSON names no session to hold still.
        return [];
    }
};

const fileDigest = (entry: z.infer<typeof EntrySchema>): string | undefined => (entry?.kind === "file" ? entry.digest : undefined);

// Each conflict rooted at a file, with this device's side of it. A conflict rooted at a folder names no one file.
const reportedConflicts = (session: ListedSession | undefined): Map<string, ReportedConflict> =>
    new Map(
        (session?.conflicts ?? []).flatMap((conflict) => {
            const root = conflict.root ?? "";
            const change = conflict.alphaChanges?.find((candidate) => (candidate.path ?? "") === root);
            return root === "" || change === undefined ? [] : [[root, { agreed: fileDigest(change.old), here: fileDigest(change.new) }] as const];
        }),
    );

// Mutagen answers these from its own daemon; a resume dials the sandbox again.
const SESSION_TIMEOUT_MS = 2 * 60_000;

// A flush waits for a whole cycle, and for as long as the sandbox is not connected, so it gets a bound of its own: it only
// makes a listing fresher (the record of agreement is what keeps a pending edit here from reading as the sandbox's), and
// the listing after it fails fast on a sandbox that does not answer.
const FLUSH_TIMEOUT_MS = 30_000;

export const mutagenSession = (runner: ProjectRunner, mutagen: string, name: string): SessionControl => {
    const run = async (args: readonly string[], timeoutMs = SESSION_TIMEOUT_MS): Promise<Collected> => await collect(runner.spawn(mutagen, ["sync", ...args, name], { timeoutMs }));
    const must = async (verb: "pause" | "resume"): Promise<void> => {
        const done = await run([verb]);
        if (done.status !== 0) {
            throw failure(`${verb === "pause" ? "pausing" : "resuming"} the file sync of this folder`, done);
        }
    };
    return {
        inspect: async () => {
            const listed = await run(["list", "--template", "{{json .}}"]);
            // Non-zero is Mutagen's "no session by that name" (or no daemon), which is no session to hold still.
            const sessions = listed.status === 0 ? sessionsIn(listed.stdout.toString("utf8")) : [];
            const state = sessions.length === 0 ? "absent" : sessions.every((session) => session.paused === true) ? "paused" : "running";
            return { state, conflicts: reportedConflicts(sessions[0]) };
        },
        flush: async () => (await run(["flush"], FLUSH_TIMEOUT_MS)).status === 0,
        pause: async () => await must("pause"),
        resume: async () => await must("resume"),
    };
};
