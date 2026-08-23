import { createServer, type Server } from "node:http";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { type CommandGate, consultWith, vendorSubject } from "../guard/command-gate.js";

/* THE OWNER'S COMMAND RULEBOOK, ENFORCED INSIDE CURSOR'S OWN LOOP. This is what earns the `rulebook: "hooks"`
 * row in the capability record, and it is the only foreign runtime in this repo that reaches that tier.
 *
 * Cursor runs a `beforeShellExecution` hook before every command its shell tool executes, and takes back
 * `{ permission: "allow" | "deny", user_message, agent_message }`. That alone would be worth the weaker
 * "approval" tier. What makes it the full one is that the hook is a PROCESS WE WROTE: it can sit there, not
 * answering, while a permission card waits on a person, and Cursor is simply blocked on a script it started.
 * A vendor approval channel with a clock on it (OpenCode's) cannot do that, which is why that one is
 * "refuse-only" and this is not.
 *
 * THE SHAPE, and why it is a socket rather than a spool. The codex signal hook writes JSON files into a
 * directory because it is telling the daemon something; this one has to ASK and wait for the answer, so it
 * needs a round trip. A Unix domain socket under the auth root gives that with no port, no route on the
 * daemon's public contract, and filesystem permissions as the whole access-control story.
 *
 * ONE SOCKET FOR THE DAEMON'S LIFE, not one per turn, because the hooks file that names it is machine-global
 * (see below) and a static file cannot name a per-turn path. Turns register themselves against it and the
 * payload's `conversation_id` routes each consult back to the right one.
 *
 * WHY /etc/cursor, which is the ENTERPRISE layer. Cursor reads hooks from four places: /etc/cursor/hooks.json
 * (enterprise), ~/.cursor/hooks.json (user), the workspace's own .cursor/hooks.json (project), and — worth
 * knowing — ~/.claude/settings.json, whose Claude Code hooks it also honours. The enterprise layer is the
 * right one and the other three are each wrong in their own way: the project file belongs to the user's
 * repository and writing to it would show up in their diff; the user file is theirs; and the Claude one is
 * written by this daemon for a different runtime, whose hook scripts speak Claude Code's protocol and would
 * be handed Cursor's. So the turn asks for `settingSources: ["mdm", "project"]` and this file is the "mdm". */

/* Where Cursor looks for the machine-wide hooks file on Linux, from its own path table. Not configurable by
 * CURSOR, which is most of why the enterprise layer is the right one to own: it is a fixed location no
 * workspace and no user can move.
 *
 * The env override exists for the suite rather than for production, and the reason is the ambient-machine trap
 * AGENTS.md names: a test that really wrote /etc/cursor/hooks.json would assert one thing on a runner where
 * /etc is unwritable and the opposite inside a root container, and it would leave a machine-global file behind
 * either way. Pointing it at a temp dir is what lets the suite state the mode it means. */
const enterpriseHooksPath = (): string => process.env["INTENTIC_CURSOR_HOOKS_FILE"] ?? "/etc/cursor/hooks.json";
const GATE_SCRIPT_NAME = "intentic-command-gate.mjs";

/* One live turn's gate. Registered for as long as the turn runs, looked up by whichever id the hook payload
 * carries. `push` is the turn's own event sink, so the permission card lands in the conversation that raised
 * it rather than anywhere else. */
export interface CursorGateTurn {
    // Cursor's id for the agent this turn is running on, the correlation key the payload carries back.
    readonly conversationId: string;
    readonly gate: CommandGate;
    readonly push: (event: AgentEvent) => void;
}

export interface CursorHookService {
    // Open the socket and write the hooks file + gate script. Idempotent; called once at boot.
    readonly start: () => Promise<void>;
    // Register a live turn, and the function that retires it. Always retire in a `finally`: a turn left
    // registered would keep answering for an agent id that is no longer running.
    readonly register: (turn: CursorGateTurn) => () => void;
    // Whether the gate is actually wired, so a turn can say honestly whether its rules are in force.
    readonly ready: () => boolean;
    readonly close: () => Promise<void>;
}

/* The hook itself. Node rather than a shell script, for one reason that decides it: this has to speak HTTP
 * over a Unix socket and read a JSON body back, and `node` is the one interpreter guaranteed to be in the
 * image (the daemon is running on it), where `curl` is a build-time tool that need not survive into the
 * runtime layer.
 *
 * FAILS OPEN, ON PURPOSE, and every path that can fail does so silently. This hook fires for every command
 * Cursor runs anywhere on the machine, including a `cursor-agent` the owner started by hand in their own
 * terminal — which is the owner acting directly, not an agent acting for them, and is exactly the case the
 * daemon has no turn registered for. Blocking those would make the sandbox's own agent policy break the
 * owner's manual work. A deny only ever comes from the daemon actually saying deny.
 *
 * `failClosed` in the hooks entry still guards the case this cannot: the script itself being unrunnable. */
