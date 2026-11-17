import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { checkOutcome, classifyCommand, commandExitCode, createFrameLedger, createVerificationLedger } from "./agent-verification.js";

describe("command classification", () => {
    test.each([
        ["pnpm test", "test"],
        ["pnpm -C _shared/workspace-ignore test", "test"],
        ["./node_modules/.bin/vitest run src/a.test.ts", "test"],
        ["CI=1 npx vitest run", "test"],
        ["bun test src/a.test.ts", "test"],
        ["./node_modules/.bin/suites", "test"],
        ["./node_modules/.bin/tsgo --noEmit -p tsconfig.json", "typecheck"],
        ["pnpm oxlint --deny-warnings", "lint"],
        ["cargo test", "test"],
        ["go build ./...", "build"],
        ["cd _editor/web && pnpm typecheck", "typecheck"],
        ["pnpm verify", "test"],
        ["pnpm verify:turn", "test"],
        ["npm run verify", "test"],
        ["yarn verify:push", "test"],
        ["bun run verify", "test"],
        ["pnpm test:unit", "test"],
        ["pnpm turbo run typecheck test", "test"],
        ["turbo run test", "test"],
        ["turbo typecheck", "typecheck"],
        ["pnpm turbo run check --filter @intentic/sandbox", "lint"],
        ["turbo run build --filter=web", "build"],
        ["go test -v ./...", "test"],
        ["cargo test -V --lib", "test"],
    ] as const)("%s proves %s", (command, kind) => {
        expect(
            command
                .split(/(?:&&|\|\||;|\|)/)
                .map(classifyCommand)
                .find((k) => k !== undefined),
        ).toBe(kind);
    });

    test.each(["ls -la", "git status", "cat package.json", "echo test", "rm -rf dist"])("%s proves nothing", (command) => {
        expect(classifyCommand(command)).toBeUndefined();
    });

    // A tool asked about itself ran nothing; `bun test --help` once read as a passing test run.
    test.each([
        "bun test --help",
        "pnpm test --help",
        "vitest -h",
        "bun --version",
        "pnpm turbo run test --help",
        "tsc -v",
        "./node_modules/.bin/vitest -V",
        "pnpm verify:turn --help",
        "cargo --version",
    ])("%s asks rather than checks", (command) => {
        expect(classifyCommand(command)).toBeUndefined();
    });

    test("a turn that only looked the runner up has proved nothing", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand("which bun; bun --version; bun test --help | head", "passed", "--- [exit 0, 1s]");
        expect(ledger.standing()).toEqual({ state: "unproven", paths: ["/work/src/a.ts"], check: undefined });
    });

    // A script name means a check only behind a package manager or a task runner; bare, `test` is the shell builtin.
    test.each(["test -f package.json", "check", "npx test", "turbo run dev", "turbo run"])("%s is not a script run", (command) => {
        expect(classifyCommand(command)).toBeUndefined();
    });

    // Keys on command position, not a substring anywhere in the line, so `echo test` does not count as a test run.
    test("a check named only as an argument is not evidence", () => {
        expect(classifyCommand("echo test")).toBeUndefined();
        expect(classifyCommand("git commit -m 'add test'")).toBeUndefined();
    });
});

// Codex hands over every command as `/bin/bash -lc '…'`; read as the word `bash`, none of its checks ever counted.
describe("checks behind a shell wrapper", () => {
    test.each([
        ["/bin/bash -lc 'pnpm --filter @intentic/sandbox test agent-verification'", "pnpm --filter @intentic/sandbox test agent-verification"],
        [`bash -lc "cd /work/intentic && pnpm typecheck"`, "pnpm typecheck"],
        ["zsh -lc 'tsc --noEmit -p tsconfig.json'", "tsc --noEmit -p tsconfig.json"],
        [`sh -c 'eval "pnpm test"'`, "pnpm test"],
    ])("%s is a check, named by the script it runs", (command, check) => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand(command, "passed", "");
        expect(ledger.standing()).toEqual({ state: "verified", paths: ["/work/src/a.ts"], check });
    });

    test.each([
        "/bin/bash -lc 'cat package.json'",
        `bash -lc 'echo "pnpm test"'`,
        `bash -lc 'grep -n "pnpm test|tsc" notes.txt'`,
        "/bin/bash -lc 'pnpm test --help'",
    ])("%s proves nothing", (command) => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand(command, "passed", "");
        expect(ledger.standing().state).toBe("unproven");
    });

    test("a wrapped command alongside another is named by the script inside it", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand("cd /work && bash -lc 'pnpm test'", "passed", "");
        expect(ledger.standing().check).toBe("pnpm test");
    });
});

