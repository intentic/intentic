import { agentWordsOf, agentWordsRow, childReportPrompt, peerMessagePrompt, unspokenPromptRow } from "./agent-words.js";
import { watchWakePrompt } from "./watch-wake.js";

const peerTitled = (title: string | undefined): string => peerMessagePrompt({ from: "sharp-shale-htw8", title, message: "the sweep is done" });
const peer = (): string => peerTitled("Bun migration");

const report = (over: Partial<Parameters<typeof childReportPrompt>[0]> = {}): string =>
    childReportPrompt({
        child: "sub-x7",
        title: "Port the parser",
        failed: false,
        report: "Ported; 12 tests pass.",
        verification: undefined,
        ...over,
    });

describe("another agent's words", () => {
    // Composer and parser must stay one piece of knowledge.
    it("round-trips a peer's message back to its sender", () => {
        const prompt = peer();
        expect(agentWordsOf(prompt)).toEqual({ kind: "peer", from: "sharp-shale-htw8", title: "Bun migration", sent: prompt });
    });

    it("round-trips a child's report, finished or failed", () => {
        expect(agentWordsOf(report())).toMatchObject({ kind: "child", from: "sub-x7", title: "Port the parser" });
        expect(agentWordsOf(report()) ?? {}).not.toHaveProperty("failed");
        expect(agentWordsOf(report({ failed: true }))).toMatchObject({ kind: "child", failed: true });
    });

    it("reads a sender with no title, and a title that tried to break its line", () => {
        expect(agentWordsOf(peerTitled(undefined))).toMatchObject({ kind: "peer", from: "sharp-shale-htw8" });
        expect(agentWordsOf(peerTitled(undefined)) ?? {}).not.toHaveProperty("title");
        expect(agentWordsOf(peerTitled("two\nlines"))).toMatchObject({ title: "two lines" });
    });

    it("says what checked a child's work, and says nothing when nothing was seen", () => {
        expect(report({ verification: { state: "verified", check: "pnpm test parser" } })).toContain(
            "Verification: verified — a check passed after its last edit (`pnpm test parser`).",
        );
        expect(report({ verification: { state: "unproven" } })).toContain("Verification: unproven");
        expect(report()).not.toContain("Verification:");
    });

    it("never hands the parent an empty report as if it were one", () => {
        expect(report({ report: "  " })).toContain("(It ended without a closing report.)");
    });

    it("draws a notice naming whose words they are", () => {
        expect(agentWordsRow(peer())).toMatchObject({
            role: "notice",
            text: 'Message from another conversation: "Bun migration" (sharp-shale-htw8).',
        });
        expect(agentWordsRow(report({ failed: true }))?.text).toBe('Child agent "Port the parser" (sub-x7) failed.');
    });

    it("ignores every other prompt, so any reader can ask without checking first", () => {
        expect(agentWordsOf("fix the bug")).toBeUndefined();
        expect(agentWordsOf("Message from another conversation in this workspace: nobody")).toBeUndefined();
    });

    it("answers for wakes and other agents' words alike, and for nothing else", () => {
        const wake = watchWakePrompt({ outcome: "met", id: "watch-k3f9", note: "CI", elapsed: "3m", command: "true", exitCode: 0, output: "" });
        expect(unspokenPromptRow(wake)?.watchWake?.outcome).toBe("met");
        expect(unspokenPromptRow(peer())?.agentWords?.kind).toBe("peer");
        expect(unspokenPromptRow("fix the bug")).toBeUndefined();
    });
});