const gateScript = (socketPath: string): string =>
    [
        `// managed by intentic: overwritten on daemon boot (src/cursor/cursor-hooks.ts).`,
        `// Asks the daemon whether a command Cursor is about to run passes the owner's command rules`,
        `// (src/guard/command-gate.ts). Answers "allow" for anything it cannot ask about, so a hand-run`,
        `// cursor-agent is never blocked by a sandbox that has no turn for it.`,
        `import { request } from "node:http";`,
        ``,
        `const allow = () => { process.stdout.write(JSON.stringify({ permission: "allow" })); process.exit(0); };`,
        `const chunks = [];`,
        `process.stdin.on("data", (chunk) => chunks.push(chunk));`,
        `process.stdin.on("error", allow);`,
        `process.stdin.on("end", () => {`,
        `    const body = Buffer.concat(chunks);`,
        `    if (body.length === 0) { allow(); return; }`,
        `    const call = request(`,
        `        { socketPath: ${JSON.stringify(socketPath)}, path: "/gate", method: "POST", headers: { "content-type": "application/json" } },`,
        `        (response) => {`,
        `            const parts = [];`,
        `            response.on("data", (part) => parts.push(part));`,
        `            response.on("error", allow);`,
        `            response.on("end", () => {`,
        `                const text = Buffer.concat(parts).toString("utf8");`,
        `                // Anything but a well-formed verdict is treated as no answer at all.`,
        `                try { JSON.parse(text); } catch { allow(); return; }`,
        `                process.stdout.write(text);`,
        `                process.exit(0);`,
        `            });`,
        `        },`,
        `    );`,
        `    call.on("error", allow);`,
        `    call.end(body);`,
        `});`,
        ``,
    ].join("\n");

/* The hooks file. Only `beforeShellExecution` is wired, and the omissions are deliberate rather than pending.
 *
 * `beforeMCPExecution` would gate the MCP tools, but those are the daemon's OWN servers on this runtime (the
 * browser stack and the host callbacks it registers), already fenced where they are built, so gating them here
 * would be asking the owner about a call the daemon made on their behalf. `beforeReadFile` and `afterFileEdit`
 * belong to a file-access policy this repo does not have, and wiring a hook with nothing behind it costs a
 * process per file read. `afterShellExecution` is the one that looks useful and is not: its return value is
 * discarded upstream, which is exactly why the `secrets` axis reads "none" for this runtime.
 *
 * `failClosed` because this is a security gate and the script above already handles every case where allowing
 * is right. What is left for it to catch is the script being unrunnable at all, and a sandbox whose gate
 * cannot start should not be running unreviewed commands. */
const hooksJson = (scriptPath: string): string =>
    `${JSON.stringify(
        {
            version: 1,
            hooks: {
                beforeShellExecution: [{ command: `node ${JSON.stringify(scriptPath)}`, failClosed: true }],
            },
        },
        undefined,
        4,
    )}\n`;

// What Cursor sends the hook. Only the three fields this reads are named; the payload carries more (model,
// generation_id, workspace roots) and none of it changes the verdict.
interface GateRequest {
    readonly command?: unknown;
    readonly conversation_id?: unknown;
    readonly cwd?: unknown;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export const createCursorHookService = (socketDir: string, logger: Logger): CursorHookService => {
    const socketPath = join(socketDir, "command-gate.sock");
    const scriptPath = join(socketDir, GATE_SCRIPT_NAME);
    const turns = new Map<string, CursorGateTurn>();
    let server: Server | undefined;

    /* WHICH TURN IS ASKING. The id is the honest answer and the fallback is not a guess dressed up as one:
     * when the daemon has exactly one Cursor turn running, a consult that arrives unlabelled can only have
     * come from it, and answering it correctly is better than waving it through. Two or more running, and
     * there is nothing to reason from, so it goes through the allow path with a line in the log — a wrong
     * card, shown to the wrong conversation, is worse than an unenforced command that gets logged. */
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
        // `enforcing` is the same short-circuit every vendor-gated runtime takes: a workspace with no rules and
        // no taint pays nothing, not even the classification.
        if (!turn.gate.enforcing) {
            return { permission: "allow" };
        }
        // Named for Cursor's own tool so the card, the transcript entry and the runtime agree on what ran.
        const outcome = await consultWith(turn.gate, command, vendorSubject("Shell"), turn.push);
        if (outcome.allow) {
            return { permission: "allow" };
        }
        // Both messages, and deliberately the same sentence: `agent_message` is what the model is told so it
        // can choose something else, `user_message` is what the person sees. Splitting them would mean writing
        // the refusal twice, and the gate already phrases it for a reader.
        return { permission: "deny", agent_message: outcome.reason, user_message: outcome.reason };
    };

    return {
        start: async () => {
            if (server !== undefined) {
                return;
            }
            await mkdir(socketDir, { recursive: true });
            // A socket left behind by a daemon that did not shut down cleanly would make listen() fail with
            // EADDRINUSE forever. Nothing else owns this path, so removing it is safe and is the only way the
            // gate comes back after a hard kill.
            await rm(socketPath, { force: true });
            const created = createServer((request, response) => {
                if (request.method !== "POST") {
                    response.writeHead(405).end();
                    return;
                }
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                    void (async () => {
                        let payload: GateRequest;
                        try {
                            payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as GateRequest;
                        } catch {
                            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ permission: "allow" }));
                            return;
                        }
                        // A gate that throws must not leave Cursor waiting on a socket forever: the script's own
                        // timeout would eventually fire, but the turn would have stalled for it. Answering
                        // `allow` on an internal error matches the guard's own "never be the reason a turn
                        // breaks" posture for this transport.
                        const verdict = await verdictFor(payload).catch((error: unknown) => {
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
            // Owner-only: the socket IS the authority to answer a permission card, so anything that can write
            // to it can allow a command the owner's rules would have denied.
            await chmod(socketPath, 0o600);
            server = created;

            await writeFile(scriptPath, gateScript(socketPath), { mode: 0o755 });
            // The one write outside the sandbox's own state tree, and the reason is in the header: this path is
            // Cursor's fixed enterprise layer and is not configurable. Best-effort, because a container without
            // write access to /etc is a real deployment and the right answer there is a turn that says its
            // rules are unenforced, not a daemon that refuses to boot.
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
