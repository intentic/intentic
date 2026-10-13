import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { AgentRequest, TurnHooks, TurnPolicy, TurnTools } from "../../agent/providers/agent-request.js";
import { TMUX_RUN_BIN } from "../../terminal/terminal-run.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import type { SecretAccess } from "../../secrets/secret-access.js";
import { memoryFleet } from "../../testing.js";
import { NO_TURN } from "../daemon-tools/policy-gate.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import { createPiHooks, piSessionKey, piToolName, UNREADABLE_CALL } from "./pi-hooks.js";

// The daemon's end of the Pi extension's hooks, asked as the extension asks: a JSON payload to an endpoint, the answer
// read back. The loop's half (gate, taint, stream, watchdog) is attached as pi-agent.ts attaches it.

const cards = parkedCards(memoryFleet().conversations);

const VALUE = "sk-live-0123456789abcdef";

const secrets: SecretAccess = {
    list: async () => [{ name: "STRIPE_KEY", value: VALUE, source: "env" }],
    used: () => {},
    release: async () => ({ ok: true }),
};

const request = (
    over: { readonly policy?: TurnPolicy; readonly tools?: TurnTools; readonly hooks?: Partial<TurnHooks> } = {},
): AgentRequest => ({
    execution: unstubbed("execution", {}),
    spec: { prompt: "p", cwd: "/w" },
    policy: over.policy ?? {},
    tools: over.tools ?? {},
    credential: { kind: "container" },
    hooks: { cards, ...over.hooks },
    signal: new AbortController().signal,
});

// Hooks with the loop attached, and the frames the turn's stream received.
const attached = (turnRequest: AgentRequest, options: { readonly tmux?: boolean; readonly sealedAtDoor?: readonly string[] } = {}) => {
    const hooks = createPiHooks(turnRequest, { tmux: options.tmux ?? false, sealedAtDoor: new Set(options.sealedAtDoor ?? []) });
    const { gate, taint } = vendorTurnGate(turnRequest);
    const frames: AgentEvent[] = [];
    hooks.attach({ gate, taint, push: (frame) => frames.push(frame), hold: () => () => {} });
    const ask = async (path: string, payload: unknown) => {
        const endpoint = hooks.endpoints[path];
        if (endpoint === undefined) {
            throw new Error(`no endpoint ${path}`);
        }
        // SAFETY: each payload here is a JSON literal the test wrote, as the extension posts.
        return endpoint.answer(payload as Parameters<typeof endpoint.answer>[0]);
    };
    return { hooks, frames, taint, ask };
};

test("Pi's built-in tools are read under the names the Claude Code loop gives them; anything else as it is", () => {
    expect(["bash", "read", "edit", "write", "grep", "find", "ls"].map(piToolName)).toEqual(["Bash", "Read", "Edit", "Write", "Grep", "Glob", "LS"]);
    expect(piToolName("mcp__ui__ask")).toBe("mcp__ui__ask");
    expect(piToolName("ask_user")).toBe("ask_user");
});

test("a session file's uuid names the panel's session", () => {
    expect(piSessionKey("/auth/pi/sessions/--work--/2026-10-12T10-00-00-000Z_0f1e2d3c-aaaa-bbbb.jsonl")).toBe("0f1e2d3c-aaaa-bbbb");
});

test("a call before the loop attached is refused, as is one the daemon cannot read", async () => {
    const hooks = createPiHooks(request(), { tmux: false, sealedAtDoor: new Set() });
    expect(await hooks.endpoints["/tool-call"]?.answer({ tool: "bash", input: { command: "ls" } })).toEqual({ block: true, reason: NO_TURN });
    expect(await hooks.endpoints["/tool-call"]?.answer(42)).toEqual({ block: true, reason: UNREADABLE_CALL });
    expect(hooks.endpoints["/tool-call"]?.unreadable).toEqual({ block: true, reason: UNREADABLE_CALL });
});

test("a call off the turn's tool list is refused under the name the list is written in; a listed one runs as it is", async () => {
    const { ask } = attached(request({ policy: { allowedTools: ["Read", "mcp__ui"] } }));
    const refused = await ask("/tool-call", { tool: "bash", input: { command: "ls" } });
    expect(refused["block"]).toBe(true);
    expect(String(refused["reason"])).toContain("Bash (ls) is not on this turn's tool list");
    expect(await ask("/tool-call", { tool: "read", input: { path: "a.ts" } })).toEqual({});
    expect(await ask("/tool-call", { tool: "mcp__ui__ask", input: { question: "Which?" } })).toEqual({});
});