// The shinobi-society audit (2026-11-17): a card named a whole `cd … && cargo test … | tail` line, cut at 200
// characters, where the check was the one invocation in it.
describe("the part of a line named as the check", () => {
    test.each([
        ["cd crates/net && cargo test -p net 2>&1 | tail -40", "cargo test -p net"],
        ["pnpm lint && pnpm test", "pnpm test"],
        ["cd a && cargo test -p a; cd ../b && cargo test -p b", "cargo test -p a && cargo test -p b"],
        [`cd web && CI=1 pnpm exec suites "src/a b.test.ts" 2>&1 | grep -v noise`, "pnpm exec suites 'src/a b.test.ts'"],
        ["CI=1 npx vitest run", "CI=1 npx vitest run"],
    ])("%s is named %s", (command, check) => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand(command, "passed", "");
        expect(ledger.standing()).toEqual({ state: "verified", paths: ["/work/src/a.ts"], check });
    });
});

describe("the ledger", () => {
    test("a passing check after the last edit clears the verdict", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand("pnpm test", "passed", "");
        expect(ledger.verdict()).toBeUndefined();
    });

    test("a passing check BEFORE the last edit does not", () => {
        const ledger = createVerificationLedger();
        ledger.noteCommand("pnpm test", "passed", "");
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("a failing check is reported as the reason, distinct from never having checked", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand("pnpm test", "failed", "2 failed");
        const verdict = ledger.verdict();
        expect(verdict?.failed?.command).toBe("pnpm test");
        expect(verdict?.failed?.detail).toBe("2 failed");
    });

    test("editing only prose is not something a check can speak to", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/README.md`);
        ledger.noteEdit(`${WORKSPACE_ROOT}/CHANGELOG`);
        expect(ledger.verdict()).toBeUndefined();
    });

    test("a prose edit alongside a code edit still needs proof", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/README.md`);
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("the same file edited repeatedly is named once", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("a turn that edited nothing never asks for anything", () => {
        const ledger = createVerificationLedger();
        ledger.noteCommand("pnpm test", "failed", "broken");
        expect(ledger.verdict()).toBeUndefined();
    });

    test("prose is remembered as edited even though no check is asked for it", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/docs/intro.md`);
        expect(ledger.edited()).toEqual(["/work/docs/intro.md"]);
        expect(ledger.verdict()).toBeUndefined();
    });

    // "Last edit" means the last one a check could speak to; a README touch afterward does not reopen anything.
    test("a prose edit after a passing check does not reopen the verdict", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        ledger.noteCommand("pnpm test", "passed", "");
        ledger.noteEdit(`${WORKSPACE_ROOT}/README.md`);
        expect(ledger.verdict()).toBeUndefined();
    });
});

// Same ledger fed provider-normalized frames (agent/tool-calls.ts) instead of hook events, so a case proven here holds
// for any provider.
describe("the frame-fed ledger", () => {
    const editCall = (id: string, path: string, status: "completed" | "failed" = "completed"): AgentEvent => ({
        kind: "tool_call",
        id,
        name: "Edit",
        category: "edit",
        status,
        locations: [{ path }],
    });
    const shellCall = (id: string, command: string): AgentEvent => ({
        kind: "tool_call",
        id,
        name: "Bash",
        category: "execute",
        status: "in_progress",
        target: command,
    });
    const shellResult = (id: string, text: string, status: "completed" | "failed" = "completed"): AgentEvent => ({
        kind: "tool_call_update",
        id,
        status,
        content: [{ type: "text", text }],
    });

    test("edits with nothing after them are unproven, and name the files", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(editCall("2", `${WORKSPACE_ROOT}/src/b.ts`));
        expect(ledger.standing()).toEqual({ state: "unproven", paths: ["/work/src/a.ts", "/work/src/b.ts"], check: undefined });
    });

    test("a check that passes after the last edit verifies it, and says which check", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm test src/a.test.ts"));
        ledger.note(shellResult("2", "1 passed\n--- [exit 0, 2s]"));
        expect(ledger.standing()).toEqual({ state: "verified", paths: ["/work/src/a.ts"], check: "pnpm test src/a.test.ts" });
    });

    // Codex's shape: no exit footer, a wrapped command, and the call's own status carrying the exit code.
    test("a Codex command verifies by its status, named by the script it ran", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "/bin/bash -lc 'pnpm test src/a.test.ts'"));
        ledger.note(shellResult("2", "1 passed"));
        expect(ledger.standing()).toEqual({ state: "verified", paths: ["/work/src/a.ts"], check: "pnpm test src/a.test.ts" });
        ledger.note(editCall("3", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("4", "/bin/bash -lc 'pnpm test src/a.test.ts'"));
        ledger.note(shellResult("4", "1 failed", "failed"));
        expect(ledger.standing()).toEqual({ state: "failing", paths: ["/work/src/a.ts"], check: "pnpm test src/a.test.ts" });
    });

    // Order matters, and the frame stream is the only place that still preserves it across tool calls.
    test("a check before the last edit proves nothing about it", () => {
        const ledger = createFrameLedger();
        ledger.note(shellCall("1", "pnpm test"));
        ledger.note(shellResult("1", "--- [exit 0, 2s]"));
        ledger.note(editCall("2", `${WORKSPACE_ROOT}/src/a.ts`));
        expect(ledger.standing().state).toBe("unproven");
    });

    // Exit code outranks the tool's own status: a suite that printed failures but exited 1 is still a completed call.
    test("a suite that exits non-zero is failing, whatever the tool call says", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm test"));
        ledger.note(shellResult("2", "1 failed\n--- [exit 1, 4s]", "completed"));
        expect(ledger.standing()).toEqual({ state: "failing", paths: ["/work/src/a.ts"], check: "pnpm test" });
    });

    // A refused or failed edit is not work to prove; noted at its result, not when it opens, since PostToolUse only
    // fires for a call that ran.
    test("an edit that failed is not work to be proven", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`, "failed"));
        expect(ledger.standing().state).toBe("no-code");
    });

    // An ACP agent sends the change itself rather than the path it came from; reading only `locations` would miss it.
    test("an edit that carries only a structured diff still counts", () => {
        const ledger = createFrameLedger();
        ledger.note({
            kind: "tool_call",
            id: "1",
            name: "write",
            category: "edit",
            status: "completed",
            content: [{ type: "diff", path: `${WORKSPACE_ROOT}/src/a.ts`, newText: "next" }],
        });
        expect(ledger.standing().paths).toEqual(["/work/src/a.ts"]);
    });

    // Interim updates are snapshots of a running command, not its answer; only a terminal status settles one.
    test("a check still running is not evidence yet", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm test"));
        ledger.note({ kind: "tool_call_update", id: "2", status: "in_progress", content: [{ type: "text", text: "running…" }] });
        expect(ledger.standing().state).toBe("unproven");
    });

    // Reading a file is not editing one, and a turn that only read has nothing a check could speak to.
    test("frames that are neither an edit nor a check leave the ledger alone", () => {
        const ledger = createFrameLedger();
        ledger.note({ kind: "tool_call", id: "1", name: "Read", category: "read", status: "completed", locations: [{ path: "/work/src/a.ts" }] });
        ledger.note({ kind: "delta", text: "done" });
        expect(ledger.standing().state).toBe("no-code");
        expect(ledger.edited()).toEqual([]);
    });

    // F04: `pnpm vitest run | tail` with vitest missing exited 0 through the pipe; the footer says the first stage's
    // 127, and that is the check's own status.
    test("a masked pipeline whose check could not start is not a pass", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm vitest run | tail -5"));
        ledger.note(shellResult("2", "sh: 1: vitest: not found\n--- [exit 0 (pipeline: 127 0 — an earlier stage failed), 0s]"));
        expect(ledger.standing()).toEqual({ state: "unproven", paths: ["/work/src/a.ts"], check: undefined });
    });

    test("a masked pipeline whose check failed is failing, and a filter after it does not launder that", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm test 2>&1 | grep -v noise"));
        ledger.note(shellResult("2", "1 failed\n--- [exit 0 (pipeline: 1 0 — an earlier stage failed), 3s]"));
        expect(ledger.standing()).toEqual({ state: "failing", paths: ["/work/src/a.ts"], check: "pnpm test" });
    });

    // The shinobi-society audit: a passing `cargo test | grep FAILED | head` read as failing on grep's no-match 1.
    test("a filter stage that matched nothing does not fail the check before it", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.rs`));
        ledger.note(shellCall("2", `cargo test 2>&1 | grep -E "FAILED|panicked" | head -20`));
        ledger.note(shellResult("2", "--- [exit 0 (pipeline: 0 1 0 — an earlier stage failed), 9s]"));
        expect(ledger.standing()).toEqual({ state: "verified", paths: ["/work/src/a.rs"], check: "cargo test" });
    });

    // Devin (`devin acp`) reports a finished command as a completed call whose text ends "Exited with code N".
    test("a Devin command that exited 127 is not a pass, though the call completed", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/site/index.astro`));
        ledger.note(shellCall("2", "cd /work/site && pnpm --filter @app_/landing run typecheck"));
        ledger.note(shellResult("2", "bash: cd /work/site && pnpm --filter @app_/landing run typecheck: No such file or directory\nExited with code 127"));
        expect(ledger.standing()).toEqual({ state: "unproven", paths: ["/work/site/index.astro"], check: undefined });
    });

    test("an exit code the runtime reports as a number outranks the call's status", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "pnpm test"));
        ledger.note({ kind: "tool_call_update", id: "2", status: "completed", content: [{ type: "text", text: "2 failed" }], exitCode: 1 });
        expect(ledger.standing()).toEqual({ state: "failing", paths: ["/work/src/a.ts"], check: "pnpm test" });
    });

    test("a check the shell could not find is unproven, not failing and not verified", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "tsc --noEmit"));
        ledger.note(shellResult("2", "bash: tsc: command not found", "failed"));
        expect(ledger.standing()).toEqual({ state: "unproven", paths: ["/work/src/a.ts"], check: undefined });
        expect(ledger.verdict()).toEqual({ paths: ["/work/src/a.ts"], failed: undefined });
    });

    test("a check that could not start, then a genuine pass of it, is verified", () => {
        const ledger = createFrameLedger();
        ledger.note(editCall("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shellCall("2", "vitest run"));
        ledger.note(shellResult("2", "Exit code: 127"));
        ledger.note(shellCall("3", "pnpm test"));
        ledger.note(shellResult("3", "1 passed\n--- [exit 0, 2s]"));
        expect(ledger.standing()).toEqual({ state: "verified", paths: ["/work/src/a.ts"], check: "pnpm test" });
    });
});

