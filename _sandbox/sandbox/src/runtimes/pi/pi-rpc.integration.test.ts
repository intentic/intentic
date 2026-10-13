import { getEventListeners } from "node:events";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PiLaunch, piSpawner, type PiProcess, type PiStarted, versionAtLeast } from "./pi-rpc.js";

// The transport over a real child speaking Pi's JSONL protocol: a script that answers every command at once, except a
// `hold`, which it answers only once a `release` arrives, and a `seen`, which answers with every command type it was sent.

const FAKE_PI = `
if (process.argv.includes("--version")) {
    process.stdout.write(process.env.FAKE_PI_VERSION ?? "");
    process.exit(0);
}
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
        answer(command.id, command.type === "seen" ? seen : command.type === "argv" ? process.argv.slice(2) : command.type === "env" ? process.env[command.name] : undefined);
    }
});
`;

let dir: string;
let proc: PiProcess & Partial<PiStarted>;
let exited: Promise<void>;

const start = async (launch: Omit<PiLaunch, "cwd"> = {}, env = ""): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    exited = promise;
    proc = await piSpawner(join(dir, "sessions"))({ command: `${process.execPath} ${join(dir, "fake-pi.mjs")}`, env }, { cwd: dir, ...launch }, {
        onEvent: () => {},
        onExit: () => resolve(),
    });
};

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-rpc-"));
    writeFileSync(join(dir, "fake-pi.mjs"), FAKE_PI);
    await start();
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

// The argv entry after a flag, read off what the process was started with.
const after = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

test("a turn's Pi reads the daemon's instructions and skills from its flags, its own discovery off", async () => {
    proc.kill();
    await exited;
    await start({ instructions: { replace: "You are terse.", append: "Be brief." }, skills: [join(WORKSPACE_ROOT, ".agents", "skills", "github")] });
    // SAFETY: the fake answers `argv` with its own process.argv tail, an array of strings.
    const argv = (await proc.request({ type: "argv" })).data as string[];
    expect(argv).toEqual(expect.arrayContaining(["--mode", "rpc", "--no-context-files", "--no-skills"]));
    expect(readFileSync(after(argv, "--system-prompt") ?? "", "utf8")).toBe("You are terse.");
    expect(readFileSync(after(argv, "--append-system-prompt") ?? "", "utf8")).toBe("Be brief.");
    expect(after(argv, "--skill")).toBe(join(WORKSPACE_ROOT, ".agents", "skills", "github"));
    expect(readFileSync(after(argv, "-e") ?? "", "utf8")).toContain("registerTool");
});

const TOOLS = [{ name: "omen", url: "http://127.0.0.1:4000/mcp/omen", token: "lease" }];

test("a Pi too old for built-in MCP is handed no servers, and says so", async () => {
    proc.kill();
    await exited;
    await start({ tools: TOOLS }, "FAKE_PI_VERSION=0.84.4");
    expect(proc).toMatchObject({ version: "0.84.4", mcpMounted: false });
    // SAFETY: the fake answers `env` with the variable's value, which the spawner always sets.
    const file = (await proc.request({ type: "env", name: "INTENTIC_PI_TURN" })).data as string;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcp: [] });
});

test("a Pi with built-in MCP gets the turn's servers through the per-turn file", async () => {
    proc.kill();
    await exited;
    await start({ tools: TOOLS }, "FAKE_PI_VERSION=1.2.0");
    expect(proc.mcpMounted).toBe(true);
    // SAFETY: the fake answers `env` with the variable's value, which the spawner always sets.
    const file = (await proc.request({ type: "env", name: "INTENTIC_PI_TURN" })).data as string;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcp: TOOLS });
});

// What the extension does with the socket the turn file names: one POST, one JSON answer back.
const post = (socketPath: string, path: string, body: object): Promise<object> =>
    new Promise((resolve, reject) => {
        const sent = httpRequest({ socketPath, path, method: "POST" }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            // SAFETY: every hook endpoint answers a JSON object (hook-socket.ts HookAnswer).
            response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as object));
        });
        sent.on("error", reject);
        sent.end(JSON.stringify(body));
    });

test("the turn's hook socket is open before Pi starts, named in the per-turn file, and closed with the process", async () => {
    proc.kill();
    await exited;
    await start({ hooks: { "/tool-call": { answer: () => ({ block: true, reason: "no" }), unreadable: { block: true } } } });
    // SAFETY: the fake answers `env` with the variable's value, which the spawner always sets.
    const file = (await proc.request({ type: "env", name: "INTENTIC_PI_TURN" })).data as string;
    // SAFETY: the spawner writes the turn file as a PiTurnFile.
    const socket = (JSON.parse(readFileSync(file, "utf8")) as { hooks?: string }).hooks ?? "";
    expect(await post(socket, "/tool-call", { tool: "bash" })).toEqual({ block: true, reason: "no" });
    proc.kill();
    await exited;
    await expect(post(socket, "/tool-call", { tool: "bash" })).rejects.toThrow();
    await start();
});

test("versions compare part by part", () => {
    expect(versionAtLeast("0.99.0", [0, 99, 0])).toBe(true);
    expect(versionAtLeast("pi 1.0.3", [0, 99, 0])).toBe(true);
    expect(versionAtLeast("0.98.12", [0, 99, 0])).toBe(false);
    expect(versionAtLeast(undefined, [0, 99, 0])).toBe(false);
});
