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
import { resolveRequest } from "../agent/agent-requests.js";
import type { JudgeFacts } from "../agent/command-judge.js";
import { JS_TOOL_NAME } from "../execution/js-tool.js";
import { commandGateHooks, type CommandGateOptions } from "./command-gate.js";
import { createTurnTaint, NO_TAINT } from "./turn-taint.js";

const FORCE_PUSH = "git push --force origin main";

// A judge that always answers the same way. The gate's own tests are about the PIPELINE — what triage wakes,
// what the hard rule overrides, what a verdict turns into — so the model itself is a constant here; whether a
// real model reads a policy correctly is command-judge.test.ts's question.
const always = (decision: SafetyVerdict["decision"], sentence = `It does the thing.`, policyLine?: string): CommandGateOptions["judge"] =>
    async () => ({ decision, sentence, ...(policyLine === undefined ? {} : { policyLine }) });

interface Harness {
    readonly run: (command: unknown) => Promise<SyncHookJSONOutput>;
    // The same gate's second source: a JS run, the script in tool_input.code (EXECUTION_SOURCES).
    readonly runCode: (code: unknown) => Promise<SyncHookJSONOutput>;
    readonly events: AgentEvent[];
    // Everything the gate wrote to the safety log, in order, including the verdicts nobody was shown.
    readonly logged: SafetyLogEntry[];
    // Every set of facts the judge was handed, for the tests that are about what it is TOLD rather than what it
    // answers — the taint bit and the attendedness are evidence now, not hard-coded floors.
    readonly seen: { program: string; facts: JudgeFacts }[];
    // Lines accepted on a card and appended to the owner's policy.
    readonly remembered: string[];
    readonly abort: () => void;
}

