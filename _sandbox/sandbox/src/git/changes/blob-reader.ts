import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { gitBytes } from "@intentic/scaffold";

// Object bytes for a review's sides, read from one long-lived `git cat-file --batch-command` per repository instead
// of a process per blob: a 400-row review reads up to 800 of them. Only names that can never move are read this way (a
// blob id, or a path in a named commit): an index or HEAD spec would be answered from the state the reader started
// with, so it keeps a process of its own.

// A reader idle this long ends; the next read starts another.
const IDLE_MS = 30_000;

const IMMUTABLE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?::.+)?$/u;

type Reply = { readonly missing: true } | { readonly missing: false; readonly oid: string; readonly size: number; readonly content?: Buffer };

// One repository's reader: commands go one at a time, each answered before the next is written.
class BatchReader {
    private readonly child: ChildProcessWithoutNullStreams;
    private buffered: Buffer = Buffer.alloc(0);
    private waiting: { readonly contents: boolean; readonly resolve: (reply: Reply) => void; readonly reject: (error: Error) => void } | undefined;
    private chain: Promise<unknown> = Promise.resolve();
    private idle: ReturnType<typeof setTimeout> | undefined;
    ended = false;

    constructor(dir: string) {
        this.child = spawn("git", ["-C", dir, "cat-file", "--batch-command"], { stdio: ["pipe", "pipe", "pipe"] });
        this.child.stdout.on("data", (chunk: Buffer) => {
            this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
            this.pump();
        });
        const end = (why: Error): void => {
            this.ended = true;
            clearTimeout(this.idle);
            this.waiting?.reject(why);
            this.waiting = undefined;
        };
        this.child.on("error", end);
        this.child.on("exit", () => end(new Error("the blob reader exited")));
        // Its own diagnostics are git's to keep; a reader that is failing shows as rejected reads.
        this.child.stderr.resume();
    }

    // Size first, so an object over `maxBytes` is refused before any of it is buffered.
    read(spec: string, maxBytes: number): Promise<Buffer | undefined> {
        const next = this.chain.then(async () => {
            clearTimeout(this.idle);
            try {
                const info = await this.command(`info ${spec}`, false);
                if (info.missing || info.size > maxBytes) {
                    return undefined;
                }
                const contents = await this.command(`contents ${info.oid}`, true);
                return contents.missing ? undefined : contents.content;
            } finally {
                this.idle = setTimeout(() => this.child.stdin.end(), IDLE_MS);
                this.idle.unref();
            }
        });
        // silent-catch: this read's caller has its rejection from `next`; the chain only orders the reads after it.
        this.chain = next.catch(() => undefined);
        return next;
    }

    private command(line: string, contents: boolean): Promise<Reply> {
        return new Promise((resolve, reject) => {
            if (this.ended) {
                reject(new Error("the blob reader has ended"));
                return;
            }
            this.waiting = { contents, resolve, reject };
            this.child.stdin.write(`${line}\n`);
            this.pump();
        });
    }

    // Answers the waiting command once its whole reply has arrived: a header line, then for contents that many bytes and
    // a newline.
    private pump(): void {
        const waiting = this.waiting;
        const newline = this.buffered.indexOf(0x0a);
        if (waiting === undefined || newline === -1) {
            return;
        }
        const header = this.buffered.subarray(0, newline).toString("utf8");
        if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
            this.buffered = this.buffered.subarray(newline + 1);
            this.waiting = undefined;
            waiting.resolve({ missing: true });
            return;
        }
        const [oid = "", , size = "0"] = header.split(" ");
        const bytes = Number(size);
        if (!waiting.contents) {
            this.buffered = this.buffered.subarray(newline + 1);
            this.waiting = undefined;
            waiting.resolve({ missing: false, oid, size: bytes });
            return;
        }
        if (this.buffered.length < newline + 1 + bytes + 1) {
            return;
        }
        // Copied out, since a view would pin every chunk it was cut from.
        const content = Buffer.from(this.buffered.subarray(newline + 1, newline + 1 + bytes));
        this.buffered = this.buffered.subarray(newline + 1 + bytes + 1);
        this.waiting = undefined;
        waiting.resolve({ missing: false, oid, size: bytes, content });
    }
}

const readers = new Map<string, BatchReader>();

// The object at `spec` in the repository at `dir`, or undefined when it is missing or larger than `maxBytes`.
export const readObject = async (dir: string, spec: string, maxBytes: number): Promise<Buffer | undefined> => {
    if (!IMMUTABLE.test(spec)) {
        // silent-catch: an object git cannot produce reads as missing, which is this reader's contract.
        return gitBytes(dir, ["cat-file", "-p", spec], maxBytes).catch(() => undefined);
    }
    let reader = readers.get(dir);
    if (reader === undefined || reader.ended) {
        reader = new BatchReader(dir);
        readers.set(dir, reader);
    }
    // silent-catch: an object git cannot produce reads as missing, which is this reader's contract.
    return reader.read(spec, maxBytes).catch(() => undefined);
};
