import type { StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Rule } from "@intentic/sandbox-contract";
import type { EditCommandRun } from "../../rules/file-edited.js";
import { declarationOf, declaredChecks, rulesOf, withRepoChecks } from "../../rules/repo-checks.js";
import { standing } from "../../rules/rules.js";
import { syncHookOutput } from "../../testing.js";
import {
    TURN_CHECK_CEILING_MS,
    TURN_CHECK_OUTPUT_BYTES,
    type TurnChange,
    type TurnCheckHooks,
    turnCheckHooks,
    type TurnChecks,
    turnChecksNote,
} from "./turn-checks.js";

// The one Stop-time report of what a repository's own `turn` checks found in an isolated turn's change: run once, said
// once, and never a refusal. The checks here are the rules a declaration becomes (repo-checks.ts), not hand-written ones.

const VERIFY_TURN = "node _tools/scripts/verify/verify-turn.mjs";
const LABEL = "Checks CI runs on every push, for what this change added";
const [TURN_CHECK] = rulesOf(declarationOf("intentic", [{ when: "turn", run: VERIFY_TURN, label: LABEL }]));
const CHANGED: TurnChange = { paths: ["intentic/_editor/web/src/A.vue"], repos: ["intentic"] };
const FOUND = "✗ i18n-keys: _editor/web/src/A.vue: sandbox.gone is in no catalog\nverify-turn: 1 finding(s) this change added against 7ffb812af";

interface Armed {
    readonly hooks: TurnCheckHooks;
    // Each command the hook ran, with the ceiling and repository it was run under.
    readonly ran: { readonly command: string; readonly timeoutMs: number; readonly repo: string | undefined }[];
    readonly fired: string[];
    readonly warn: ReturnType<typeof jest.fn>;
}

const armed = (
    answers: { readonly run?: EditCommandRun; readonly change?: () => Promise<TurnChange>; readonly rules?: readonly Rule[] } = {},
    isolated = true,
): Armed => {
    const ran: Armed["ran"] = [];
    const fired: string[] = [];
    const warn = jest.fn();
    const checks: TurnChecks = {
        rules: answers.rules ?? [TURN_CHECK!],
        change: answers.change ?? (async () => CHANGED),
        run: async (command, timeoutMs, repo) => {
            ran.push({ command, timeoutMs, repo });
            return answers.run ?? { status: "passed", output: "" };
        },
        onFired: (rule) => fired.push(rule.id),
        logger: { warn },
    };
    return { hooks: turnCheckHooks(checks, isolated), ran, fired, warn };
};

const STOP: StopHookInput = { hook_event_name: "Stop", session_id: "s1", transcript_path: "s1.jsonl", cwd: ".", stop_hook_active: false };

// Drives the hook the way the SDK does at Stop, and reads back what it said to the model.
const stop = async (hooks: TurnCheckHooks): Promise<string | undefined> => {
    const said = syncHookOutput(await hooks.Stop![0]!.hooks[0]!(STOP, "t", { signal: new AbortController().signal })).hookSpecificOutput;
    return said?.hookEventName === "Stop" ? said.additionalContext : undefined;
};

