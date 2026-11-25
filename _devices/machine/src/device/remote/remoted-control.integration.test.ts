import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { connectRemoted, REMOTED_CONTROL_PROTOCOL, remotedEndpoint, stopRemotedAt } from "./remoted-control.js";

/* The control connection over a real socket (a named pipe on Windows), against a stand-in remoted that greets as
   remoted does: the hello read, what the agent sends, lines after it, and asking a remoted to leave. */

let dir: string;
let server: Server | undefined;
const sockets = new Set<Socket>();

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rc-"));
});
afterEach(async () => {
    for (const socket of sockets) {
        socket.destroy();
    }
    sockets.clear();
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    server = undefined;
    await rm(dir, { recursive: true, force: true });
});

const HELLO = { type: "hello" as const, protocol: REMOTED_CONTROL_PROTOCOL, accepts: [REMOTED_CONTROL_PROTOCOL], build: "1.2.3", pid: process.pid, startedAt: 1 };

// A remoted's endpoint: the hello on every connection, then `answer` for each line the agent sends.
const listen = async (endpoint: string, answer: (line: string, socket: Socket) => void, greets = true): Promise<void> => {
    server = createServer((socket) => {
        sockets.add(socket);
        if (greets) {
            socket.write(`${JSON.stringify(HELLO)}\n`);
        }
        let partial = "";
        socket.setEncoding("utf8").on("data", (chunk: string) => {
            const lines = (partial + chunk).split("\n");
            partial = lines.pop() ?? "";
            for (const line of lines) {
                answer(line, socket);
            }
        });
    });
    await new Promise<void>((resolve) => server?.listen(endpoint, resolve));
};

test("the hello is read, what is sent arrives, and the lines after it are heard", async () => {
    const endpoint = remotedEndpoint(dir);
    const heard: string[] = [];
    await listen(endpoint, (line, socket) => {
        heard.push(line);
        socket.write(`${JSON.stringify({ type: "status", terminals: 1 })}\n${JSON.stringify({ type: "log", line: "a" })}\n`);
    });
    const connection = await connectRemoted(endpoint);
    expect(connection?.hello).toEqual(HELLO);
    const messages: unknown[] = [];
    connection?.onMessage((message) => void messages.push(message));
    connection?.send({ type: "adopt", protocol: REMOTED_CONTROL_PROTOCOL });
    await waitFor(() => expect(messages).toHaveLength(2), SETTLES);
    expect(heard).toEqual([JSON.stringify({ type: "adopt", protocol: REMOTED_CONTROL_PROTOCOL })]);
    expect(messages).toEqual([
        { type: "status", terminals: 1 },
        { type: "log", line: "a" },
    ]);
    connection?.close();
    await connection?.closed;
});

test("nothing listening, a dead socket's path, or no hello is no connection", async () => {
    expect(await connectRemoted(remotedEndpoint(dir))).toBeUndefined();
    if (process.platform !== "win32") {
        await writeFile(join(dir, "remoted.sock"), "");
        expect(await connectRemoted(join(dir, "remoted.sock"))).toBeUndefined();
    }
    await mkdir(join(dir, "quiet"));
    const endpoint = remotedEndpoint(join(dir, "quiet"));
    await listen(endpoint, () => undefined, false);
    expect(await connectRemoted(endpoint, 200)).toBeUndefined();
});

test("uninstall asks the remoted to stop and waits for it to go; with none answering, the pidfile's live one is named", async () => {
    const endpoint = remotedEndpoint(dir);
    const asked: string[] = [];
    await listen(endpoint, (line, socket) => {
        asked.push(line);
        socket.end();
    });
    let gone = false;
    const stopped = await stopRemotedAt(endpoint, join(dir, "remoted.pid"), { alive: () => !gone && asked.length === 0, waitMs: 2_000 });
    gone = true;
    expect(asked).toEqual([JSON.stringify({ type: "stop" })]);
    expect(stopped).toEqual({ kind: "stopped", pid: process.pid });

    const elsewhere = remotedEndpoint(join(dir, "none"));
    expect(await stopRemotedAt(elsewhere, join(dir, "remoted.pid"))).toEqual({ kind: "none" });
    await writeFile(join(dir, "remoted.pid"), JSON.stringify({ pid: 4321 }));
    expect(await stopRemotedAt(elsewhere, join(dir, "remoted.pid"), { alive: (pid) => pid === 4321 })).toEqual({ kind: "still-running", pid: 4321 });
});