// The schema's own words: verified only when the latest run of every kind of check after the last edit passed.
describe("standing over several checks", () => {
    const edited = () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit(`${WORKSPACE_ROOT}/src/a.ts`);
        return ledger;
    };

    test("a pass then a failure of the same check is failing", () => {
        const ledger = edited();
        ledger.noteCommand("pnpm test", "passed", "");
        ledger.noteCommand("pnpm test src/a.test.ts", "failed", "1 failed");
        expect(ledger.standing()).toEqual({ state: "failing", paths: ["/work/src/a.ts"], check: "pnpm test src/a.test.ts" });
        expect(ledger.verdict()?.failed?.detail).toBe("1 failed");
    });

    test("a failure then a pass of the same check is verified", () => {
        const ledger = edited();
        ledger.noteCommand("pnpm test", "failed", "1 failed");
        ledger.noteCommand("pnpm test", "passed", "");
        expect(ledger.standing()).toEqual({ state: "verified", paths: ["/work/src/a.ts"], check: "pnpm test" });
        expect(ledger.verdict()).toBeUndefined();
    });

    test("a failing typecheck is not cleared by a passing test after it", () => {
        const ledger = edited();
        ledger.noteCommand("pnpm typecheck", "failed", "TS2322");
        ledger.noteCommand("pnpm test", "passed", "");
        expect(ledger.standing()).toEqual({ state: "failing", paths: ["/work/src/a.ts"], check: "pnpm typecheck" });
    });

    test("every kind passing on its latest run is verified, named by the latest", () => {
        const ledger = edited();
        ledger.noteCommand("pnpm typecheck", "failed", "TS2322");
        ledger.noteCommand("pnpm typecheck", "passed", "");
        ledger.noteCommand("pnpm test", "passed", "");
        expect(ledger.standing()).toEqual({ state: "verified", paths: ["/work/src/a.ts"], check: "pnpm test" });
    });

    test("a pass of one kind does not stand in for another that could not start", () => {
        const ledger = edited();
        ledger.noteCommand("pnpm test", "passed", "");
        ledger.noteCommand("pnpm typecheck", "unstarted", "pnpm: command not found");
        expect(ledger.standing()).toEqual({ state: "unproven", paths: ["/work/src/a.ts"], check: undefined });
    });
});

