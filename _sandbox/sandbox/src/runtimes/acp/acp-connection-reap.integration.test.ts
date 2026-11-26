import { methods } from "@agentclientprotocol/sdk/unstable";
import { unstubbed } from "@intentic/testing";
import { createLogger } from "../../logger.js";
import type { TerminalRunner } from "../../terminal/terminal-run.js";
import { createAcpConnections, withConnection, type AcpReapTimes, type TurnHooks } from "./acp-connection.js";
import { acpLaunchOf } from "./acp-spawn.js";

/* A model-list probe's process ends after the unheld grace; a conversation's warm process keeps the idle reap. */

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const terminal = unstubbed<TerminalRunner>("terminal", { visible: false });
const launch = acpLaunchOf({ command: "node --import tsx src/runtimes/acp/__fixtures__/fake-acp-process.ts" });

// Short times so the tests finish in under a second.
const FAST: AcpReapTimes = { idleMs: 300, unheldMs: 80 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const noop: TurnHooks = { onUpdate: () => {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) };

test("a probe that lets go ends the process after the unheld grace, not the idle reap", async () => {
    const connections = createAcpConnections(logger, terminal, FAST);
    const connection = await connections.acquire("probe-only", launch, process.cwd());
    // Open and release a session, as the catalog probes do.
    const created = await connection.agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    connection.release(created.sessionId);
    connection.letGo();
    expect(connection.alive()).toBe(true);
    // The unheld grace (80 ms) should end the process; the idle reap (300 ms) should not be waited.
    await sleep(150);
    expect(connection.alive()).toBe(false);
});

test("withConnection lets go on success, ending the process after the grace", async () => {
    const connections = createAcpConnections(logger, terminal, FAST);
    const connection = await withConnection(
        connections.acquire("with-success", launch, process.cwd()),
        async (conn) => {
            const created = await conn.agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
            conn.release(created.sessionId);
            return conn;
        },
    );
    expect(connection.alive()).toBe(true);
    await sleep(150);
    expect(connection.alive()).toBe(false);
});

test("withConnection lets go on failure too", async () => {
    const connections = createAcpConnections(logger, terminal, FAST);
    let grabbed: ReturnType<typeof connections.acquire> extends Promise<infer C> ? C : never;
    await expect(
        withConnection(connections.acquire("with-failure", launch, process.cwd()), async (conn) => {
            grabbed = conn;
            throw new Error("boom");
        }),
    ).rejects.toThrow("boom");
    expect(grabbed!.alive()).toBe(true);
    await sleep(150);
    expect(grabbed!.alive()).toBe(false);
});

test("a turn's bound session keeps the process alive past the unheld grace", async () => {
    const connections = createAcpConnections(logger, terminal, FAST);
    const connection = await connections.acquire("turn-warm", launch, process.cwd());
    const created = await connection.agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    // The turn setup (acp-session-setup.ts) registers the session; a direct session/new does not.
    connection.sessions.add(created.sessionId);
    // Bind a turn, as the adapter does: the process is held.
    const unbind = connection.bindTurn(created.sessionId, noop);
    connection.letGo();
    // Wait past the unheld grace; the turn holds the process.
    await sleep(150);
    expect(connection.alive()).toBe(true);
    // Unbinding with the session still registered (a conversation resumes it) starts the idle reap,
    // not the unheld grace, because `sessions` is non-empty.
    unbind();
    expect(connection.alive()).toBe(true);
    // Wait past the unheld grace but not the idle reap.
    await sleep(150);
    expect(connection.alive()).toBe(true);
    // Wait for the idle reap to fire.
    await sleep(250);
    expect(connection.alive()).toBe(false);
});

test("a probe on a conversation's warm process does not shorten the idle reap", async () => {
    const connections = createAcpConnections(logger, terminal, FAST);
    // A turn acquires and binds, with its session registered (acp-session-setup.ts does this in production).
    const connection = await connections.acquire("shared", launch, process.cwd());
    const session = await connection.agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    connection.sessions.add(session.sessionId);
    const unbind = connection.bindTurn(session.sessionId, noop);
    connection.letGo();

    // A probe acquires the same agent (same configKey → same pooled process) and lets go.
    const probeConn = await connections.acquire("shared", launch, process.cwd());
    expect(probeConn).toBe(connection);
    const probeSession = await probeConn.agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    probeConn.release(probeSession.sessionId);
    probeConn.letGo();

    // The turn unbinds; the conversation's session is still registered, so the idle reap governs.
    unbind();
    await sleep(150);
    expect(connection.alive()).toBe(true);
    await sleep(250);
    expect(connection.alive()).toBe(false);
});

test("concurrent acquires for the same agent share one process", async () => {
    const connections = createAcpConnections(logger, terminal, FAST);
    const [a, b] = await Promise.all([
        connections.acquire("dedup", launch, process.cwd()),
        connections.acquire("dedup", launch, process.cwd()),
    ]);
    expect(a).toBe(b);
    // Both entered; let both go.
    a.letGo();
    b.letGo();
    await sleep(150);
    expect(a.alive()).toBe(false);
});
