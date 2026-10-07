import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piSpawner, type PiProcess } from "./pi-rpc.js";

// The transport over a real child speaking Pi's JSONL protocol: a script that answers every command at once, except a
// `hold`, which it answers only once a `release` arrives, and a `seen`, which answers with every command type it was sent.

const FAKE_PI = `
const held = [];
const seen = [];
let buffer = "";
const answer = (id, data) => process.stdout.write(JSON.stringify({ type: "response", id, success: true, ...(data === undefined ? {} : { data }) }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
        const command = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        seen.push(command.type);
        if (command.type === "hold") {
            held.push(command.id);
            continue;
        }
        if (command.type === "release") {
            for (const id of held.splice(0)) {
                answer(id, "late");
            }
        }
        answer(command.id, command.type === "seen" ? seen : undefined);
    }
});
`;

let dir: string;
let proc: PiProcess;
let exited: Promise<void>;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-rpc-"));
    writeFileSync(join(dir, "fake-pi.mjs"), FAKE_PI);
    const { promise, resolve } = Promise.withResolvers<void>();
    exited = promise;
    proc = piSpawner(join(dir, "sessions"))({ command: `${process.execPath} ${join(dir, "fake-pi.mjs")}` }, dir, { onEvent: () => {}, onExit: () => resolve() });
});

afterEach(async () => {
    proc.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
});

test("a request whose signal aborts rejects with its reason, and the answer that comes later reaches nobody", async () => {
    const controller = new AbortController();
    const held = proc.request({ type: "hold" }, controller.signal);
    controller.abort(new Error("gave up"));
    await expect(held).rejects.toThrow("gave up");
    // Pi answers the held command first, then this one: the late answer finds no waiter and this request gets its own.
    expect(await proc.request({ type: "release" })).toEqual({ success: true });
});

test("a request whose signal had already aborted is never written", async () => {
    await expect(proc.request({ type: "never" }, AbortSignal.abort(new Error("stopped first")))).rejects.toThrow("stopped first");
    expect(await proc.request({ type: "seen" })).toEqual({ success: true, data: ["seen"] });
});

// A caller's signal can outlive many requests (a turn's), so an answered one must take its listener off it.
test("an answered request leaves no listener on its signal", async () => {
    const controller = new AbortController();
    expect(await proc.request({ type: "seen" }, controller.signal)).toEqual({ success: true, data: ["seen"] });
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
});