describe("reading how a command exited", () => {
    test.each([
        ["1 passed\n--- [exit 0, 2s]", 0],
        ["--- [exit 1, 2s] 40 lines filtered to 3", 1],
        ["--- [exit 0 (pipeline: 127 0 — an earlier stage failed), 0s]", 127],
        ["--- [exit 0 (pipeline: 141 2 0 — an earlier stage failed), 0s]", 2],
        ["Exited with code 127", 127],
        ["output\nCommand exited with code 1", 1],
        ["Exit code: 2", 2],
        ["[exit status 3]", 3],
        ["done", undefined],
        ["✓ reports the child's exit code 1 to the caller", undefined],
    ] as const)("%j exited %p", (text, code) => {
        expect(commandExitCode(text)).toBe(code);
    });

    // grep and rg exit 1 when nothing matched: past the first stage that is the filter's answer, not a failure.
    test.each([
        ["cargo test 2>&1 | grep FAILED | head", "--- [exit 0 (pipeline: 0 1 0 — an earlier stage failed), 0s]", 0],
        ["pnpm test 2>&1 | grep FAIL", "--- [exit 1 (pipeline: 0 1 — the filter matched nothing), 0s]", 0],
        ["pnpm test 2>&1 | rg -n FAIL", "--- [exit 1 (pipeline: 0 1 — the filter matched nothing), 0s]", 0],
        ["bash -lc 'pnpm test | grep FAIL'", "--- [exit 1 (pipeline: 0 1 — the filter matched nothing), 0s]", 0],
        ["pnpm test 2>&1 | grep FAIL", "--- [exit 1 (pipeline: 1 1 — an earlier stage failed), 0s]", 1],
        ["cargo test 2>&1 | grep FAILED | head", "--- [exit 0 (pipeline: 101 1 0 — an earlier stage failed), 0s]", 101],
        ["grep -n TODO src/a.ts | head", "--- [exit 0 (pipeline: 1 0 — an earlier stage failed), 0s]", 1],
        ["pnpm test | sort | head", "--- [exit 0 (pipeline: 0 1 0 — an earlier stage failed), 0s]", 1],
        // Statuses of another length are not the last pipeline's: no stage is known to be a filter.
        ["pnpm test | grep FAIL | head; echo done", "--- [exit 0 (pipeline: 0 1 0 — an earlier stage failed), 0s]", 1],
        ["pnpm test 2>&1 | grep FAIL", "--- [exit 1, 0s]", 1],
    ] as const)("%s with %j exited %p", (command, text, code) => {
        expect(commandExitCode(text, command)).toBe(code);
    });

    test.each([
        [{ status: "completed", text: "ok" }, "passed"],
        [{ status: "failed", text: "boom" }, "failed"],
        [{ status: "completed", text: "", exitCode: 126 }, "unstarted"],
        [{ status: "completed", text: "sh: 1: vitest: not found" }, "unstarted"],
        [{ status: "failed", text: "bash: ./node_modules/.bin/tsc: No such file or directory" }, "unstarted"],
        [{ status: "failed", text: "Error: ENOENT: no such file or directory, open 'a.json'" }, "failed"],
        [{ status: "failed", text: "cat: fixtures/a.json: No such file or directory" }, "failed"],
        [{ status: "completed", text: "Exited with code 1" }, "failed"],
    ] as const)("%j is %s", (input, outcome) => {
        expect(checkOutcome(input)).toBe(outcome);
    });
});

