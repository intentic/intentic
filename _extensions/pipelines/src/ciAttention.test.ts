import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { ciFixConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { CiOwnerStep, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { extensionIdOf } from "@intentic/extension-manifest";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { attentionBadge, inFlightNote } from "./ciAttention";
import { messages } from "./i18n";
import { manifest } from "./manifest";
import { agentCard } from "./testing";

// The broken branch's words are the extension's own catalog, which the host mounts before anything reads it.
await registerExtensionMessages(extensionIdOf(manifest), messages);

// The rail's other sentence: not "is this branch failing" (ciStreaks) but "is CI doing anything right now". It must count
// the way the board's own tally counts, or the tile and the header it opens would disagree about the same runs.

const run = (runId: number, status: PipelineRun["status"]): PipelineRun => ({
    repo: "intentic",
    host: "github",
    project: "intentic/intentic",
    runId,
    branch: "main",
    sha: `sha${runId}`,
    status,
    url: "u",
    createdAt: runId,
});

test("says nothing while every run has landed", () => {
    expect(inFlightNote([run(1, "success"), run(2, "failed"), run(3, "canceled")])).toBeUndefined();
    expect(inFlightNote([])).toBeUndefined();
});

test("counts running runs, in the board's own words", () => {
    expect(inFlightNote([run(1, "running"), run(2, "success")])).toBe("1 running");
    expect(inFlightNote([run(1, "running"), run(2, "running")])).toBe("2 running");
});

test("keeps queued out of the running count, and still reports it", () => {
    // The board makes the same split: nothing has picked the queued run up, so calling it running would be a claim
    // about a runner that hasn't started.
    expect(inFlightNote([run(1, "queued")])).toBe("1 queued");
    expect(inFlightNote([run(1, "running"), run(2, "queued"), run(3, "queued")])).toBe("1 running, 2 queued");
});

test("a broken branch does not silence it: the fix's own re-run is what the reader is waiting on", () => {
    expect(inFlightNote([run(1, "failed"), run(2, "running")])).toBe("1 running");
});

// THE TILE AS A WHOLE: what CI owes the reader is the count, and what needs nobody (a fix working, CI running) rides the
// running mark beside it rather than turning the tile red.
const feed = (runs: readonly PipelineRun[], agents: readonly AgentSummary[] = [], ownerSteps: CiOwnerStep[] = []) => ({
    ci: { repos: [], runs: [...runs], ownerSteps },
    agents,
});

describe(`attentionBadge`, () => {
    it(`stands down while nothing is broken or moving`, () => {
        expect(attentionBadge(feed([run(1, "success")]))).toBeUndefined();
        expect(attentionBadge(feed([]))).toBeUndefined();
    });

    it(`counts a failure nobody is on in the danger tone, and names it`, () => {
        expect(attentionBadge(feed([run(2, "failed")]))).toEqual({
            count: 1,
            tone: "danger",
            tooltip: "intentic main · failed, nobody is on it",
        });
    });

    it(`keeps the running mark beside the count, and alone once nothing is owed`, () => {
        expect(attentionBadge(feed([run(1, "failed"), run(2, "running")]))).toEqual({
            count: 1,
            tone: "danger",
            tooltip: "intentic main · failed, nobody is on it",
            running: "1 running",
        });
        expect(attentionBadge(feed([run(1, "running")]))).toEqual({ running: "1 running" });
    });

    it(`does not call the reader over a failure a fix agent is working`, () => {
        const failed = run(1, "failed");
        const working = agentCard(ciFixConversationId(failed.repo, failed.runId), { status: "running" });
        expect(attentionBadge(feed([failed], [working]))).toEqual({ running: "1 being fixed" });
    });

    it(`counts a landed fix as the reader's push, in the ordinary tone`, () => {
        const failed = run(1, "failed");
        const landed = agentCard(ciFixConversationId(failed.repo, failed.runId), { status: "landed" });
        expect(attentionBadge(feed([failed], [landed]))).toEqual({ count: 1, tone: "info", tooltip: "intentic main · fix landed: commit and push it" });
    });

    // 2026-11-12: release v1.413.0's webstore publish needed a field in the store's dashboard. The rail said "1 failed"
    // over a tag, and the board offered a third agent.
    it(`names a step outside the repository on a release, as a warning`, () => {
        const release = { ...run(1, "failed"), branch: "v1.413.0", workflow: "webstore publish" };
        const fixer = agentCard(ciFixConversationId(release.repo, release.runId), { status: "landed" });
        const step = { conversationId: fixer.id, step: "Fill the downloads justification in the dashboard.", at: 1 };
        expect(attentionBadge(feed([release], [fixer], [step]))).toEqual({
            count: 1,
            tone: "warning",
            tooltip: "intentic v1.413.0 · needs a step outside the repository",
        });
        expect(attentionBadge(feed([release], [fixer]))?.tooltip).toBe("intentic v1.413.0 · fix landed: release again to check it");
    });

    it(`counts only the open project's repositories, as the board shows them`, () => {
        expect(attentionBadge(feed([run(1, "failed")]), (repo) => repo !== "intentic")).toBeUndefined();
    });

    it(`says how many when several are owed`, () => {
        const other = { ...run(3, "failed"), branch: "feature" };
        expect(attentionBadge(feed([run(1, "failed"), other]))?.tooltip).toBe("2 CI failures need you");
    });
});