// Drive the PreToolUse hooks the way the SDK does: one Bash call with the command in tool_input, or one JS
// run with the script. The gate is built once per harness, which is what makes a per-turn grant and the
// judge's memo observable across two calls, and across the two sources.
const harness = (options: Partial<CommandGateOptions> = {}): Harness => {
    const events: AgentEvent[] = [];
    const logged: SafetyLogEntry[] = [];
    const seen: { program: string; facts: JudgeFacts }[] = [];
    const remembered: string[] = [];
    const controller = new AbortController();
    const judge = options.judge;
    const matchers = commandGateHooks({
        policy: DEFAULT_SAFETY_POLICY,
        // The full design unless a test says otherwise; the owner's other two settings have a describe of their own.
        judging: "on",
        unattended: false,
        push: (event) => events.push(event),
        signal: controller.signal,
        // Untainted unless a test says otherwise: the ordinary turn, working on the owner's own material.
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
        // Wrapped rather than replaced, so every test records the facts without having to opt in.
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

/* The log rows as these tests read them: the whole entry except `at`, which is a clock reading rather than a
 * decision. Dropping the one unassertable field is what lets every log test pin the ENTIRE row — a partial
 * match would have said nothing about the fields the gate is supposed to leave alone (no `answer` on a verdict
 * nobody was asked about, no `machine` on a command that ran here). */
const rowsOf = (logged: readonly SafetyLogEntry[]): Omit<SafetyLogEntry, "at">[] => logged.map(({ at: _at, ...row }) => row);

// What triage and the judge fill in for the command most of these tests run, before the verdict is reached.
const FORCE_PUSH_ROW = { program: FORCE_PUSH, classes: ["git.destructive"], sentence: `It does the thing.` };

/* TIER 1. The classifier decides only that a judge should look, and the money test for the whole redesign is
 * that a command it does not match costs nothing at all: not a card, not a log line, and above all not a model
 * call. That is what pays for triage being allowed to be over-inclusive everywhere else. */
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

    /* THE FAILURE THE REDESIGN EXISTS TO FIX, as a test. Every one of these matches the classifier, and under
     * the old design each raised the identical card to a real recursive delete. Now they are a judge's call, and
     * a judge that reads them can say what a pattern could not. */
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

    /* THE COST THE HARD RULE ACTUALLY CHARGES, stated as a test so nobody discovers it as a bug. Triage matches
     * `system.destructive` on the text `rm -rf /` wherever it appears, including inside a string being written
     * to a file, and the hard rule fires before the judge and cannot be talked out of it. So this one false
     * positive still interrupts somebody.
     *
     * That is the deliberate trade and it should stay visible here rather than being tuned away. The alternative
     * is a judge that can waive the rule, and a judge can be argued into anything by text inside the very
     * command it is reading — which is the same text this test is about. Writing the words `rm -rf /` into a
     * file is rare; being one mistyped path from a formatted disk is not recoverable. */
    test("a false positive on the hard-ruled class still asks, because nothing may waive that rule", async () => {
        const gate = harness({ judge: always("allow", `Appends a line of prose to a notes file.`) });
        const pending = gate.run(`echo "rm -rf /" >> notes.md`);
        await settled();
        // The one card that keeps a titled consequence, because the hard rule really is a typed verdict over a
        // named class rather than triage's guess. The judge's sentence goes underneath it.
        expect(cardOf(gate.events).title).toContain("wipe a disk");
        expect(cardOf(gate.events).explain).toBe(`Appends a line of prose to a notes file.`);
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        expect((await pending).hookSpecificOutput).toBeUndefined();
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

    /* THE SENTENCE IS THE CARD, and it is there when the card goes out. It used to arrive later as its own
     * frame, raced against the answer, because it was an optional translation the card must not wait for. It is
     * the verdict's reason now, so there was no card until it existed — and it is the TITLE rather than a note
     * under one, because it is the only account here of why this command in particular is being asked about. */
    test("the judge's sentence is the card's title from the moment it is raised", async () => {
        const gate = harness({ judge: always("ask", `Discards whatever commits origin has.`) });
        const pending = gate.run(FORCE_PUSH);
        await settled();
        expect(cardOf(gate.events).title).toBe(`Discards whatever commits origin has.`);
        // And not a second time in the subline: `explain` would print the same words twice on one card.
        expect(cardOf(gate.events).explain).toBeUndefined();
        // And nothing follows it in: the card and its resolution are the only two frames.
        resolveRequest({ kind: "permission", requestId: cardOf(gate.events).requestId, decision: "once" });
        await pending;
        expect(gate.events.map((event) => event.kind)).toEqual(["permission", "resolved"]);
    });

    /* THE BUG THIS TITLE REPLACED, kept as a test because it is the failure an owner actually reports. The card
     * used to be titled with the FIRST class the catalog matched, in the catalog's own order, which has nothing
     * to do with why the card exists: a command that cleans a build directory and then publishes reads as
     * `files.destructive` to triage and as a publish to the judge, and the card said "This command would delete
     * files recursively" over a sentence about npm. Nothing on it may assert a consequence the judge did not. */
    test("a card about a publish does not announce a recursive delete triage also matched", async () => {
        const gate = harness({ judge: always("ask", `Publishes an npm package, which your policy asks about.`) });
        const command = `rm -rf /tmp/repro/state && npm publish`;
        const pending = gate.run(command);
        await settled();
        const card = cardOf(gate.events);
        expect(card.title).toBe(`Publishes an npm package, which your policy asks about.`);
        expect(card.title).not.toContain(COMMAND_CLASS_LABELS["files.destructive"]);
        // Both matched fragments are marked, in the command's own order: with the title asserting nothing about
        // which pattern fired, showing one of them would be the same claim made with a highlight instead.
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

    /* The unattended branch, and the whole reason the gate words this rather than the judge: a card raised where
     * nobody can answer hangs the turn until its timeout and reads as the agent freezing. What CHANGED is that
     * the judge is told first (see the facts tests below), so a policy that says what to do when nobody is
     * watching gets to answer before this branch is ever reached. */
    test("an ask on an unattended turn refuses, and tells the agent not to retry", async () => {
        const gate = harness({ judge: always("ask"), unattended: true });
        const out = await gate.run(FORCE_PUSH);
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect(reasonOf(out)).toContain("unattended");
        expect(reasonOf(out)).toContain("Do not retry");
        expect(gate.events).toEqual([]);
    });

    // The runtimes whose vendor puts a clock on a paused approval (OpenCode). Distinct from unattended on
    // purpose: telling somebody sitting in front of the turn that nobody is there would be a lie.
    test("a runtime that cannot park says so instead of claiming nobody is there", async () => {
        const gate = harness({ judge: always("ask"), canPark: false });
        const out = await gate.run(FORCE_PUSH);
        expect(reasonOf(out)).toContain("cannot pause to ask");
        expect(reasonOf(out)).not.toContain("unattended");
    });
});

/* WHAT THE JUDGE IS TOLD. The taint bit and the attendedness used to be hard-coded floors in the guard; they
 * are EVIDENCE now, which is what lets the owner write "be careful about deletes after reading a web page" as a
 * sentence they can narrow or drop. These tests are about the handover, not about what a model does with it. */
describe("command gate: the facts the judge is handed", () => {
    test("it is handed the classes triage matched, the language, and where it would run", async () => {
        const gate = harness({ judge: always("allow"), cwd: `${WORKSPACE_ROOT}/app` });
        await gate.run(FORCE_PUSH);
        expect(gate.seen[0]?.program).toBe(FORCE_PUSH);
        // The WHOLE set of facts, not a subset of it: what the judge is not told is as much the contract as what
        // it is, and a partial match would say nothing about a machine or an outside source leaking in here.
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

    test("the outside-content source is named, so a policy can key on what brought it in", async () => {
        const gate = harness({ judge: always("allow"), taint: createTurnTaint("discord") });
        await gate.run("rm -rf build");
        expect(gate.seen[0]?.facts.outsideSource).toBe("discord");
    });

    /* The bit is read PER COMMAND rather than snapshotted: the page that taints a turn usually arrives mid-turn,
     * several tool calls before the command that matters. */
    test("a page fetched mid-turn changes the facts from that moment on", async () => {
        const taint = createTurnTaint();
        const gate = harness({ judge: always("allow"), taint });
        await gate.run("rm -rf build");
        expect(gate.seen[0]?.facts.outsideSource).toBeUndefined();
        taint.mark("web");
        await gate.run("rm -rf dist");
        expect(gate.seen[1]?.facts.outsideSource).toBe("web");
    });

    /* AND THE MEMO MUST NOT LAUNDER A PRE-TAINT VERDICT INTO A TAINTED TURN. The same command judged before a
     * page was read has to be judged again after it, or the cache would be quietly answering a question nobody
     * asked in the new state. */
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

    // Never the agent's own account of what it is doing: a card whose persuasive half was written by the thing
    // being gated would argue for its own approval.
    test("the judge sees the program and the daemon's facts, and nothing the agent said", async () => {
        const gate = harness({ judge: always("allow") });
        const script = 'const env = await fs.readFile(".env", "utf8");';
        await gate.runCode(script);
        expect(gate.seen).toHaveLength(1);
        expect(gate.seen[0]?.program).toBe(script);
        expect(Object.keys(gate.seen[0]?.facts ?? {}).sort()).toEqual(["consequences", "language", "unattended"]);
    });
});

/* THE HARD RULE. One typed verdict the judge cannot reach, applied before it is even called, over the classes
 * where nothing recovers. This is the case the whole design turns on: a model can be argued into anything by
 * text inside the command it is judging, and being wrong once here costs the machine. */
describe("command gate: the hard rule", () => {
    const WIPES = ["mkfs.ext4 /dev/sda1", "docker volume rm app_data", "rm -rf ~", "dd if=/dev/zero of=/dev/sda"];

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

    // It only ever makes a verdict stricter. A refusal stands as a refusal rather than being softened into a card.
    test("a refusal over a hard-ruled class stays a refusal", async () => {
        const out = await harness({ judge: always("refuse") }).run("mkfs.ext4 /dev/sda1");
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    });

    /* Narrow on purpose, and this is the test that keeps it narrow: the hard rule must not reach ordinary work,
     * or it becomes the thing it replaced. Everything below is triaged, judged, and allowed. */
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

/* WHEN THE JUDGE CANNOT RUN: nothing connected, every rung spent, every rung off-shape. A real state that needs
 * a stated posture, and the posture is "fall back to the hard rule, allow the rest" — a sandbox whose model
 * chain is spent must not become one that refuses ordinary work. */
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

    // A momentary outage must not condemn the rest of the turn: the rejection is not cached, so the next
    // command asks again.
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

/* THE OWNER'S SWITCH OVER TIERS 2 AND 3 (settings.commandJudge). The design's own answer to "this asks me about
 * things I do not care about": a judge you can watch before you let it stop anything, and one you can decline
 * outright. What must survive both settings is the hard rule, which never was the judge's to reach. */
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

        // Nothing looked at it, so there is nothing to write down: a row per flagged command saying "allowed,
        // because the judge is off" only repeats the setting back to whoever opened the log.
        test("nothing is written to the log either", async () => {
            const gate = harness({ judging: "off", judge: always("refuse") });
            await gate.run(FORCE_PUSH);
            expect(gate.logged).toEqual([]);
        });

        /* THE FLOOR UNDER THE SWITCH, and the reason the switch can be offered at all. The Safety page promises
         * in as many words that wiping a disk always asks; a setting that quietly broke that promise would make
         * the page a lie. It says the judge did not run rather than inventing a verdict. */
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
        /* THE POINT OF THE MODE: the verdict is recorded and the command runs anyway, so an owner can read what
         * their policy would have done to a week of real work before letting it do any of it. The row's own two
         * fields say so without a third being added — `decision: ask` beside `outcome: allowed` is exactly "this
         * would have stopped you, and it did not". */
        test("an ask is recorded as an ask and the command runs anyway", async () => {
            const gate = harness({ judging: "watch", judge: always("ask", `Force-pushes to origin.`) });
            expect((await gate.run(FORCE_PUSH)).hookSpecificOutput).toBeUndefined();
            expect(gate.events).toEqual([]);
            expect(rowsOf(gate.logged)).toEqual([
                { ...FORCE_PUSH_ROW, sentence: `Force-pushes to origin.`, decision: "ask", outcome: "allowed" },
            ]);
        });

        // A mode that refused commands would be the opposite of what the owner asked for, so the verdict does
        // not enforce here either — a refusal is written down and stepped over exactly as an ask is.
        test("a refusal is recorded and stepped over rather than enforced", async () => {
            const gate = harness({ judging: "watch", judge: always("refuse", `Your policy forbids this.`) });
            expect((await gate.run(FORCE_PUSH)).hookSpecificOutput).toBeUndefined();
            expect(rowsOf(gate.logged)).toEqual([
                { ...FORCE_PUSH_ROW, sentence: `Your policy forbids this.`, decision: "refuse", outcome: "allowed" },
            ]);
        });

        // The hard rule is not the judge's verdict, so there is nothing here for the owner to be evaluating and
        // no setting stands between it and a card. Its sentence is the judge's, which did run at this setting.
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

/* WHAT AN ANSWER REMEMBERS. Two different memories, and keeping them apart is the point: the turn-scoped one
 * stops the same command asking twice in one turn, and the durable one is a line the owner READ before
 * accepting, in a document they can edit later. Neither is a hidden grant. */
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

    /* AND A DIFFERENT COMMAND STILL ASKS. The old grant was per CLASS, so one yes to a recursive delete waved
     * through every recursive delete for the turn, including ones aimed somewhere else entirely. The judge's
     * per-turn memo makes re-deciding free, so a yes can mean yes to THIS — which is what the person clicking
     * it thought it meant. */
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

    // The Always button is an edit to the policy, and its label is the line that would be written, so nobody
    // accepts a rule they have not read.
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

    /* NO BUTTON WHEN THERE IS NOTHING TO WRITE. A button that silently meant "just this turn" would be the card
     * lying about what it did, which is exactly the failure the old always-allow had. */
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

/* THE LOG, which is what makes a written policy editable: nobody can author a rule for behaviour they cannot
 * see. The entries that matter most are the ALLOWED ones — a card you answered is something you already know
 * about, and a command waved through on your policy's say-so is not. */
describe("command gate: the log", () => {
    test("an allowed command is recorded even though nobody was interrupted", async () => {
        const gate = harness({ judge: always("allow", `Deletes the build directory.`) });
        await gate.run("rm -rf build");
        expect(rowsOf(gate.logged)).toEqual([
            { program: "rm -rf build", classes: ["files.destructive"], decision: "allow", outcome: "allowed", sentence: "Deletes the build directory." },
        ]);
        // The one field the row above drops, which is a clock reading and not a decision.
        expect(Number.isInteger(gate.logged[0]?.at)).toBe(true);
    });

    test("a refusal is recorded as one", async () => {
        const gate = harness({ judge: always("refuse") });
        await gate.run(FORCE_PUSH);
        expect(rowsOf(gate.logged)).toEqual([{ ...FORCE_PUSH_ROW, decision: "refuse", outcome: "refused" }]);
    });

    /* THE VERDICT IS WRITTEN WHEN IT IS REACHED, not when the card settles: a turn stopped while a card is up
     * would otherwise leave a verdict the owner can never find out about. The answer amends it afterwards. */
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

/* WHAT THE CARD SHOWS, as distinct from what it decides. The half a person actually reads, and the half that
 * used to be four hundred characters of undifferentiated shell. */
describe("the card's program", () => {
    // The point of carrying offsets at all: the card can mark the few characters that stopped it inside a line
    // that is mostly ordinary work.
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

    /* A long program whose mark is in the first four hundred characters is excerpted the plain way: the
     * beginning, read in one piece, with the mark where it already was. */
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

    /* THE ONE THE SHORTENING MUST NOT REMOVE. The card is a sentence plus the evidence for it, so an excerpt
     * that keeps four hundred characters of padding and drops the `cat .env` is the card asking to be taken on
     * trust. The head still identifies the program, the skipped middle is declared in place, and the offsets
     * land on the excerpt's own ruler. */
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

    /* The shape that reported this: a script of imports and setup that deletes a tree at the end, held under
     * "this script would delete files recursively" — a title whose evidence was exactly the part the old
     * head-only cut dropped. */
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

/* THE SECOND SOURCE: the JS execution backend runs under the same gate, the same policy and the same cards. A
 * line the owner wrote about "commands" applies to both ways of running things, or it is not a rule
 * (command-gate's EXECUTION_SOURCES). The classifier reads a script with the substring honesty it reads shell. */
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
        // The script's own grammar, not bash: the card colours what it is holding, and the two backends are the
        // two languages the gate reads. The card's WORDS are the judge's, and it was told which of the two this
        // is (facts.language), so calling it a script is that sentence's job rather than a title template's.
        expect(card).toMatchObject({ toolName: JS_TOOL_NAME, displayName: "Run code", program: { text: script, language: "javascript" } });
        expect(gate.seen[0]?.facts.language).toBe("javascript");
        expect(resolveRequest({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
        expect(await pending).toEqual({});
    });
});
