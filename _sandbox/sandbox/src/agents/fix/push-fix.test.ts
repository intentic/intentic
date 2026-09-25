import { type MainlinePush, pushFindingsFixBase, pushFixConversationId } from "@intentic/sandbox-contract";
import { pushFixBrief } from "./push-fix.js";

// What an agent handed a project's push findings opens on: it knows nothing else, so the words are the subject here.
// The linter's finding keeps the "- " bullet some checks print, as the hook reports it verbatim.
// Which conversation it lands in (continue, start over, busy) is fix-attempts.test.ts's.

const PUSHES: readonly MainlinePush[] = [
    {
        project: "app",
        id: "r2",
        at: 20,
        remote: "origin",
        branch: "main",
        head: "2222222aaaa",
        commits: 1,
        findings: [
            { id: "lint::x", kind: "lint", text: "- src/b.ts:4 no-unused-vars", command: "node _tools/oxlint/lint-edit.mjs src/b.ts", state: "open" },
        ],
    },
    { project: "lib", id: "q1", at: 15, head: "9999999", commits: 1, findings: [{ id: "lint::y", kind: "lint", text: "elsewhere", state: "open" }] },
    {
        project: "app",
        id: "r1",
        at: 10,
        remote: "origin",
        branch: "main",
        base: "0000000bbbb",
        head: "1111111cccc",
        commits: 2,
        findings: [
            {
                id: "check:silent-catch:a",
                kind: "check",
                check: "silent-catch",
                gate: "tidy",
                text: "src/a.ts:1 empty catch block",
                command: "node _tools/checks/run.mjs --only silent-catch",
                commit: { sha: "1111111cccc", subject: "feat: read the report" },
                state: "open",
            },
            {
                id: "check:paths:b",
                kind: "check",
                check: "paths",
                gate: "code",
                text: "docs/x.md links a missing file",
                command: "node _tools/checks/run.mjs --only paths",
                state: "open",
            },
            {
                id: "ratchet::c",
                kind: "ratchet",
                text: "src/a.test.ts: toEqual became toMatchObject",
                commit: { sha: "0aaaaaa1234", subject: "test: loosen the fixture" },
                state: "open",
            },
            { id: "check:paths:d", kind: "check", check: "paths", gate: "code", text: "gone already", state: "resolved", settledAt: 12 },
        ],
    },
];

describe("the brief a push-fix conversation opens on", () => {
    test("names the pushed ranges oldest first, then every open finding grouped by what printed it, code-gate checks first", () => {
        expect(pushFixBrief(PUSHES, "app")?.prompt).toBe(
            [
                "The push check in `app` let the findings below through. It only reports, so nothing blocked the push, and they still stand.",
                "What was pushed:\n- `0000000..1111111` to origin/main, 2 commits\n  - 1111111 feat: read the report\n  - 0aaaaaa test: loosen the fixture\n- `2222222` (the remote had nothing to compare it with) to origin/main, 1 commit",
                "What it found, by check:",
                "`paths`, which the tree fails whoever caused it:\n- docs/x.md links a missing file\n  `node _tools/checks/run.mjs --only paths`",
                "`silent-catch`, on lines the push added:\n- src/a.ts:1 empty catch block\n  `node _tools/checks/run.mjs --only silent-catch`",
                "The linter:\n- src/b.ts:4 no-unused-vars\n  `node _tools/oxlint/lint-edit.mjs src/b.ts`",
                "The assertion ratchet, on test files the pushed commits weakened:\n- src/a.test.ts: toEqual became toMatchObject",
                "Fix them in the code, and confirm each one by re-running the command next to it. The owner's Main line clears a finding once a measurement no longer prints it.",
                "Ratchet, lockstep and rustfmt findings concern commits that are already pushed, so their fix is a follow-up commit, and a ratchet finding may only need the test strengthened again.",
                "You are in an isolated worktree: commit your fix and it goes through review.",
            ].join("\n\n"),
        );
    });

    test("says nothing of already-pushed commits when every open finding can be measured again", () => {
        const measurable = PUSHES.map((push) => ({ ...push, findings: push.findings.filter((finding) => finding.kind !== "ratchet") }));

        expect(pushFixBrief(measurable, "app")?.prompt.includes("follow-up commit")).toBe(false);
    });

    test("nudges a continued attempt with what is still open, and is keyed by the oldest push still holding a finding", () => {
        const brief = pushFixBrief(PUSHES, "app");

        expect(brief?.nudge).toBe(
            [
                "What the push check let through in `app` is not all fixed yet, and this conversation is the attempt at it. Still open:",
                "- src/a.ts:1 empty catch block\n- docs/x.md links a missing file\n- src/a.test.ts: toEqual became toMatchObject\n- src/b.ts:4 no-unused-vars",
                "Carry on from where you left off, and confirm each one with the command next to it earlier in this conversation.",
            ].join("\n\n"),
        );
        expect(brief?.title).toBe("Fix what the push left: app");
        expect(brief?.base).toBe(pushFixConversationId("app", "left:1111111cccc"));
        expect(brief?.base).toBe(pushFindingsFixBase(PUSHES, "app"));
    });

    test("names the workspace root by what it is, and has nothing to hand over where nothing is open", () => {
        const root = PUSHES.map((push) => ({ ...push, project: push.project === "lib" ? "" : push.project }));

        expect(pushFixBrief(root, "")?.title).toBe("Fix what the push left: workspace");
        expect(pushFixBrief(root, "")?.prompt.startsWith("The push check in the workspace root let the findings below through.")).toBe(true);
        expect(pushFixBrief(PUSHES, "web")).toBeUndefined();
        expect(
            pushFixBrief(
                PUSHES.map((push) => ({ ...push, findings: push.findings.map((finding) => ({ ...finding, state: "dismissed" as const })) })),
                "app",
            ),
        ).toBeUndefined();
    });
});