// Three quarters of edits arrive as shell commands (`sed -i`, a heredoc rewrite); the ledger asks which files each one wrote.
describe("the frame-fed ledger with shell edits", () => {
    const shell = (id: string, command: string): AgentEvent => ({ kind: "tool_call", id, name: "Bash", category: "execute", status: "in_progress", target: command });
    const done = (id: string, text: string): AgentEvent => ({ kind: "tool_call_update", id, status: "completed", content: [{ type: "text", text }] });
    const edit = (id: string, path: string): AgentEvent => ({ kind: "tool_call", id, name: "Edit", category: "edit", status: "completed", locations: [{ path }] });
    // Writes per command, keyed by the moment the command started, as the tree would answer.
    const tree = (writes: Record<string, readonly string[]>) => {
        let clock = 0;
        const startedBy = new Map<number, string>();
        return {
            now: () => (clock += 1),
            name: (command: string) => startedBy.set(clock, command),
            edits: async (since: number) => writes[startedBy.get(since) ?? ""] ?? [],
        };
    };

    test("a shell edit with no check after it is unproven, and named", async () => {
        const fake = tree({ "sed -i s/a/b/ src/a.ts": [`${WORKSPACE_ROOT}/src/a.ts`] });
        const ledger = createFrameLedger(fake.edits, fake.now);
        ledger.note(shell("1", "sed -i s/a/b/ src/a.ts"));
        fake.name("sed -i s/a/b/ src/a.ts");
        ledger.note(done("1", ""));
        await ledger.settled();
        expect(ledger.standing()).toEqual({ state: "unproven", paths: ["/work/src/a.ts"], check: undefined });
    });

    test("an edit and its test in one command: the edit comes first, so the test proves it", async () => {
        const command = "python3 - <<'EOF'\nopen('src/a.ts','w').write('x')\nEOF\npnpm test src/a.test.ts";
        const fake = tree({ [command]: [`${WORKSPACE_ROOT}/src/a.ts`] });
        const ledger = createFrameLedger(fake.edits, fake.now);
        ledger.note(shell("1", command));
        fake.name(command);
        ledger.note(done("1", "1 passed\n--- [exit 0, 2s]"));
        await ledger.settled();
        expect(ledger.standing().state).toBe("verified");
    });

    test("a shell edit after the last passing check leaves the work unproven", async () => {
        const fake = tree({ "sed -i s/a/b/ src/a.ts": [`${WORKSPACE_ROOT}/src/a.ts`] });
        const ledger = createFrameLedger(fake.edits, fake.now);
        ledger.note(edit("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shell("2", "pnpm test src/a.test.ts"));
        ledger.note(done("2", "1 passed\n--- [exit 0, 2s]"));
        ledger.note(shell("3", "sed -i s/a/b/ src/a.ts"));
        fake.name("sed -i s/a/b/ src/a.ts");
        ledger.note(done("3", ""));
        await ledger.settled();
        expect(ledger.standing()).toEqual({ state: "unproven", paths: ["/work/src/a.ts"], check: undefined });
    });

    test("an edit call that settles while a command's scan is out still lands after that command", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const ledger = createFrameLedger(async () => {
            await gate;
            return [];
        });
        ledger.note(shell("1", "pnpm test src/a.test.ts"));
        ledger.note(done("1", "1 passed\n--- [exit 0, 2s]"));
        ledger.note(edit("2", `${WORKSPACE_ROOT}/src/a.ts`));
        release();
        await ledger.settled();
        expect(ledger.standing().state).toBe("unproven");
    });

    test("a scan that fails attributes nothing and still reads the command", async () => {
        const ledger = createFrameLedger(async () => {
            throw new Error("git is gone");
        });
        ledger.note(edit("1", `${WORKSPACE_ROOT}/src/a.ts`));
        ledger.note(shell("2", "pnpm test src/a.test.ts"));
        ledger.note(done("2", "1 passed\n--- [exit 0, 2s]"));
        await ledger.settled();
        expect(ledger.standing().state).toBe("verified");
    });
});
