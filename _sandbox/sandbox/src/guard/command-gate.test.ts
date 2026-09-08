import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import {
    type AgentEvent,
    COMMAND_CLASS_LABELS,
    DEFAULT_SAFETY_POLICY,
    type SafetyLogEntry,
    type SafetyVerdict,
    WORKSPACE_ROOT,
} from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { resolveRequest } from "../agent/tools/agent-requests.js";
import type { JudgeFacts } from "../agent/tools/command-judge.js";
import { JS_TOOL_NAME } from "../execution/js-tool.js";
import { commandGateHooks, type CommandGateOptions } from "./command-gate.js";
import { createTurnTaint, NO_TAINT } from "./turn-taint.js";

const FORCE_PUSH = "git push --force origin main";

// A judge that always answers the same way, so tests cover the gate's pipeline, not model accuracy.
const always =
    (decision: SafetyVerdict["decision"], sentence = `It does the thing.`, policyLine?: string): CommandGateOptions["judge"] =>
    async () => ({ decision, sentence, ...(policyLine === undefined ? {} : { policyLine }) });

interface Harness {
    readonly run: (command: unknown) => Promise<SyncHookJSONOutput>;
    // Second source: a JS run, with the script passed as tool_input.code.
    readonly runCode: (code: unknown) => Promise<SyncHookJSONOutput>;
    readonly events: AgentEvent[];
    // Everything the gate wrote to the safety log, in order, including verdicts nobody saw.
    readonly logged: SafetyLogEntry[];
    // Every set of facts the judge was handed.
    readonly seen: { program: string; facts: JudgeFacts }[];
    // Lines accepted on a card and appended to the owner's policy.
    readonly remembered: string[];
    readonly abort: () => void;
}

