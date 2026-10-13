import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import { sdk } from "../../engines/claude-sdk.js";
import { createDiagnosticsServer } from "../../logs/diagnostics-tools.js";
import { sdkServerDoor } from "./sdk-door.js";
import { createTurnMounts } from "../../agent/tools/turn-mounts.js";
import { createTurnMountRoute, daemonEndpoint, type MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";

// A daemon server built for the Claude Code loop, reached over the door as any other runtime reaches it: a real SDK
// server on a turn's lease, called through the door's HTTP handler with the turn's bearer.

const doorFor = () => {
    const mounts = createTurnMounts({ baseUrl: () => "http://127.0.0.1:8787/mcp" });
    const route = createTurnMountRoute(mounts, unstubbed<MountEndpoints>("endpoints", { daemon: daemonEndpoint }));
    const app = new Hono<AppEnv>().all("/mcp/:mount", route);
    const send = async (name: string, token: string, body: unknown): Promise<Response> =>
        app.request(`/mcp/${name}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    return { mounts, send };
};

// What a test reads of an answer, parsed rather than asserted.
const AnswerSchema = z.object({
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    result: z
        .object({
            content: z.array(z.object({ text: z.string().optional() })).optional(),
            tools: z.array(z.object({ name: z.string() })).optional(),
            serverInfo: z.object({ name: z.string() }).optional(),
        })
        .optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
});
type Answer = z.infer<typeof AnswerSchema>;
const answerOf = async (response: Response): Promise<Answer> => AnswerSchema.parse(await response.json());

const textOf = (body: Answer | undefined): string => (body?.result?.content ?? []).map((part) => part.text ?? "").join("\n");

test("a real daemon server mounted on a lease answers initialize, tools/list and tools/call through the door", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "sdk-door-"));
    await mkdir(join(historyRoot, "logs"), { recursive: true });
    await writeFile(join(historyRoot, "logs", "daemon.log"), `${JSON.stringify({ time: new Date().toISOString(), level: "error", message: "turn failed" })}\n`);
    const { mounts, send } = doorFor();
    const lease = mounts.lease("conv-a");
    const tool = lease.open({
        name: "diagnostics",
        target: { kind: "daemon", server: sdkServerDoor(createDiagnosticsServer({ historyRoot, usage: { turns: async () => [] } })) },
    });
    expect(tool.url).toBe("http://127.0.0.1:8787/mcp/diagnostics");
    const token = tool.token ?? "";

    const init = await send("diagnostics", token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } },
    });
    const initBody = await answerOf(init);
    expect(initBody.id).toBe(1);
    expect(initBody.result?.serverInfo?.name).toBe("diagnostics");
    expect((await send("diagnostics", token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const listed = await answerOf(await send("diagnostics", token, { jsonrpc: "2.0", id: "list", method: "tools/list" }));
    expect(listed.id).toBe("list");
    expect((listed.result?.tools ?? []).map((entry) => entry.name)).toEqual(expect.arrayContaining(["errors", "turns", "restarts"]));

    const called = await answerOf(
        await send("diagnostics", token, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "errors", arguments: {} } }),
    );
    expect(called.id).toBe(7);
    expect(textOf(called)).toContain("turn failed");

    // The lease ends with the turn: the bearer reaches nothing, and the server inside is closed.
    lease.release();
    expect((await send("diagnostics", token, { jsonrpc: "2.0", id: 8, method: "tools/list" })).status).toBe(401);
});

test("two clients' colliding ids each get their own answer, and a closed door answers a call it holds with an error", async () => {
    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
        release = resolve;
    });
    const server = sdk().createSdkMcpServer({
        name: "probe",
        tools: [
            sdk().tool("echo", "Echo", { word: z.string() }, async ({ word }) => ({ content: [{ type: "text", text: word }] })),
            sdk().tool("park", "Park", {}, async () => {
                await parked;
                return { content: [{ type: "text", text: "late" }] };
            }),
        ],
    });
    const door = sdkServerDoor(server);
    const [first, second] = await Promise.all([
        door.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { word: "one" } } }),
        door.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { word: "two" } } }),
    ]);
    expect([textOf(AnswerSchema.parse(first)), textOf(AnswerSchema.parse(second))]).toEqual(["one", "two"]);
    expect([first?.id, second?.id]).toEqual([1, 1]);

    const waiting = door.handle({ jsonrpc: "2.0", id: "p", method: "tools/call", params: { name: "park", arguments: {} } });
    // Let the instance take the call before the door shuts under it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    door.close();
    expect(await waiting).toEqual({ jsonrpc: "2.0", id: "p", error: { code: -32000, message: "this turn's tool server is closed" } });
    release();
    expect(await door.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toMatchObject({ id: 2, error: { code: -32000 } });
});

// The handler's second argument, as the MCP SDK hands it over: its signal is what a cancellation ends.
const ExtraSchema = z.object({ signal: z.instanceof(AbortSignal) });

test("a client that hangs up gets its call abandoned, and the server is told", async () => {
    let seen: AbortSignal | undefined;
    const server = sdk().createSdkMcpServer({
        name: "probe",
        tools: [
            sdk().tool("park", "Park", {}, async (_args, extra) => {
                const signal = ExtraSchema.parse(extra).signal;
                seen = signal;
                await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
                return { content: [{ type: "text", text: "late" }] };
            }),
        ],
    });
    const door = sdkServerDoor(server);
    const hangUp = new AbortController();
    const answer = door.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "park", arguments: {} } }, hangUp.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    hangUp.abort();
    expect(await answer).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32000, message: "the call was abandoned by its client" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen?.aborted).toBe(true);
    door.close();
});
