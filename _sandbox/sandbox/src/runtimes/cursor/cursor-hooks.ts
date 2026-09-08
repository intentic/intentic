import { createServer, type Server } from "node:http";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { type CommandGate, consultWith, vendorSubject } from "../../guard/command-gate.js";

// Owner's command rulebook enforced inside Cursor's own loop via beforeShellExecution: the hook is a process this
// daemon wrote, so it can hold the answer while a card waits on a person, unlike a clocked vendor approval channel.
// Lives at /etc/cursor/hooks.json, the enterprise layer, not ~/.cursor or the workspace's own.

// Fixed by Cursor, not configurable; the one location no workspace or user can move. The env override is test-only: it
// points the suite at a temp dir instead of writing a real machine-global file.
const enterpriseHooksPath = (): string => process.env["INTENTIC_CURSOR_HOOKS_FILE"] ?? "/etc/cursor/hooks.json";
const GATE_SCRIPT_NAME = "intentic-command-gate.mjs";

// One live turn's hook context, registered for as long as the turn runs and looked up by the payload's id. `push` is
// this turn's own event sink, so a permission card lands in the right conversation.
export interface CursorGateTurn {
    // Cursor's id for this turn's agent; the correlation key the hook payload carries back.
    readonly conversationId: string;
    // Capability credentials and persona values for this turn, never the daemon's ambient env.
    readonly cliEnv?: Record<string, string>;
    readonly gate: CommandGate;
    readonly push: (event: AgentEvent) => void;
}

export interface CursorHookService {
    // Opens the socket and writes the hooks file and gate script; idempotent, called once at boot.
    readonly start: () => Promise<void>;
    // Registers a live turn and returns its retire function; always call retire in a finally, or a gone turn keeps
    // answering.
    readonly register: (turn: CursorGateTurn) => () => void;
    // Whether the gate is actually wired, so a turn can report honestly whether its rules are enforced.
    readonly ready: () => boolean;
    // The socket, the script naming it, and the hooks file naming the script: the three links invariant.ts re-reads,
    // since another daemon can overwrite any of them after ready.
    readonly paths: () => { readonly socket: string; readonly script: string; readonly hooks: string };
    readonly close: () => Promise<void>;
}

// Node, not a shell script: it speaks HTTP over a Unix socket, and node, unlike curl, is guaranteed to be in the image.
// Every failure path answers allow silently, since an unregistered call is usually the owner's own manual run.
const gateScript = (socketPath: string): string =>
    [
        `// managed by intentic: overwritten on daemon boot (src/cursor/cursor-hooks.ts).`,
        `// Asks the daemon for either the current turn's environment or a command-gate verdict.`,
        `// Missing session environment is always empty; a missing gate verdict is always allow.`,
        `import { request } from "node:http";`,
        ``,
        `const mode = process.argv[2] === "session-env" ? "session-env" : "gate";`,
        `const fallback = () => {`,
        `    process.stdout.write(JSON.stringify(mode === "session-env" ? {} : { permission: "allow" }));`,
        `    process.exit(0);`,
        `};`,
        `const chunks = [];`,
        `process.stdin.on("data", (chunk) => chunks.push(chunk));`,
        `process.stdin.on("error", fallback);`,
        `process.stdin.on("end", () => {`,
        `    const body = Buffer.concat(chunks);`,
        `    if (body.length === 0) { fallback(); return; }`,
        `    const call = request(`,
        `        {`,
        `            socketPath: ${JSON.stringify(socketPath)},`,
        `            path: mode === "session-env" ? "/session-env" : "/gate",`,
        `            method: "POST",`,
        `            headers: { "content-type": "application/json" },`,
        `        },`,
        `        (response) => {`,
        `            const parts = [];`,
        `            response.on("data", (part) => parts.push(part));`,
        `            response.on("error", fallback);`,
        `            response.on("end", () => {`,
        `                const text = Buffer.concat(parts).toString("utf8");`,
        `                // Anything but a well-formed answer is treated as no answer at all.`,
        `                try { JSON.parse(text); } catch { fallback(); return; }`,
        `                process.stdout.write(text);`,
        `                process.exit(0);`,
        `            });`,
        `        },`,
        `    );`,
        `    call.on("error", fallback);`,
        `    call.end(body);`,
        `});`,
        ``,
    ].join("\n");

// sessionStart projects the turn's env; beforeShellExecution enforces the rulebook. afterShellExecution is skipped, its
// return value is discarded upstream, which is why the secrets axis reads "none" here.
const hooksJson = (scriptPath: string): string =>
    `${JSON.stringify(
        {
            version: 1,
            hooks: {
                sessionStart: [{ command: `node ${JSON.stringify(scriptPath)} session-env`, failClosed: false }],
                beforeShellExecution: [{ command: `node ${JSON.stringify(scriptPath)} gate`, failClosed: true }],
            },
        },
        undefined,
        4,
    )}\n`;

// Only the three fields this reads are named; the payload carries more (model, generation_id, workspace roots) and none
// of it changes the verdict.
interface GateRequest {
    readonly command?: unknown;
    readonly conversation_id?: unknown;
    readonly cwd?: unknown;
}