test("a shell line's secret reference is resolved before it runs, the rules having read the reference", async () => {
    const { ask } = attached(request({ tools: { secrets } }));
    expect(await ask("/tool-call", { tool: "bash", input: { command: "curl -H {{secret:STRIPE_KEY}} x", timeout: 30 } })).toEqual({
        input: { command: `curl -H ${VALUE} x`, timeout: 30 },
    });
    const unknown = await ask("/tool-call", { tool: "bash", input: { command: "echo {{secret:NOPE}}" } });
    expect(unknown["block"]).toBe(true);
});

test("with the panel on, a shell line runs through tmux-run in the session's pane, and the panel is shown once", async () => {
    const { hooks, ask, frames } = attached(request(), { tmux: true });
    hooks.session("/s/2026-10-12T10-00-00-000Z_0f1e2d3c-aaaa.jsonl");
    const first = await ask("/tool-call", { tool: "bash", id: "call-1", input: { command: "npm test" } });
    const second = await ask("/tool-call", { tool: "bash", id: "call-2", input: { command: "npm run build" } });
    // SAFETY: a rewrite answers the input object the shell hook changed.
    const commands = [first, second].map((answer) => (answer["input"] as { command: string }).command);
    expect(commands.every((command) => command.startsWith(TMUX_RUN_BIN) && command.endsWith(" agent-0f1e2d3c"))).toBe(true);
    expect(frames).toEqual([{ kind: "terminal", session: "agent-0f1e2d3c" }]);
});

test("every stored value is masked to its reference in any tool's result, a file read's included", async () => {
    const { ask } = attached(request({ tools: { secrets } }));
    expect(await ask("/tool-result", { tool: "read", input: { path: "notes.md" }, content: [{ type: "text", text: `the key is ${VALUE}` }] })).toEqual({
        content: [{ type: "text", text: "the key is {{secret:STRIPE_KEY}}" }],
    });
    expect(await ask("/tool-result", { tool: "read", input: { path: "a.ts" }, content: [{ type: "text", text: "nothing here" }] })).toEqual({});
});

test("a result the daemon cannot read is withheld rather than shown as it came", async () => {
    const { ask } = attached(request({ tools: { secrets } }));
    const answer = await ask("/tool-result", { tool: "read" });
    expect(JSON.stringify(answer)).toContain("intentic withheld this tool's output");
});

test("outside content is sealed and marks the turn, unless the door already sealed its server", async () => {
    const { ask, taint } = attached(request(), { sealedAtDoor: ["accounts"] });
    const sealed = await ask("/tool-result", { tool: "mcp__web__fetch", input: {}, content: [{ type: "text", text: "a page" }] });
    expect(JSON.stringify(sealed)).toContain("a page");
    expect(sealed).not.toEqual({});
    expect(taint.tainted()).toBe(true);
    expect(await ask("/tool-result", { tool: "mcp__accounts__list", input: {}, content: [{ type: "text", text: "rows" }] })).toEqual({});
});

test("an edit's file goes to the owner's per-edit checks, named as Pi's cwd places it, and what they say rides the result", async () => {
    const reviewed: string[] = [];
    const { ask } = attached(
        request({
            hooks: {
                editReviewers: [
                    async (file, how) => {
                        reviewed.push(file);
                        return `lint found 1 problem in ${file} after ${how}`;
                    },
                ],
            },
        }),
    );
    expect(await ask("/tool-result", { tool: "edit", input: { path: "src/a.ts" }, content: [{ type: "text", text: "Edited" }], cwd: "/w/repo" })).toEqual({
        content: [
            { type: "text", text: "Edited" },
            { type: "text", text: "lint found 1 problem in /w/repo/src/a.ts after this edit" },
        ],
    });
    // A failed edit changed nothing, so nothing is checked.
    expect(await ask("/tool-result", { tool: "write", input: { path: "/w/b.ts" }, content: [{ type: "text", text: "denied" }], isError: true })).toEqual({});
    expect(reviewed).toEqual(["/w/repo/src/a.ts"]);
});

test("the extension's word that its hooks are in place settles `ready`", async () => {
    const hooks = createPiHooks(request(), { tmux: false, sealedAtDoor: new Set() });
    let ready = false;
    void hooks.ready.then(() => {
        ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    await hooks.endpoints["/ready"]?.answer({});
    await Promise.resolve();
    expect(ready).toBe(true);
});