// Drives the PreToolUse hooks like the SDK: one Bash call, or one JS run with the script. Built once per
// harness, so a per-turn grant and the judge's memo carry across both sources.
const harness = (options: Partial<CommandGateOptions> = {}): Harness => {
    const events: AgentEvent[] = [];
    const logged: SafetyLogEntry[] = [];
    const seen: { program: string; facts: JudgeFacts }[] = [];
    const remembered: string[] = [];
    const controller = new AbortController();
    const judge = options.judge;
    const matchers = commandGateHooks({
        policy: DEFAULT_SAFETY_POLICY,
        // Default setting; other `judging` values are covered in their own describe blocks below.
        judging: "on",
        unattended: false,
        push: (event) => events.push(event),
        signal: controller.signal,
        // Default: an untainted, ordinary turn.
        taint: NO_TAINT,
        log: (entry) => logged.push(entry),
        answered: (at, answer, outcome) => {
            const entry = logged.find((row) => row.at === at);
            if (entry !== undefined) {
                Object.assign(entry, { answer, outcome });
            }
        },
        remember: async (line) => {
            remembered.push(line);
        },
        ...options,
        // Wraps rather than replaces `judge`, so every test records facts without opting in.
        ...(judge === undefined
            ? {}
            : {
                  judge: (program, facts, signal) => {
                      seen.push({ program, facts });
                      return judge(program, facts, signal);
                  },
              }),
    }).PreToolUse;
    const hookFor = (toolName: string): ((input: unknown, id: undefined, context: { signal: AbortSignal }) => Promise<unknown>) => {
        const hook = matchers?.find((matcher) => matcher.matcher === toolName)?.hooks[0];
        if (hook === undefined) {
            throw new Error(`gate wired no PreToolUse hook for ${toolName}`);
        }
        return hook as unknown as (input: unknown, id: undefined, context: { signal: AbortSignal }) => Promise<unknown>;
    };
    return {
        events,
        logged,
        seen,
        remembered,
        abort: () => controller.abort(),
        run: (command) =>
            hookFor("Bash")({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, undefined, {
                signal: controller.signal,
            }) as Promise<SyncHookJSONOutput>,
        runCode: (code) =>
            hookFor(JS_TOOL_NAME)({ hook_event_name: "PreToolUse", tool_name: JS_TOOL_NAME, tool_input: { code } }, undefined, {
                signal: controller.signal,
            }) as Promise<SyncHookJSONOutput>,
    };
};

const reasonOf = (out: SyncHookJSONOutput): string =>
    (out.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason ?? "";

// The card the gate raised, once the hook has parked on it.
const cardOf = (events: readonly AgentEvent[]): Extract<AgentEvent, { kind: "permission" }> => {
    const card = events.find((event) => event.kind === "permission");
    if (card === undefined) {
        throw new Error("the gate raised no permission card");
    }
    return card;
};

// Let the parked hook reach its `wait` before answering the card it raised.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Log rows minus `at` (a clock reading, not a decision), so tests can match an entire row exactly.
const rowsOf = (logged: readonly SafetyLogEntry[]): Omit<SafetyLogEntry, "at">[] => logged.map(({ at: _at, ...row }) => row);

// Triage + judge fields most FORCE_PUSH tests share, before the verdict is added.
const FORCE_PUSH_ROW = { program: FORCE_PUSH, classes: ["git.destructive"], sentence: `It does the thing.` };

// Triage only decides whether a judge should look; an unmatched command costs nothing (no card, no log
// entry, no model call).
describe("command gate: triage", () => {
    test("an unmatched command never reaches the judge at all", async () => {
        const gate = harness({ judge: always("refuse") });
        expect(await gate.run("pnpm test")).toEqual({});
        expect(gate.seen).toEqual([]);
        expect(gate.logged).toEqual([]);
    });

    test("a non-string command passes untouched: nothing to classify", async () => {
        const gate = harness({ judge: always("refuse") });
        expect(await gate.run(undefined)).toEqual({});
        expect(gate.seen).toEqual([]);
    });

    // Each of these matches the classifier the same way a real recursive delete would; the judge, not the
    // pattern, tells them apart.
    test("a triage false positive is allowed by the judge without anybody being interrupted", async () => {
        const gate = harness({ judge: always("allow", `Writes a script to a file; nothing is deleted now.`) });
        for (const command of [
            `rg -n 'rm -rf' src`,
            `git commit -m "remove git push --force from docs"`,
            `cat > deploy.sh <<'EOF'\nrm -rf build\nEOF`,
        ]) {
            expect((await gate.run(command)).hookSpecificOutput, command).toBeUndefined();
        }
        expect(gate.events).toEqual([]);
        expect(gate.logged.every((entry) => entry.outcome === "allowed")).toBe(true);
    });

    // The hard rule matches `rm -rf /` as text, even inside a string being written to a file, and fires before
    // the judge can weigh in.
    test("a delete the command only mentions does not reach the hard rule", async () => {
        const gate = harness({ judge: always("allow", `Appends a line of prose to a notes file.`) });
        expect(await gate.run(`echo "rm -rf /" >> notes.md`)).toEqual({});
        expect(gate.events).toEqual([]);
    });

    // Still triaged and judged, so a matched-but-safe mention is a judge call, not a silent bypass.
    test("a mention is still classified, judged and recorded", async () => {
        const gate = harness({ judge: always("allow", `Appends a line of prose to a notes file.`) });
        await gate.run(`echo "rm -rf /" >> notes.md`);
        expect(gate.seen).toHaveLength(1);
        expect(gate.logged).toMatchObject([{ classes: expect.arrayContaining(["system.destructive"]), outcome: "allowed" }]);
    });
});

describe("command gate: verdicts", () => {
    test("allow runs the command and interrupts nobody", async () => {
        const gate = harness({ judge: always("allow") });
        expect(await gate.run(FORCE_PUSH)).toEqual({});
        expect(gate.events).toEqual([]);
    });

    test("refuse stops it and hands the judge's own sentence back to the model", async () => {
        const gate = harness({ judge: always("refuse", `Force-pushes to a shared branch, which your policy forbids.`) });
        const out = await gate.run(FORCE_PUSH);
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect(reasonOf(out)).toContain("Force-pushes to a shared branch");
        expect(reasonOf(out)).toContain("Do not retry");
        expect(gate.events).toEqual([]);
    });

    test("ask parks on a card, and the command runs when the user allows it", async () => {
        const gate = harness({ judge: always("ask", `Discards whatever commits origin has.`) });
        const pending = gate.run(FORCE_PUSH);
        await settled();
        const card = cardOf(gate.events);
        expect(card).toMatchObject({ toolName: "Bash", program: { text: FORCE_PUSH, language: "bash", truncated: false } });
        expect(resolveRequest({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
        expect(await pending).toEqual({});
        // Every parked card owes the stream its resolution frame.
        expect(gate.events.some((event) => event.kind === "resolved")).toBe(true);
    });

    // The judge's sentence is the card's title from the moment it is raised, not a separate frame added later.
    test("the judge's sentence is the card's title from the moment it is raised", async () => {
        const gate = harness({ judge: always("ask", `Discards whatever commits origin has.`) });
        const pending = gate.run(FORCE_PUSH);
        await settled();
        expect(cardOf(gate.events).title).toBe(`Discards whatever commits origin has.`);
        // `explain` stays unset here; repeating the title as a subline would duplicate it.
        expect(cardOf(gate.events).explain).toBeUndefined();
        // The card and its resolution are the only two event frames emitted here.
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
        expect(gate.events.map((event) => event.kind)).toEqual(["permission", "resolved"]);
    });

    // The card's title reflects the judge's verdict, not whichever triage class matched first.
    test("a card about a publish does not announce a recursive delete triage also matched", async () => {
        const gate = harness({ judge: always("ask", `Publishes an npm package, which your policy asks about.`) });
        const command = `rm -rf /tmp/repro/state && npm publish`;
        const pending = gate.run(command);
        await settled();
        const card = cardOf(gate.events);
        expect(card.title).toBe(`Publishes an npm package, which your policy asks about.`);
        expect(card.title).not.toContain(COMMAND_CLASS_LABELS["files.destructive"]);
        // Both matched fragments are marked, in the command's own order.
        expect(card.program?.spans.map((span) => command.slice(span.start, span.end))).toEqual([`rm -rf /tmp/repro/state`, `npm publish`]);
        resolveRequest({ kind: "permission", requestId: card.requestId, decision: "once" });
        await pending;
    });

    test("declining refuses the command and does not invite a way around it", async () => {
        const gate = harness({ judge: always("ask") });
        const pending = gate.run(`rm -rf ${WORKSPACE_ROOT}/intentic`);
        await settled();
        expect(resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "deny" })).toBe("settled");
        const out = await pending;
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect(reasonOf(out)).toMatch(/declined/i);
        expect(reasonOf(out)).not.toMatch(/unattended/i);
    });

    test("declining WITH feedback passes the redirection through instead", async () => {
        const gate = harness({ judge: always("ask") });
        const pending = gate.run("rm -rf build");
        await settled();
        const requestId = cardOf(gate.events).requestId;
        expect(resolveRequest({ kind: "permission", requestId, decision: "deny", feedback: "Use `pnpm clean` instead." })).toBe("settled");
        expect(reasonOf(await pending)).toBe("Use `pnpm clean` instead.");
    });

    test("a stopped turn settles the card as a refusal rather than holding the turn open", async () => {
        const gate = harness({ judge: always("ask") });
        const pending = gate.run(FORCE_PUSH);
        await settled();
        gate.abort();
        expect((await pending).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    });

    // Unattended is decided before the gate ever tries to park a card, since nobody could answer one.
    test("an ask on an unattended turn refuses, and tells the agent not to retry", async () => {
        const gate = harness({ judge: always("ask"), unattended: true });
        const out = await gate.run(FORCE_PUSH);
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect(reasonOf(out)).toContain("unattended");
        expect(reasonOf(out)).toContain("Do not retry");
        expect(gate.events).toEqual([]);
    });

    // A steering message is somebody typing into this turn. The card goes to the same chat they typed in, so the
    // refusal above would be refusing the one person who is demonstrably there.
    test("an ask on an unattended turn a person has steered raises a card instead of refusing", async () => {
        const gate = harness({ judge: always("ask"), unattended: true, steered: () => true });
        const pending = gate.run(FORCE_PUSH);
        await settled();
        // cardOf throws when nothing was raised, so reaching here is the assertion that it asked rather than refused.
        const card = cardOf(gate.events);
        resolveRequest({ kind: "permission", requestId: card.requestId, decision: "once" });
        await pending;
        // The log is where "asked, and they said yes" is recorded; the unattended refusal above never reaches it.
        expect(gate.logged).toMatchObject([{ outcome: "allowed", answer: "allowed" }]);
    });

    // For runtimes that cannot pause for approval; distinct from unattended, since someone may be watching.
    test("a runtime that cannot park says so instead of claiming nobody is there", async () => {
        const gate = harness({ judge: always("ask"), canPark: false });
        const out = await gate.run(FORCE_PUSH);
        expect(reasonOf(out)).toContain("cannot pause to ask");
        expect(reasonOf(out)).not.toContain("unattended");
    });
});

// Taint and attendedness are evidence handed to the judge, not hard-coded floors; the owner's policy can
// weigh them. These tests cover only the handover.
describe("command gate: the facts the judge is handed", () => {
    test("it is handed the classes triage matched, the language, and where it would run", async () => {
        const gate = harness({ judge: always("allow"), cwd: `${WORKSPACE_ROOT}/app` });
        await gate.run(FORCE_PUSH);
        expect(gate.seen[0]?.program).toBe(FORCE_PUSH);
        // Asserts the whole facts object; a partial match would miss an unexpected field leaking in.
        expect(gate.seen[0]?.facts).toEqual({
            consequences: [COMMAND_CLASS_LABELS["git.destructive"]],
            language: "bash",
            cwd: `${WORKSPACE_ROOT}/app`,
            unattended: false,
        });
    });

    test("a script is named as a script, so the sentence can call it one", async () => {
        const gate = harness({ judge: always("allow") });
        await gate.runCode('await fetch("https://api.example.com/x")');
        expect(gate.seen[0]?.facts.language).toBe("javascript");
    });

    test("an unattended turn is declared as one BEFORE the verdict, not only after it", async () => {
        const gate = harness({ judge: always("allow"), unattended: true });
        await gate.run("rm -rf build");
        expect(gate.seen[0]?.facts.unattended).toBe(true);
    });

    // The judge reads the same fact the gate acts on: telling it nobody can answer while a card would in fact reach
    // the person steering the turn is the one way these two can disagree.
    test("a steered turn is declared to the judge as one somebody is watching", async () => {
        const gate = harness({ judge: always("allow"), unattended: true, steered: () => true });
        await gate.run("rm -rf build");
        expect(gate.seen[0]?.facts.unattended).toBe(false);
    });

    test("the outside-content source is named, so a policy can key on what brought it in", async () => {
        const gate = harness({ judge: always("allow"), taint: createTurnTaint("discord") });
        await gate.run("rm -rf build");
        expect(gate.seen[0]?.facts.outsideSource).toBe("discord");
    });

    // Taint is read per command, not snapshotted once; a page can taint the turn mid-way through.
    test("a page fetched mid-turn changes the facts from that moment on", async () => {
        const taint = createTurnTaint();
        const gate = harness({ judge: always("allow"), taint });
        await gate.run("rm -rf build");
        expect(gate.seen[0]?.facts.outsideSource).toBeUndefined();
        taint.mark("web");
        await gate.run("rm -rf dist");
        expect(gate.seen[1]?.facts.outsideSource).toBe("web");
    });

    // The per-turn memo must not reuse a pre-taint verdict once the turn is tainted; the command is judged again.
    test("the same command is judged again once the turn is tainted", async () => {
        const taint = createTurnTaint();
        const gate = harness({ judge: always("allow"), taint });
        await gate.run("rm -rf build");
        await gate.run("rm -rf build");
        expect(gate.seen).toHaveLength(1);
        taint.mark("web");
        await gate.run("rm -rf build");
        expect(gate.seen).toHaveLength(2);
    });

    // Never the agent's own account of what it's doing, which would let it argue for its own approval.
    test("the judge sees the program and the daemon's facts, and nothing the agent said", async () => {
        const gate = harness({ judge: always("allow") });
        const script = 'const env = await fs.readFile(".env", "utf8");';
        await gate.runCode(script);
        expect(gate.seen).toHaveLength(1);
        expect(gate.seen[0]?.program).toBe(script);
        expect(Object.keys(gate.seen[0]?.facts ?? {}).sort()).toEqual(["consequences", "language", "unattended"]);
    });
});

// One typed verdict applied before the judge is even called, over classes where nothing recovers; a model
// can be argued into anything by the text it's judging.
describe("command gate: the hard rule", () => {
    // Commands that hit the sandbox floor: a block device, the filesystem root, or /history.
    const WIPES = ["mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda", "rm -rf /", "rm -rf /history"];

    test("a judge that says allow cannot wave through a command that wipes a disk", async () => {
        for (const command of WIPES) {
            const gate = harness({ judge: always("allow", `Routine cleanup, nothing to worry about.`) });
            const pending = gate.run(command);
            await settled();
            const card = cardOf(gate.events);
            expect(card.title, command).toContain("wipe a disk");
            resolveRequest({ kind: "permission", requestId: card.requestId, decision: "once" });
            expect((await pending).hookSpecificOutput, command).toBeUndefined();
        }
    });

    // Left off the floor because each is a container fact: a named volume is the nested engine's, `~`/`/work`
    // are scratch, `/usr` comes back with the image.
    test("what only a laptop cannot recover is judged here, not held", async () => {
        for (const command of ["docker volume rm app_data", "docker compose down -v", "rm -rf ~", "rm -rf /work", "rm -rf /usr"]) {
            const gate = harness({ judge: always("allow", `Tears down the throwaway stack this turn started.`) });
            expect(await gate.run(command), command).toEqual({});
            expect(gate.events, command).toEqual([]);
            expect(gate.seen, command).toHaveLength(1);
        }
    });

    // These commands can still ask, if the owner's policy says so; the judge decides them now instead of a
    // fixed rule.
    test("and the policy can still stop every one of them", async () => {
        for (const command of ["docker volume rm app_data", "rm -rf ~"]) {
            const gate = harness({ judge: always("ask", `Deletes a named volume.`) });
            const pending = gate.run(command);
            await settled();
            const card = cardOf(gate.events);
            // No hard rule behind this card, so the judge's sentence is the title, not a sub-line.
            expect(card.title, command).toBe(`Deletes a named volume.`);
            resolveRequest({ kind: "permission", requestId: card.requestId, decision: "once" });
            expect((await pending).hookSpecificOutput, command).toBeUndefined();
        }
    });

    // The hard rule only ever makes a verdict stricter; a refusal stays a refusal, never softened into a card.
    test("a refusal over a hard-ruled class stays a refusal", async () => {
        const out = await harness({ judge: always("refuse") }).run("mkfs.ext4 /dev/sda1");
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    });

    // Keeps the hard rule narrow: it must not reach ordinary work, or it becomes the thing it replaced.
    test("it does not reach anything else, however alarming", async () => {
        const gate = harness({ judge: always("allow") });
        for (const command of [FORCE_PUSH, "rm -rf build", "rm -rf node_modules", "cat .env", "npm publish"]) {
            expect((await gate.run(command)).hookSpecificOutput, command).toBeUndefined();
        }
        expect(gate.events).toEqual([]);
    });

    test("unattended, it refuses instead of parking", async () => {
        const out = await harness({ judge: always("allow"), unattended: true }).run("mkfs.ext4 /dev/sda1");
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect(reasonOf(out)).toContain("unattended");
    });
});

// When the judge cannot run at all: fall back to the hard rule, and allow everything else.
describe("command gate: no judge", () => {
    const BROKEN: CommandGateOptions["judge"] = () => Promise.reject(new Error("No AI account is connected to this sandbox"));

    test("a triage hit is allowed when nothing is hard-ruled", async () => {
        for (const judge of [BROKEN, undefined]) {
            const gate = harness({ judge });
            expect((await gate.run(FORCE_PUSH)).hookSpecificOutput).toBeUndefined();
            expect(gate.events).toEqual([]);
        }
    });

    test("the hard rule still asks, and says the judge did not run rather than inventing a reason", async () => {
        const gate = harness({ judge: BROKEN });
        const pending = gate.run("mkfs.ext4 /dev/sda1");
        await settled();
        expect(cardOf(gate.events).explain).toContain("could not be reached");
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        expect((await pending).hookSpecificOutput).toBeUndefined();
    });

    test("unattended and unjudgeable, the hard rule refuses and everything else runs", async () => {
        const gate = harness({ judge: BROKEN, unattended: true });
        expect((await gate.run("mkfs.ext4 /dev/sda1")).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect((await gate.run(FORCE_PUSH)).hookSpecificOutput).toBeUndefined();
    });

    // A failed judgment is not cached; the next command is judged again.
    test("a failed judgment is not remembered as a verdict", async () => {
        let attempts = 0;
        const gate = harness({
            judge: async (): Promise<SafetyVerdict> => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error("momentary");
                }
                return { decision: "refuse", sentence: `Not allowed.` };
            },
        });
        expect((await gate.run(FORCE_PUSH)).hookSpecificOutput).toBeUndefined();
        expect((await gate.run(FORCE_PUSH)).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect(attempts).toBe(2);
    });
});

// `settings.commandJudge`: watch the judge before trusting it, or turn it off outright. The hard rule
// survives either setting.
describe("command gate: the owner's switch", () => {
    describe("off", () => {
        test("nothing is judged, nothing is asked, and no model is spent", async () => {
            const gate = harness({ judging: "off", judge: always("refuse") });
            for (const command of [FORCE_PUSH, "rm -rf build", "cat .env", "npm publish"]) {
                expect((await gate.run(command)).hookSpecificOutput, command).toBeUndefined();
            }
            expect(gate.seen).toEqual([]);
            expect(gate.events).toEqual([]);
        });

        // Nothing looked at the command, so nothing is logged; a row would only repeat the setting.
        test("nothing is written to the log either", async () => {
            const gate = harness({ judging: "off", judge: always("refuse") });
            await gate.run(FORCE_PUSH);
            expect(gate.logged).toEqual([]);
        });

        // The floor under the switch: wiping a disk still asks even with judging off, and says the judge didn't
        // run rather than inventing a verdict.
        test("the hard rule still asks, and says the judge is off rather than inventing a reason", async () => {
            const gate = harness({ judging: "off", judge: always("allow") });
            const pending = gate.run("mkfs.ext4 /dev/sda1");
            await settled();
            const card = cardOf(gate.events);
            expect(card.title).toContain("wipe a disk");
            expect(card.explain).toContain("turned off");
            expect(gate.seen).toEqual([]);
            expect(rowsOf(gate.logged)).toEqual([
                {
                    program: "mkfs.ext4 /dev/sda1",
                    classes: ["system.destructive"],
                    decision: "allow",
                    sentence: `The safety judge is turned off, so this was decided by the standing rule alone.`,
                    outcome: "asked",
                },
            ]);
            resolveRequest({ kind: "permission", requestId: card.requestId, decision: "once" });
            expect((await pending).hookSpecificOutput).toBeUndefined();
        });
    });

    describe("watch", () => {
        // Watch mode records the verdict but runs the command anyway; `decision: ask` beside `outcome: allowed`
        // says it would have stopped, and didn't.
        test("an ask is recorded as an ask and the command runs anyway", async () => {
            const gate = harness({ judging: "watch", judge: always("ask", `Force-pushes to origin.`) });
            expect((await gate.run(FORCE_PUSH)).hookSpecificOutput).toBeUndefined();
            expect(gate.events).toEqual([]);
            expect(rowsOf(gate.logged)).toEqual([{ ...FORCE_PUSH_ROW, sentence: `Force-pushes to origin.`, decision: "ask", outcome: "allowed" }]);
        });

        // Watch mode never enforces; a refusal is logged and stepped over exactly like an ask.
        test("a refusal is recorded and stepped over rather than enforced", async () => {
            const gate = harness({ judging: "watch", judge: always("refuse", `Your policy forbids this.`) });
            expect((await gate.run(FORCE_PUSH)).hookSpecificOutput).toBeUndefined();
            expect(rowsOf(gate.logged)).toEqual([
                { ...FORCE_PUSH_ROW, sentence: `Your policy forbids this.`, decision: "refuse", outcome: "allowed" },
            ]);
        });

        // The hard rule ignores `judging`; nothing stands between it and a card. Its sentence still comes from the
        // judge, which does run at this setting.
        test("the hard rule still asks, carrying what the judge said about it", async () => {
            const gate = harness({ judging: "watch", judge: always("allow", `Formats the second disk.`) });
            const pending = gate.run("mkfs.ext4 /dev/sda1");
            await settled();
            const card = cardOf(gate.events);
            expect(card.title).toContain("wipe a disk");
            expect(card.explain).toBe(`Formats the second disk.`);
            resolveRequest({ kind: "permission", requestId: card.requestId, decision: "once" });
            expect((await pending).hookSpecificOutput).toBeUndefined();
        });
    });
});

// Two memories: a turn-scoped one stops the same command asking twice, and a durable one is a policy line
// the owner read and accepted.
describe("command gate: what an answer remembers", () => {
    test("a repeated command does not ask twice in one turn", async () => {
        const gate = harness({ judge: always("ask") });
        const pending = gate.run(FORCE_PUSH);
        await settled();
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
        expect(await gate.run(FORCE_PUSH)).toEqual({});
        expect(gate.events.filter((event) => event.kind === "permission")).toHaveLength(1);
    });

    // The per-turn memo is keyed per command, not per class; a yes to one recursive delete does not wave
    // through another.
    test("a yes to one command is not a yes to every command of its kind", async () => {
        const gate = harness({ judge: always("ask") });
        const pending = gate.run("rm -rf build");
        await settled();
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
        void gate.run(`rm -rf ${WORKSPACE_ROOT}/intentic`);
        await settled();
        expect(gate.events.filter((event) => event.kind === "permission")).toHaveLength(2);
    });

    // The Always button edits the policy; its label is the exact line that would be written.
    test("the card offers the judge's proposed line as the always label, and accepting it appends it", async () => {
        const gate = harness({ judge: always("ask", `Deletes the build directory.`, `Deleting build directories under /work is fine.`) });
        const pending = gate.run("rm -rf build");
        await settled();
        const card = cardOf(gate.events);
        expect(card.alwaysLabel).toContain("Deleting build directories under /work is fine.");
        resolveRequest({ kind: "permission", requestId: card.requestId, decision: "always" });
        await pending;
        await settled();
        expect(gate.remembered).toEqual(["Deleting build directories under /work is fine."]);
    });

    // No Always button when the judge proposed no line to write; it must never silently mean "just this turn".
    test("no always label when the judge proposed no line", async () => {
        const gate = harness({ judge: always("ask") });
        const pending = gate.run(FORCE_PUSH);
        await settled();
        expect(cardOf(gate.events).alwaysLabel).toBeUndefined();
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
    });

    test("nor when there is nowhere to put it", async () => {
        const gate = harness({ judge: always("ask", `x`, `A line.`), remember: undefined });
        const pending = gate.run(FORCE_PUSH);
        await settled();
        expect(cardOf(gate.events).alwaysLabel).toBeUndefined();
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
    });
});

// Makes a written policy editable. The entries that matter most are the allowed ones: commands nobody was
// asked about.
describe("command gate: the log", () => {
    test("an allowed command is recorded even though nobody was interrupted", async () => {
        const gate = harness({ judge: always("allow", `Deletes the build directory.`) });
        await gate.run("rm -rf build");
        expect(rowsOf(gate.logged)).toEqual([
            {
                program: "rm -rf build",
                classes: ["files.destructive"],
                decision: "allow",
                outcome: "allowed",
                sentence: "Deletes the build directory.",
            },
        ]);
        // The one field the row above drops, which is a clock reading and not a decision.
        expect(Number.isInteger(gate.logged[0]?.at)).toBe(true);
    });

    test("a refusal is recorded as one", async () => {
        const gate = harness({ judge: always("refuse") });
        await gate.run(FORCE_PUSH);
        expect(rowsOf(gate.logged)).toEqual([{ ...FORCE_PUSH_ROW, decision: "refuse", outcome: "refused" }]);
    });

    // The verdict is logged when reached, not when the card settles, so a stopped turn still leaves a record;
    // the answer amends it after.
    test("a card is logged as asked, then amended with how it was answered", async () => {
        const gate = harness({ judge: always("ask") });
        const pending = gate.run(FORCE_PUSH);
        await settled();
        expect(rowsOf(gate.logged)).toEqual([{ ...FORCE_PUSH_ROW, decision: "ask", outcome: "asked" }]);
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "deny" });
        await pending;
        expect(rowsOf(gate.logged)).toEqual([{ ...FORCE_PUSH_ROW, decision: "ask", outcome: "refused", answer: "declined" }]);
    });

    test("an unanswerable ask is recorded as the refusal it became", async () => {
        const gate = harness({ judge: always("ask"), unattended: true });
        await gate.run(FORCE_PUSH);
        expect(rowsOf(gate.logged)).toEqual([{ ...FORCE_PUSH_ROW, decision: "ask", outcome: "refused" }]);
    });
});

// What the card shows, as distinct from what it decides: the half a person actually reads.
describe("the card's program", () => {
    // Offsets let the card mark just the characters that stopped it, inside an otherwise ordinary line.
    test("marks the fragment its own class fired on", async () => {
        const gate = harness({ judge: always("ask") });
        const command = `cd /work && rg -n token .env.production`;
        const pending = gate.run(command);
        await settled();
        const { program } = cardOf(gate.events);
        expect(program?.spans.map((span) => command.slice(span.start, span.end))).toEqual([".env.production"]);
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
    });

    // A mark within the first 400 characters is excerpted plainly: the beginning, mark left where it was.
    test("a long program whose mark lands in the head is cut at the head, with no elision", async () => {
        const gate = harness({ judge: always("ask") });
        const command = `cat .env.production; ${"echo padding; ".repeat(40)}`;
        const pending = gate.run(command);
        await settled();
        const { program } = cardOf(gate.events);
        expect(program?.truncated).toBe(true);
        expect(program?.text.length).toBe(400);
        expect(program?.text).not.toContain(`not shown`);
        expect(program?.spans.map((span) => program.text.slice(span.start, span.end))).toEqual([`.env.production`]);
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
    });

    // A mark past the head must survive excerpting: the head still identifies the program, the skipped middle
    // is declared, and offsets land on the excerpt itself.
    test("a mark past the head survives the shortening, with the skipped middle declared", async () => {
        const gate = harness({ judge: always("ask") });
        const command = `${"echo padding; ".repeat(40)}cat .env`;
        const pending = gate.run(command);
        await settled();
        const { program } = cardOf(gate.events);
        expect(program?.truncated).toBe(true);
        expect(program?.text).toContain(`cat .env`);
        expect(program?.text).toMatch(/\[… \d+ characters not shown …\]/);
        expect(program?.text.startsWith(command.slice(0, 120))).toBe(true);
        expect(program?.spans.map((span) => program.text.slice(span.start, span.end))).toEqual([`.env`]);
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
    });

    // A script whose imports fill the head but whose delete is at the end; the mark must still reach the card.
    test("a heredoc's recursive delete reaches the card even when the imports fill the head", async () => {
        const gate = harness({ judge: always("ask") });
        const code = `${Array.from({ length: 12 }, (_unused, at) => `import { thing${at} } from "node:fs/promises";`).join(`\n`)}\nawait rm(dir, { recursive: true });\n`;
        const pending = gate.runCode(code);
        await settled();
        const { program } = cardOf(gate.events);
        expect(program?.spans.map((span) => program.text.slice(span.start, span.end))).toEqual([`rm(dir, { recursive: true`]);
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
    });
});

// The JS execution backend runs under the same gate, policy and cards as shell; the classifier reads a
// script the same substring way.
describe("the gate over JS runs", () => {
    test("a refused script is stopped before it runs", async () => {
        const out = await harness({ judge: always("refuse") }).runCode('await fetch("https://api.example.com/x")');
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    });

    test("an unclassified script passes untouched, and so does a non-string input", async () => {
        const gate = harness({ judge: always("refuse") });
        expect(await gate.runCode('console.log(2 + 2); await fetch("http://localhost:3000/api")')).toEqual({});
        expect(await gate.runCode(undefined)).toEqual({});
    });

    test("an asked script parks on a card that says it is a script, not a command", async () => {
        const gate = harness({ judge: always("ask") });
        const script = 'const env = await fs.readFile(".env", "utf8");';
        const pending = gate.runCode(script);
        await settled();
        const card = cardOf(gate.events);
        // Calling it a script (not bash) is the judge's own sentence, driven by facts.language.
        expect(card).toMatchObject({ toolName: JS_TOOL_NAME, displayName: "Run code", program: { text: script, language: "javascript" } });
        expect(gate.seen[0]?.facts.language).toBe("javascript");
        expect(resolveRequest({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
        expect(await pending).toEqual({});
    });
});
