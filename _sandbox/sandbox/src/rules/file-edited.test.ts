import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { Rule } from "@intentic/sandbox-contract";
import { describe, expect, test, vi } from "vitest";
import { EDIT_COMMAND_CEILING_MS, type EditCommandRun, fileEditedReviewer } from "./file-edited.js";

const rule = (over: Partial<Rule> = {}): Rule => ({
    id: "lint-edit",
    label: "Lint the edit",
    moment: "file.edited",
    action: { kind: "command", command: "node lint.mjs {file}", timeoutMs: 900_000 },
    enabled: true,
    ...over,
});

// The third argument is the rule's own repository, undefined for a rule that names none: it runs where the turn is.
const runner = (answer: EditCommandRun) => vi.fn<(command: string, timeoutMs: number, repo?: string) => Promise<EditCommandRun>>(async () => answer);

describe("the file.edited moment", () => {
    test("no rule standing there is no reviewer at all, so a workspace without one pays nothing", () => {
        expect(fileEditedReviewer([rule({ moment: "turn.ending" })], { run: runner({ status: "passed", output: "" }) })).toBeUndefined();
        expect(fileEditedReviewer([rule({ enabled: false })], { run: runner({ status: "passed", output: "" }) })).toBeUndefined();
    });

    test("a passing command is silent, and the file is substituted for {file} as one quoted argument", async () => {
        const run = runner({ status: "passed", output: "clean" });
        const review = fileEditedReviewer([rule()], { run });
        expect(await review?.(`${WORKSPACE_ROOT}/intentic/src/a b.ts`, "this edit")).toBeUndefined();
        expect(run).toHaveBeenCalledWith(`node lint.mjs '${WORKSPACE_ROOT}/intentic/src/a b.ts'`, EDIT_COMMAND_CEILING_MS, undefined);
    });

    test("a failing command's output is the message, named by the rule and the file, and the rule is counted as fired", async () => {
        const fired: string[] = [];
        const review = fileEditedReviewer([rule()], {
            run: runner({ status: "failed", output: "src/a.ts:3:1 no-unused-vars\n" }),
            roots: [WORKSPACE_ROOT],
            onFired: (fired_) => fired.push(fired_.id),
        });
        const message = await review?.(`${WORKSPACE_ROOT}/intentic/src/a.ts`, "this command");
        expect(message).toBe(`"Lint the edit" on intentic/src/a.ts after this command:\nsrc/a.ts:3:1 no-unused-vars`);
        expect(fired).toEqual(["lint-edit"]);
    });

    test("a command that could not run is reported as that, never as a verdict on the file", async () => {
        const review = fileEditedReviewer([rule()], { run: runner({ status: "error", output: "did not finish within 60s" }) });
        const file = `${WORKSPACE_ROOT}/x.ts`;
        expect(await review?.(file, "this edit")).toBe(
            `"Lint the edit" could not run on ${file} after this edit (\`node lint.mjs {file}\`): did not finish within 60s. That is not a verdict on the file.`,
        );
    });

    test("the rule's path condition reads the workspace-relative name, whichever root the path came under", async () => {
        const run = runner({ status: "failed", output: "x" });
        const review = fileEditedReviewer([rule({ when: { paths: ["intentic/**"] } })], {
            run,
            roots: [`${HISTORY_ROOT}/worktrees/c`, WORKSPACE_ROOT],
        });
        expect(await review?.(`${HISTORY_ROOT}/worktrees/c/intentic/a.ts`, "this edit")).toContain("intentic/a.ts");
        expect(await review?.(`${WORKSPACE_ROOT}/intentic/b.ts`, "this edit")).toContain("intentic/b.ts");
        expect(await review?.(`${WORKSPACE_ROOT}/docs/c.md`, "this edit")).toBeUndefined();
        expect(run).toHaveBeenCalledTimes(2);
    });

    test("the command is handed the file's name where the command runs, and the ceiling caps the rule's own timeout", async () => {
        const run = runner({ status: "passed", output: "" });
        const review = fileEditedReviewer([rule({ action: { kind: "command", command: "check {file}", timeoutMs: 120_000 } })], {
            run,
            place: (file) => file.replace(`${WORKSPACE_ROOT}/`, `${HISTORY_ROOT}/worktrees/c/`),
        });
        await review?.(`${WORKSPACE_ROOT}/intentic/a.ts`, "this edit");
        expect(run).toHaveBeenCalledWith(`check '${HISTORY_ROOT}/worktrees/c/intentic/a.ts'`, EDIT_COMMAND_CEILING_MS, undefined);
    });

    // A rule aimed at a repository is about that repository at every moment, this one included — and the command runs
    // there, which is the whole reason the form offers it instead of leaving people to write `cd` into the command.
    test("a rule naming a repository only reviews files inside it, and says where to run", async () => {
        const run = runner({ status: "failed", output: "no" });
        const review = fileEditedReviewer([rule({ when: { repo: "intentic" } })], {
            run,
            roots: [WORKSPACE_ROOT],
            repos: async () => [`intentic`, `docs`],
        });
        expect(await review?.(`${WORKSPACE_ROOT}/docs/c.md`, "this edit")).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
        expect(await review?.(`${WORKSPACE_ROOT}/intentic/a.ts`, "this edit")).toContain("intentic/a.ts");
        expect(run).toHaveBeenCalledWith(`node lint.mjs '${WORKSPACE_ROOT}/intentic/a.ts'`, EDIT_COMMAND_CEILING_MS, `intentic`);
    });

    // Nothing can say which repository a file is in, so a rule that names one stays unmatched rather than firing
    // against a repository nobody confirmed.
    test("a rule naming a repository does not fire where the repositories are unknown", async () => {
        const run = runner({ status: "failed", output: "no" });
        const review = fileEditedReviewer([rule({ when: { repo: "intentic" } })], { run, roots: [WORKSPACE_ROOT] });
        expect(await review?.(`${WORKSPACE_ROOT}/intentic/a.ts`, "this edit")).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
    });

    test("several rules standing here contribute to one message, in the owner's order", async () => {
        const review = fileEditedReviewer([rule(), rule({ id: "bytes", label: "Bytes", action: { kind: "command", command: "bytes {file}", timeoutMs: 60_000 } })], {
            run: async (command) => ({ status: "failed", output: command.startsWith("bytes") ? "NUL at 3" : "unused import" }),
        });
        const file = `${WORKSPACE_ROOT}/a.ts`;
        const message = await review?.(file, "this edit");
        expect(message).toBe(`"Lint the edit" on ${file} after this edit:\nunused import\n\n"Bytes" on ${file} after this edit:\nNUL at 3`);
    });
});
