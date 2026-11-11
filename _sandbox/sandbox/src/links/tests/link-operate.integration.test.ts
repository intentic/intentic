import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { LINK_HEADER } from "@intentic/sandbox-contract/schemas/links";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { z } from "zod";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import type { InProcessServer, MountSpec } from "../../agent/tools/turn-mounts.js";
import { armSupervisor, type ChildSupervisor } from "../../agent/subagents/children.js";
import type { AppEnv } from "../../app-env.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { fileInboundLinks, inboundLinksDocument } from "../inbound-links.js";
import { linkMountsOf } from "../link-mounts.js";
import { createLinkOperateDoors, type OperatePlace, readAnswerOf } from "../link-operate.js";

// Operating a linked sandbox, both halves over HTTP: the taking side runs a link's commands, reads and writes only while
// its terms allow operating, where a person's shell runs (here the workspace root, or the jail `place` names); the asking
// side's tools reach those doors through the card it holds, in a turn that may hand work on.

const quiet = { info: () => undefined, warn: () => undefined };

const taking = (place: () => Promise<OperatePlace> = async () => ({ jailed: false })) => {
    const dir = mkdtempSync(join(tmpdir(), "operate-"));
    const root = join(dir, "work");
    mkdirSync(root);
    const links = fileInboundLinks(join(dir, inboundLinksDocument.path));
    const doors = createLinkOperateDoors({ links, logger: quiet, root, place });
    const app = new Hono<AppEnv>();
    app.post("/link/operate/exec", doors.exec);
    app.get("/link/operate/exec/:id", doors.status);
    app.post("/link/operate/exec/:id/stop", doors.stop);
    app.post("/link/operate/read", doors.read);
    app.post("/link/operate/write", doors.write);
    return { app, links, root };
};

const AnswerSchema = z.looseObject({});

const door = async (app: Hono<AppEnv>, path: string, token: string, body?: object) => {
    const init: RequestInit =
        body === undefined
            ? { headers: { [LINK_HEADER]: token } }
            : { method: "POST", headers: { [LINK_HEADER]: token, "content-type": "application/json" }, body: JSON.stringify(body) };
    const response = await app.request(`http://sandbox.test${path}`, init);
    return { status: response.status, body: AnswerSchema.parse(await response.json()) };
};

const operable = async (links: ReturnType<typeof taking>["links"]) => (await links.mint("home", { terms: { operate: true } })).token;

test("a link operates nothing until its owner allows it", async () => {
    const { app, links } = taking();
    const { id, token } = await links.mint("home", {});
    expect((await door(app, "/link/operate/exec", "ilk_not-a-link", { command: "id" })).status).toBe(401);
    for (const [path, body] of [
        ["/link/operate/exec", { command: "id" }],
        ["/link/operate/read", { path: "." }],
        ["/link/operate/write", { path: "x", content: "y" }],
    ] as const) {
        expect(await door(app, path, token, body)).toMatchObject({ status: 403, body: { error: expect.stringContaining("may not operate this sandbox") } });
    }
    await links.update(id, { operate: true });
    expect(await door(app, "/link/operate/exec", token, { command: "true" })).toMatchObject({ status: 200, body: { state: "exited", exitCode: 0 } });
});

test("a command runs in the workspace root, or where it names, and answers its streams and exit", async () => {
    const { app, links, root } = taking();
    const token = await operable(links);
    const ran = await door(app, "/link/operate/exec", token, { command: "pwd; echo out; echo err >&2; exit 3", waitS: 10 });
    expect(ran.body).toMatchObject({ state: "exited", exitCode: 3, stdout: `${root}\nout\n`, stderr: "err\n", jailed: false, cwd: root, truncated: false });
    mkdirSync(join(root, "sub"));
    expect((await door(app, "/link/operate/exec", token, { command: "pwd", cwd: "sub", waitS: 10 })).body).toMatchObject({ stdout: `${join(root, "sub")}\n` });
    expect((await door(app, "/link/operate/exec", token, { command: "" })).status).toBe(400);
});

test("a long command is read again until it ends, only by the link that started it, and may be stopped or time out", async () => {
    const { app, links } = taking();
    const token = await operable(links);
    const started = await door(app, "/link/operate/exec", token, { command: "sleep 1; echo done", waitS: 0 });
    expect(started.body).toMatchObject({ state: "running", stdout: "" });
    const id = String(started.body["id"]);
    expect((await door(app, `/link/operate/exec/${id}`, await operable(links))).status).toBe(404);
    expect((await door(app, `/link/operate/exec/${id}?wait=10`, token)).body).toMatchObject({ state: "exited", exitCode: 0, stdout: "done\n" });

    const long = await door(app, "/link/operate/exec", token, { command: "sleep 30", waitS: 0 });
    expect((await door(app, `/link/operate/exec/${String(long.body["id"])}/stop`, token, {})).body).toMatchObject({ state: "stopped" });
    expect((await door(app, "/link/operate/exec", token, { command: "sleep 30", timeoutS: 1, waitS: 10 })).body).toMatchObject({ state: "timeout" });
});