describe("turnCheckHooks", () => {
    it("says what a failing check printed, by its label and repository, once, and stamps it as fired", async () => {
        const { hooks, ran, fired } = armed({ run: { status: "failed", output: `${FOUND}\n` } });
        const note = await stop(hooks);
        expect(note).toBe(
            [
                "As this turn ends, the checks the repositories you changed declare for that moment ran once on your change, and attribute these findings to it:",
                `"${LABEL}" in intentic:\n${FOUND}`,
                "Fix the ones that are yours now, or say plainly why one is not. Nothing is refused, and this is said once.",
            ].join("\n\n"),
        );
        expect(ran).toEqual([{ command: VERIFY_TURN, timeoutMs: TURN_CHECK_CEILING_MS, repo: "intentic" }]);
        expect(fired).toEqual([TURN_CHECK!.id]);
        // The second Stop is the model's answer to the first, whatever it did; running again would make it a gate.
        expect(await stop(hooks)).toBeUndefined();
        expect(ran).toHaveLength(1);
    });

    it("says nothing for a check that passed, and does not run it again at a later Stop", async () => {
        const { hooks, ran, fired } = armed();
        expect(await stop(hooks)).toBeUndefined();
        expect(await stop(hooks)).toBeUndefined();
        expect(ran).toHaveLength(1);
        expect(fired).toEqual([]);
    });

    // A timeout or a command that never started measured nothing, so nobody is sent to repair the change for it.
    it("reports a check that did not finish as one that could not run, never as findings", async () => {
        const { hooks, fired } = armed({ run: { status: "error", output: "did not finish within 180s" } });
        expect(await stop(hooks)).toBe(
            [
                "As this turn ends, the checks the repositories you changed declare for that moment were to run once on your change, and could not:",
                `"${LABEL}" in intentic could not run (\`${VERIFY_TURN}\`): did not finish within 180s. That is not a verdict on the change.`,
                "Nothing is refused, and this is said once.",
            ].join("\n\n"),
        );
        expect(fired).toEqual([TURN_CHECK!.id]);
    });

    it("runs a check under its own timeout where that is shorter, and never past the Stop's ceiling", async () => {
        const quick = rulesOf(declarationOf("intentic", [{ when: "turn", run: "pnpm lint", timeoutMs: 60_000 }]));
        const { hooks, ran } = armed({ rules: [...quick, TURN_CHECK!] });
        await stop(hooks);
        expect(ran.map(({ timeoutMs }) => timeoutMs)).toEqual([60_000, TURN_CHECK_CEILING_MS]);
        // The SDK abandons a hook past its matcher's timeout, so that has to outlast every check the hook may wait on.
        expect(hooks.Stop![0]!.timeout! * 1000).toBeGreaterThan(2 * TURN_CHECK_CEILING_MS);
    });

    it("runs nothing for a repository the turn did not change, nor for a turn that changed nothing", async () => {
        const elsewhere = armed({ change: async () => ({ paths: ["notes/today.md"], repos: ["root"] }) });
        expect(await stop(elsewhere.hooks)).toBeUndefined();
        expect(elsewhere.ran).toEqual([]);
        const untouched = armed({ change: async () => ({ paths: [], repos: [] }) });
        expect(await stop(untouched.hooks)).toBeUndefined();
        expect(untouched.ran).toEqual([]);
    });

    // An owner's rule left at turn.ending from before the moment came back is selected out where the turn's rules are
    // chosen (harness-plan.ts), the same way here, so its command never runs.
    it("never runs an owner's rule left standing at turn.ending, only what a repository declared", async () => {
        const owners: Rule = { ...TURN_CHECK!, id: "my-turn-check", label: "Mine", action: { kind: "command", command: "rm -rf build", timeoutMs: 900_000 } };
        const rules = declaredChecks(standing(withRepoChecks([owners], [TURN_CHECK!]), "turn.ending"));
        const { hooks, ran } = armed({ rules });
        await stop(hooks);
        expect(ran.map(({ command }) => command)).toEqual([VERIFY_TURN]);
    });

    it("caps what rides back, keeping the end of what each check printed", () => {
        const output = `${"x".repeat(TURN_CHECK_OUTPUT_BYTES * 2)}\nthe summary line`;
        const note = turnChecksNote([{ rule: TURN_CHECK!, run: { status: "failed", output } }]);
        expect(note).toContain(`"${LABEL}" in intentic:\n…${output.slice(-TURN_CHECK_OUTPUT_BYTES)}\n\n`);
        expect(note).not.toContain(output.slice(0, TURN_CHECK_OUTPUT_BYTES + 1));
    });

    // Never a failed Stop: a check that cannot be run is no reason to keep the turn from ending.
    it("answers nothing and logs it when what the turn changed cannot be read", async () => {
        const { hooks, ran, warn } = armed({
            change: async () => {
                throw new Error("EACCES");
            },
        });
        expect(await stop(hooks)).toBeUndefined();
        expect(ran).toEqual([]);
        expect(warn).toHaveBeenCalledWith({ err: new Error("EACCES") }, "turn checks: could not run the repositories' turn checks, so the turn ends without them");
    });

    it("wires nothing for a turn in the shared tree, for no rules, or for no checks at all", () => {
        expect(armed({}, false).hooks).toEqual({});
        expect(armed({ rules: [] }).hooks).toEqual({});
        expect(turnCheckHooks(undefined, true)).toEqual({});
    });
});
