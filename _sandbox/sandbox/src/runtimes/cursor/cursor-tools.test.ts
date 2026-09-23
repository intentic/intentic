import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { openSpawnedChild, resetSubagents, settleSpawnedChild, type SubagentTurn } from "../../agent/subagents/subagents.js";
import type { AgentRequest, TurnHooks, TurnPolicy, TurnTools } from "../../agent/providers/agent-request.js";
import type { ChildSupervisor } from "../../agent/subagents/children.js";
import { waitForWork } from "../../agent/subagents/work-wait.js";
import { parkedCards } from "../../agents/actor/parked-cards.js";
import type { JsExecutionPlan } from "../../execution/js-runtime.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { createTurnTaint } from "../../guard/turn-taint.js";
import type { CursorGuard } from "./cursor-tools.js";
import { cursorCustomTools } from "./cursor-tools.js";
import { memoryFleet } from "../../testing.js";

// One fleet's actors, and the cards a turn here parks in them.
const actors = memoryFleet().conversations;
const cards = parkedCards(actors);

/* Which daemon tools a Cursor turn is handed, and what the pair actually does. */

const request = (
    over: {
        readonly policy?: Pick<TurnPolicy, "unattended">;
        readonly tools?: Pick<TurnTools, "jsExecution">;
        readonly hooks?: Pick<TurnHooks, "children">;
    } = {},
): AgentRequest => ({
    spec: { prompt: "do the thing", cwd: "/work", conversationId: "conv-cursor" },
    policy: { ...over.policy },
    tools: { ...over.tools },
    credential: { kind: "cursor-key", apiKey: "key" },
    hooks: { cards, ...over.hooks },
    signal: new AbortController().signal,
});

const push = (): ((event: AgentEvent) => void) => () => {};

const guard = (gate: CommandGuard): CursorGuard => ({ gate, taint: createTurnTaint() });

const allowing = (): CommandGuard => ({
    enforcing: true,
    // eslint-disable-next-line require-yield
    async *consult() {
        return { allow: true };
    },
});
const denying = (reason: string): CommandGuard => ({
    enforcing: true,
    // eslint-disable-next-line require-yield
    async *consult() {
        return { allow: false, reason };
    },
});

// In-memory only, so a script that reached the runtime would still write nothing; the tests below assert it never does.
const jsPlan = (): JsExecutionPlan => ({ cwd: WORKSPACE_ROOT, readRoots: [], writeRoots: [], allowSpawn: false, env: {} });

// Its wait is the engine's own, parked on this suite's roster for the request's conversation.
const supervisor = (over: Partial<ChildSupervisor> = {}): ChildSupervisor => ({
    spawn: async () => ({ ok: true, id: "sub-x" }),
    send: async () => ({ ok: true }),
    answer: async () => ({ ok: true }),
    providers: async () => [],
    pendingQuestion: () => undefined,
    wait: (options) => waitForWork(actors, "conv-cursor", options),
    ...over,
});

describe("which tools mount", () => {
    it("an attended turn with no engine gets the ask alone", () => {
        expect(Object.keys(cursorCustomTools(request(), guard(allowing()), push()))).toEqual(["ask"]);
    });

    it("an unattended turn with no engine gets nothing", () => {
        expect(Object.keys(cursorCustomTools(request({ policy: { unattended: true } }), guard(allowing()), push()))).toEqual([]);
    });

    /* `providers` rides with `spawn` and is never separated from it: the spawn door requires a provider and a model. */
    it("the engine brings the supervision set, and unattended keeps it: a child deadlocks nothing", () => {
        const children = supervisor();
        expect(Object.keys(cursorCustomTools(request({ hooks: { children } }), guard(allowing()), push()))).toEqual([
            "ask",
            "spawn",
            "providers",
            "wait",
            "send",
            "answer",
        ]);
        expect(Object.keys(cursorCustomTools(request({ hooks: { children }, policy: { unattended: true } }), guard(allowing()), push()))).toEqual([
            "spawn",
            "providers",
            "wait",
            "send",
            "answer",
        ]);
    });

    // jsExecutionPlanOf answers undefined where the persona's card withheld the backend, so the tool is absent rather
    // than present-and-refused.
    it("the JS backend mounts only where the turn was planned with one", () => {
        expect(Object.keys(cursorCustomTools(request({ tools: { jsExecution: jsPlan() } }), guard(allowing()), push()))).toEqual(["ask", "code"]);
        expect(Object.keys(cursorCustomTools(request(), guard(allowing()), push()))).not.toContain("code");
    });
});

/* The rulebook reaches a script here or nowhere: Cursor's hook file only covers the shell, so a custom tool that
   skipped this consult would run code the owner's rules never saw. */