interface SessionStartRequest {
    readonly conversation_id?: unknown;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export const createCursorHookService = (socketDir: string, logger: Logger): CursorHookService => {
    const socketPath = join(socketDir, "command-gate.sock");
    const scriptPath = join(socketDir, GATE_SCRIPT_NAME);
    const turns = new Map<string, CursorGateTurn>();
    let server: Server | undefined;

    // With exactly one live turn, an unlabelled consult can only be from it. With two or more, there's nothing to
    // reason from, so it allows and logs: a wrong card in the wrong conversation is worse than an unenforced, logged
    // command.
    const turnFor = (conversationId: string | undefined): CursorGateTurn | undefined => {
        if (conversationId !== undefined) {
            const exact = turns.get(conversationId);
            if (exact !== undefined) {
                return exact;
            }
        }
        if (turns.size === 1) {
            return [...turns.values()][0];
        }
        if (turns.size > 1) {
            logger.warn({ conversationId, live: turns.size }, "cursor: command gate could not tell which turn is asking, allowing");
        }
        return undefined;
    };

    const verdictFor = async (payload: GateRequest): Promise<{ permission: "allow" | "deny"; agent_message?: string; user_message?: string }> => {
        const command = asString(payload.command);
        const turn = turnFor(asString(payload.conversation_id));
        if (command === undefined || turn === undefined) {
            return { permission: "allow" };
        }
        // Same short-circuit other vendor-gated runtimes take: no rules or taint costs nothing, not even classifying.
        if (!turn.gate.enforcing) {
            return { permission: "allow" };
        }
        // Named for Cursor's own tool, so the card, transcript and runtime all agree on what ran.
        const outcome = await consultWith(turn.gate, command, vendorSubject("Shell"), turn.push);
        if (outcome.allow) {
            return { permission: "allow" };
        }
        // Same sentence for both fields: the gate already phrases the refusal; splitting would mean writing it twice.
        return { permission: "deny", agent_message: outcome.reason, user_message: outcome.reason };
    };

    // Never uses the gate's single-live-turn fallback: a sessionStart hook can come from an owner's own hand-run Cursor
    // process, and handing it a turn's environment would cross the capability boundary. No exact id, no environment.
    const environmentFor = (payload: SessionStartRequest): { env: Record<string, string> } => {
        const conversationId = asString(payload.conversation_id);
        if (conversationId === undefined) {
            return { env: {} };
        }
        return { env: turns.get(conversationId)?.cliEnv ?? {} };
    };

    return {
        start: async () => {
            if (server !== undefined) {
                return;
            }
            await mkdir(socketDir, { recursive: true });
            // An unclean shutdown can leave the socket behind, failing listen() forever; nothing else owns this path.
            await rm(socketPath, { force: true });
            const created = createServer((request, response) => {
                // Lets invariant.ts's probe tell this daemon's socket from one a second daemon has since re-bound.
                if (request.url === "/identity") {
                    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pid: process.pid }));
                    return;
                }
                if (request.method !== "POST" || (request.url !== "/gate" && request.url !== "/session-env")) {
                    response.writeHead(405).end();
                    return;
                }
                const sessionEnvironment = request.url === "/session-env";
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                    void (async () => {
                        let payload: GateRequest | SessionStartRequest;
                        try {
                            payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as GateRequest | SessionStartRequest;
                        } catch {
                            const fallback = sessionEnvironment ? {} : { permission: "allow" };
                            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(fallback));
                            return;
                        }
                        if (sessionEnvironment) {
                            response
                                .writeHead(200, { "content-type": "application/json" })
                                .end(JSON.stringify(environmentFor(payload as SessionStartRequest)));
                            return;
                        }
                        // Answers allow on error, rather than stall the turn for the script's own timeout.
                        const verdict = await verdictFor(payload as GateRequest).catch((error: unknown) => {
                            logger.error({ err: error }, "cursor: command gate failed, allowing the command");
                            return { permission: "allow" as const };
                        });
                        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(verdict));
                    })();
                });
            });
            await new Promise<void>((settle, fail) => {
                created.once("error", fail);
                created.listen(socketPath, () => {
                    created.removeListener("error", fail);
                    settle();
                });
            });
            // Owner-only: anything that can write to this socket can allow a command the owner's rules would deny.
            await chmod(socketPath, 0o600);
            server = created;

            await writeFile(scriptPath, gateScript(socketPath), { mode: 0o755 });
            // Best-effort: a container without /etc access is real; answer is unenforced rules, not refusing to boot.
            const hooksPath = enterpriseHooksPath();
            await mkdir(dirname(hooksPath), { recursive: true })
                .then(() => writeFile(hooksPath, hooksJson(scriptPath), { mode: 0o644 }))
                .catch((error: unknown) => {
                    logger.warn({ err: error, path: hooksPath }, "cursor: could not install the command-gate hook, rules will not apply");
                });
        },
        register: (turn) => {
            turns.set(turn.conversationId, turn);
            return () => {
                turns.delete(turn.conversationId);
            };
        },
        ready: () => server !== undefined,
        paths: () => ({ socket: socketPath, script: scriptPath, hooks: enterpriseHooksPath() }),
        close: async () => {
            const running = server;
            server = undefined;
            turns.clear();
            if (running !== undefined) {
                await new Promise<void>((settle) => running.close(() => settle()));
            }
            await rm(socketPath, { force: true });
        },
    };
};
