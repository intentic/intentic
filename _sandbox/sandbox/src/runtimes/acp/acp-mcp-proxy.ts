import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentTool } from "../../agent/tools/agent-tools.js";

// The daemon's stdio MCP proxy, for an ACP agent that does not advertise http MCP. Stdio is the one MCP transport every
// ACP agent must take, so the turn's door mounts (its remote servers and the daemon's own) are offered as stdio servers
// the agent spawns: each is this script, which forwards every JSON-RPC line to the door's HTTP endpoint with the turn's
// bearer and writes back what the door answers, a single JSON body or each event of an SSE stream, one line apiece.
// Mirrors t3code's acp-mcp-bridge (its server's AcpMcpStdioBridge module, in another repository), which found agents
// that take stdio and drop http (codex-acp 1.2.0, pi-acp).
//
// The URL and bearer ride the server's environment, never its argv, so they stay out of the process list. The agent
// keeps a session's MCP config across turns (a warm session), so the proxy it spawned keeps the conversation's bearer as
// an http server's header would (turn-mounts.ts): between turns that bearer reaches nothing.
//
// Kept as source text, the pi-extension.ts precedent: it runs in a process the agent starts, on the daemon's own node,
// importing only Node's own modules.

export const PROXY_URL_ENV = "INTENTIC_MCP_URL";
export const PROXY_BEARER_ENV = "INTENTIC_MCP_BEARER";

export const ACP_MCP_PROXY_SOURCE = [
    `// managed by intentic: the daemon's stdio-to-HTTP MCP proxy for ACP agents (src/runtimes/acp/acp-mcp-proxy.ts).`,
    `import { createInterface } from "node:readline";`,
    ``,
    `const url = process.env.${PROXY_URL_ENV};`,
    `const bearer = process.env.${PROXY_BEARER_ENV};`,
    `if (!url) {`,
    `    process.stderr.write("intentic mcp proxy: no ${PROXY_URL_ENV} to forward to\\n");`,
    `    process.exit(2);`,
    `}`,
    ``,
    `// Replayed on every request once the door names them, as a Streamable HTTP client does.`,
    `let session;`,
    `let version;`,
    ``,
    `const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");`,
    ``,
    `// A request the door could not answer still gets an answer, so the agent's call fails rather than hangs.`,
    `const fail = (id, message) => {`,
    `    if (id !== undefined && id !== null) {`,
    `        write({ jsonrpc: "2.0", id, error: { code: -32603, message } });`,
    `    }`,
    `};`,
    ``,
    `const relay = (payload) => {`,
    `    for (const message of Array.isArray(payload) ? payload : [payload]) {`,
    `        const negotiated = message && message.result && message.result.protocolVersion;`,
    `        if (typeof negotiated === "string" && negotiated !== "") {`,
    `            version = negotiated;`,
    `        }`,
    `        write(message);`,
    `    }`,
    `};`,
    ``,
    `// Each SSE event's data lines, joined, as they arrive.`,
    `async function* events(body) {`,
    `    const decoder = new TextDecoder();`,
    `    let buffered = "";`,
    `    for await (const chunk of body) {`,
    `        buffered += decoder.decode(chunk, { stream: true });`,
    `        let end = buffered.search(/\\r?\\n\\r?\\n/);`,
    `        while (end !== -1) {`,
    `            const event = buffered.slice(0, end);`,
    `            buffered = buffered.slice(end).replace(/^(?:\\r?\\n){2}/, "");`,
    `            const data = event`,
    `                .split(/\\r?\\n/)`,
    `                .filter((line) => line.startsWith("data:"))`,
    `                .map((line) => line.slice(5).trimStart())`,
    `                .join("\\n");`,
    `            if (data !== "") {`,
    `                yield data;`,
    `            }`,
    `            end = buffered.search(/\\r?\\n\\r?\\n/);`,
    `        }`,
    `    }`,
    `}`,
    ``,
    `const forward = async (line, id) => {`,
    `    let response;`,
    `    try {`,
    `        response = await fetch(url, {`,
    `            method: "POST",`,
    `            headers: {`,
    `                "content-type": "application/json",`,
    `                accept: "application/json, text/event-stream",`,
    `                ...(bearer ? { authorization: "Bearer " + bearer } : {}),`,
    `                ...(session ? { "mcp-session-id": session } : {}),`,
    `                ...(version ? { "mcp-protocol-version": version } : {}),`,
    `            },`,
    `            body: line,`,
    `        });`,
    `    } catch (error) {`,
    `        fail(id, "The sandbox's MCP door could not be reached: " + String(error && error.message ? error.message : error));`,
    `        return;`,
    `    }`,
    `    session = response.headers.get("mcp-session-id") ?? session;`,
    `    if (!response.ok) {`,
    `        await response.body?.cancel().catch(`,
    `            // allow(silent-catch): the body is being thrown away; a stream that will not cancel has nothing left to say`,
    `            () => {},`,
    `        );`,
    `        fail(id, "The sandbox's MCP door answered HTTP " + response.status + ".");`,
    `        return;`,
    `    }`,
    `    if (response.status === 202 || response.status === 204) {`,
    `        await response.body?.cancel().catch(`,
    `            // allow(silent-catch): the body is being thrown away; a stream that will not cancel has nothing left to say`,
    `            () => {},`,
    `        );`,
    `        return;`,
    `    }`,
    `    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {`,
    `        if (response.body) {`,
    `            for await (const data of events(response.body)) {`,
    `                relay(JSON.parse(data));`,
    `            }`,
    `        }`,
    `        return;`,
    `    }`,
    `    const text = await response.text();`,
    `    if (text.trim() !== "") {`,
    `        relay(JSON.parse(text));`,
    `    }`,
    `};`,
    ``,
    `const pending = new Set();`,
    `const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });`,
    `lines.on("line", (line) => {`,
    `    if (line.trim() === "") {`,
    `        return;`,
    `    }`,
    `    let id;`,
    `    try {`,
    `        id = JSON.parse(line).id;`,
    `    } catch {`,
    `        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });`,
    `        return;`,
    `    }`,
    `    const call = forward(line, id)`,
    `        .catch((error) => fail(id, String(error && error.message ? error.message : error)))`,
    `        .finally(() => pending.delete(call));`,
    `    pending.add(call);`,
    `});`,
    `// The agent closing stdin is the end of the server: what is in flight still answers first.`,
    `lines.on("close", () => {`,
    `    void Promise.allSettled([...pending]).then(() => process.exit(0));`,
    `});`,
    ``,
].join("\n");

// One directory per daemon, made on first use; the script is written again if something cleared it since.
let proxyDir: Promise<string> | undefined;

/** The proxy script on disk, written where only this daemon's user can change it. */
export const acpMcpProxyFile = async (): Promise<string> => {
    proxyDir ??= mkdtemp(join(tmpdir(), "intentic-acp-mcp-"));
    const file = join(await proxyDir, "mcp-proxy.mjs");
    const present = await access(file).then(
        () => true,
        () => false,
    );
    if (!present) {
        await writeFile(file, ACP_MCP_PROXY_SOURCE, { mode: 0o600 });
    }
    return file;
};

/** A door mount as the stdio server an agent without http MCP spawns: the proxy on the daemon's own node. */
export const stdioProxyServer = (tool: Pick<AgentTool, "name" | "url" | "token">, script: string, node: string = process.execPath): McpServer => ({
    name: tool.name,
    command: node,
    args: [script],
    env: [{ name: PROXY_URL_ENV, value: tool.url }, ...(tool.token === undefined ? [] : [{ name: PROXY_BEARER_ENV, value: tool.token }])],
});
