import { describe, expect, test } from "vitest";
import { classifyCommand, createVerificationLedger } from "./agent-verification.js";

describe("command classification", () => {
    test.each([
        ["pnpm test", "test"],
        ["pnpm -C _sandbox/workspace-ignore test", "test"],
        ["./node_modules/.bin/vitest run src/a.test.ts", "test"],
        ["CI=1 npx vitest run", "test"],
        ["./node_modules/.bin/tsgo --noEmit -p tsconfig.json", "typecheck"],
        ["pnpm oxlint --deny-warnings", "lint"],
        ["cargo test", "test"],
        ["go build ./...", "build"],
        ["cd _editor/web && pnpm typecheck", "typecheck"],
    ])("%s proves %s", (command, kind) => {
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

    // `echo test` must not read as a test run just because the word appears — the classifier keys on the
    // command position, not on a substring anywhere in the line.
    test("a check named only as an argument is not evidence", () => {
        expect(classifyCommand("echo test")).toBeUndefined();
        expect(classifyCommand("git commit -m 'add test'")).toBeUndefined();
    });
});

describe("the ledger", () => {
    test("a passing check after the last edit clears the verdict", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/src/a.ts");
        ledger.noteCommand("pnpm test", true, "");
        expect(ledger.verdict()).toBeUndefined();
    });

    // The ordering case the counter exists for: verifying and THEN editing leaves the edits unproven.
    test("a passing check BEFORE the last edit does not", () => {
        const ledger = createVerificationLedger();
        ledger.noteCommand("pnpm test", true, "");
        ledger.noteEdit("/work/src/a.ts");
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("a failing check is reported as the reason, distinct from never having checked", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/src/a.ts");
        ledger.noteCommand("pnpm test", false, "2 failed");
        const verdict = ledger.verdict();
        expect(verdict?.failed?.command).toBe("pnpm test");
        expect(verdict?.failed?.detail).toBe("2 failed");
    });

    test("editing only prose is not something a check can speak to", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/README.md");
        ledger.noteEdit("/work/CHANGELOG");
        expect(ledger.verdict()).toBeUndefined();
    });

    test("a prose edit alongside a code edit still needs proof", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/README.md");
        ledger.noteEdit("/work/src/a.ts");
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("the same file edited repeatedly is named once", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/src/a.ts");
        ledger.noteEdit("/work/src/a.ts");
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("a turn that edited nothing never asks for anything", () => {
        const ledger = createVerificationLedger();
        ledger.noteCommand("pnpm test", false, "broken");
        expect(ledger.verdict()).toBeUndefined();
    });

    /* The two readers want different answers from the same record, and conflating them broke a real case: a
     * rule narrowed to `docs/**` could never fire, because the ledger had discarded the docs edit at the door
     * before any condition could see it. Nothing asks for proof of a README; nothing pretends it wasn't
     * written. */
    test("prose is remembered as edited even though no check is asked for it", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/docs/intro.md");
        expect(ledger.edited()).toEqual(["/work/docs/intro.md"]);
        expect(ledger.verdict()).toBeUndefined();
    });

    // The ordering question is about the last edit a check could SPEAK to: touching a README after a green
    // suite has not invalidated it.
    test("a prose edit after a passing check does not reopen the verdict", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/src/a.ts");
        ledger.noteCommand("pnpm test", true, "");
        ledger.noteEdit("/work/README.md");
        expect(ledger.verdict()).toBeUndefined();
    });
});