describe("the JS backend's gate", () => {
    it("a refused script comes back as the refusal, and is never run", async () => {
        const tools = cursorCustomTools(request({ tools: { jsExecution: jsPlan() } }), guard(denying("Network calls need your approval.")), push());
        const answer = await tools["code"]?.execute?.({ code: "await fetch('https://example.com')" }, {} as never);
        expect(answer).toBe("Network calls need your approval.");
    });

    it("the script the gate is asked about is the script the model wrote, verbatim", async () => {
        const asked: string[] = [];
        const watching: CommandGuard = {
            enforcing: true,
            // eslint-disable-next-line require-yield
            async *consult(program) {
                asked.push(program);
                return { allow: false, reason: "no" };
            },
        };
        const tools = cursorCustomTools(request({ tools: { jsExecution: jsPlan() } }), guard(watching), push());
        await tools["code"]?.execute?.({ code: "console.log(1)" }, {} as never);
        expect(asked).toEqual(["console.log(1)"]);
    });

    // Cursor's afterShellExecution reply is discarded upstream, so the envelope has to go on here or nowhere. A script
    // that reached the network brought back a stranger's words, and the judge is told so.
    it("a script that fetched comes back wrapped, and the turn is marked", async () => {
        const taint = createTurnTaint();
        const tools = cursorCustomTools(request({ tools: { jsExecution: jsPlan() } }), { gate: allowing(), taint }, push());
        // `.invalid` is reserved and never resolves, so the classifier sees a fetch while the suite dials nobody.
        const answer = (await tools["code"]?.execute?.(
            { code: "const r = await fetch('https://example.invalid'); console.log(await r.text());" },
            {} as never,
        )) as string;
        expect(answer).toContain("untrusted-content");
        expect(taint.tainted()).toBe(true);
        expect(taint.source()).toBe("code-fetch");
    });

    it("a script that stayed inside the container comes back bare, and marks nothing", async () => {
        const taint = createTurnTaint();
        const tools = cursorCustomTools(request({ tools: { jsExecution: jsPlan() } }), { gate: allowing(), taint }, push());
        const answer = (await tools["code"]?.execute?.({ code: "console.log(2 + 2)" }, {} as never)) as string;
        expect(answer).not.toContain("untrusted-content");
        expect(taint.tainted()).toBe(false);
    });

    it("an empty script is answered without troubling the gate", async () => {
        let consulted = 0;
        const counting: CommandGuard = {
            enforcing: true,
            // eslint-disable-next-line require-yield
            async *consult() {
                consulted += 1;
                return { allow: true };
            },
        };
        const tools = cursorCustomTools(request({ tools: { jsExecution: jsPlan() } }), guard(counting), push());
        expect(await tools["code"]?.execute?.({}, {} as never)).toContain("nothing ran");
        expect(consulted).toBe(0);
    });
});

describe("what the pair does", () => {
    it("spawn relays the spec and answers with the child's id and the wait to follow it with", async () => {
        const specs: unknown[] = [];
        const children = supervisor({
            spawn: async (spec) => {
                specs.push(spec);
                return { ok: true, id: "sub-brave-otter-a1b2" };
            },
        });
        const tools = cursorCustomTools(request({ hooks: { children } }), guard(allowing()), push());
        const answer = JSON.parse(
            (await tools["spawn"]?.execute?.({ prompt: "port the parser", provider: "cursor", model: "composer-2.5" }, {} as never)) as string,
        ) as { ok: boolean; child: string; note: string };
        expect(specs).toEqual([{ prompt: "port the parser", provider: "cursor", model: "composer-2.5" }]);
        expect(answer.ok).toBe(true);
        expect(answer.child).toBe("sub-brave-otter-a1b2");
        expect(answer.note).toContain("wait");
    });

    it("spawn without a prompt refuses without calling the engine", async () => {
        let called = 0;
        const children = supervisor({
            spawn: async () => {
                called += 1;
                return { ok: true, id: "sub-x" };
            },
        });
        const tools = cursorCustomTools(request({ hooks: { children } }), guard(allowing()), push());
        const answer = JSON.parse((await tools["spawn"]?.execute?.({}, {} as never)) as string) as { ok: boolean };
        expect(answer.ok).toBe(false);
        expect(called).toBe(0);
    });

    it("wait parks on the same roster the harness tool reads, and returns the settled child", async () => {
        resetSubagents(actors);
        const turn: SubagentTurn = {
            conversationId: "conv-cursor",
            conversations: actors,
            cwd: "/work",
            sessionId: undefined,
            subagentsDir: undefined,
        };
        openSpawnedChild(turn, { id: "sub-child-1", description: "port it", provider: "claude" });
        const tools = cursorCustomTools(request({ hooks: { children: supervisor() } }), guard(allowing()), push());
        const parked = tools["wait"]?.execute?.({ target: "sub-child-1", timeoutSeconds: 5 }, {} as never) as Promise<string>;
        settleSpawnedChild(actors, "sub-child-1", { failed: false, report: "done: two files changed" });
        const answer = JSON.parse(await parked) as { outcome: string; agent?: { summary?: string } };
        expect(answer.outcome).toBe("finished");
        expect(answer.agent?.summary).toBe("done: two files changed");
    });
});