test("a file is written whole, its folders made, and read back by lines; a directory is listed; a missing path says so", async () => {
    const { app, links, root } = taking();
    const token = await operable(links);
    expect((await door(app, "/link/operate/write", token, { path: "notes/a.txt", content: "one\ntwo\nthree\n" })).body).toEqual({
        path: join(root, "notes", "a.txt"),
        bytes: 14,
        jailed: false,
    });
    expect(readFileSync(join(root, "notes", "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect((await door(app, "/link/operate/read", token, { path: "notes/a.txt", offset: 2, limit: 1 })).body).toEqual({
        path: join(root, "notes", "a.txt"),
        kind: "file",
        content: "two\n",
        bytes: 14,
        lines: 3,
        truncated: true,
        jailed: false,
    });
    expect((await door(app, "/link/operate/read", token, { path: join(root, "notes", "a.txt") })).body).toMatchObject({ content: "one\ntwo\nthree\n", truncated: false });
    const listed = await door(app, "/link/operate/read", token, { path: "notes" });
    expect(listed.body).toMatchObject({ kind: "directory", content: expect.stringContaining("a.txt") });
    expect(await door(app, "/link/operate/read", token, { path: "nowhere" })).toMatchObject({ status: 404, body: { error: expect.stringContaining("no such file") } });
});

test("while the jail is wanted every door runs through it, and a jail that cannot be built refuses rather than run as root", async () => {
    // A stand-in for bwrap: it marks the environment and enters the directory, which is what the doors may rely on.
    const jailed = taking(async () => ({ jailed: true, argv: (cwd, command) => ["env", "OPERATE_JAILED=1", "sh", "-c", 'cd "$0" && exec "$@"', cwd, ...command] }));
    const token = await operable(jailed.links);
    expect((await door(jailed.app, "/link/operate/exec", token, { command: "echo $OPERATE_JAILED; pwd", waitS: 10 })).body).toMatchObject({
        state: "exited",
        stdout: `1\n${jailed.root}\n`,
        jailed: true,
    });
    expect((await door(jailed.app, "/link/operate/write", token, { path: "j.txt", content: "x" })).body).toMatchObject({ jailed: true });
    expect((await door(jailed.app, "/link/operate/read", token, { path: "j.txt" })).body).toMatchObject({ content: "x", jailed: true });

    const unbuilt = taking(async () => ({ refused: "this sandbox cannot build the jail" }));
    const refusedToken = await operable(unbuilt.links);
    expect(await door(unbuilt.app, "/link/operate/exec", refusedToken, { command: "id" })).toMatchObject({ status: 503, body: { error: "this sandbox cannot build the jail" } });
    expect((await door(unbuilt.app, "/link/operate/read", refusedToken, { path: "." })).status).toBe(503);
});

test("a read that is not text answers no content, and says so", () => {
    expect(readAnswerOf("/work/a.bin", { stdout: "F 3 0\n\u0000\u0001\u0002", truncated: false }, false, { start: 1, count: 10 })).toEqual({
        path: "/work/a.bin",
        kind: "file",
        content: "",
        bytes: 3,
        lines: 0,
        binary: true,
        truncated: false,
        jailed: false,
    });
});

describe("the asking side's tools operate through the card it holds", () => {
    let far: ServerType | undefined;
    afterEach(() => far?.close());

    const ToolAnswerSchema = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) });

    const listening = async (app: Hono<AppEnv>): Promise<string> => {
        far = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
        await new Promise((resolve) => far?.once("listening", resolve));
        // SAFETY: a server listening on a TCP port answers its address as an AddressInfo.
        return `http://127.0.0.1:${(far.address() as AddressInfo).port}`;
    };

    // The card's server on a turn that may hand work on, called as the turn's door would call it.
    const toolsFor = async (url: string, token: string) => {
        const card: Capability = { id: "ops", kind: "link", config: { url, token, name: "Ops" } };
        const { conversations } = memoryFleet();
        armSupervisor(conversations, "conv-a", unstubbed<ChildSupervisor>("supervisor", {}));
        const opened: MountSpec[] = [];
        const lease = {
            open: (spec: MountSpec): AgentTool => {
                opened.push(spec);
                return unstubbed<AgentTool>("tool", { name: spec.name });
            },
        };
        linkMountsOf({ conversations, about: async () => undefined }, [card], lease, "conv-a");
        const target = opened[0]?.target;
        if (target?.kind !== "daemon") {
            throw new Error("a link is mounted as a daemon server");
        }
        const server: InProcessServer = target.server;
        await server.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
        let next = 0;
        return async (name: string, args: object) => {
            next += 1;
            const answered = ToolAnswerSchema.parse(await server.handle({ jsonrpc: "2.0", id: next, method: "tools/call", params: { name, arguments: args } }));
            return AnswerSchema.parse(JSON.parse(answered.result.content.map((part) => part.text).join("")));
        };
    };

    test("run_command, write_file and read_file reach the far sandbox's main checkout", async () => {
        const side = taking();
        const tool = await toolsFor(await listening(side.app), await operable(side.links));
        expect(await tool("run_command", { command: "echo hi; exit 0" })).toMatchObject({ ok: true, state: "exited", exitCode: 0, stdout: "hi\n", cwd: side.root, jailed: false });
        expect(await tool("run_command", { command: "exit 4" })).toMatchObject({ ok: false, state: "exited", exitCode: 4 });
        expect(await tool("write_file", { path: "fix.txt", content: "fixed\n" })).toMatchObject({ ok: true, bytes: 6 });
        expect(await tool("read_file", { path: "fix.txt" })).toMatchObject({ ok: true, kind: "file", content: "fixed\n" });
    });

    test("a link that may not operate, and a far sandbox too old for the doors, are each said as what they are", async () => {
        const side = taking();
        const tool = await toolsFor(await listening(side.app), (await side.links.mint("home", {})).token);
        expect(await tool("run_command", { command: "id" })).toMatchObject({ ok: false, message: expect.stringContaining("may not operate this sandbox") });
        far?.close();

        const old = new Hono<AppEnv>();
        old.all("*", (c) => c.json({ error: "unauthorized" }, 401));
        const stale = await toolsFor(await listening(old), "ilk_x");
        expect(await stale("read_file", { path: "." })).toMatchObject({ ok: false, message: expect.stringContaining("too old") });
    });
});
