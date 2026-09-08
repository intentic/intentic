// @vitest-environment jsdom
// Needs jsdom: reaching the app's real key builders pulls in composables that touch browser globals at import time. The
// rule is one predicate; what's pinned is that the three heavy reads actually carry the mark.
import { describe, expect, it } from "vitest";
import { mirrors, UNPERSISTED } from "./queryPersistence";
import { agentTranscriptKey } from "../features/chat/transcript/agentTranscript";
import { agentFileDiffKey } from "../features/agents/review/useAgentChanges";
import { changesKey, fileDiffKey } from "../features/workspace/changes/useChanges";

// The cache mirrors to disk whole, one clone per write, so an unmarked heavy entry taxes every other write and reads as
// random stuttering. A background loader now fills it unpredictably, worth testing rather than only commenting.

const keys = {
    workingDiff: fileDiffKey(`root`, `src/app.ts`, `unstaged`),
    agentDiff: agentFileDiffKey(`agent-1`, `root`, `src/app.ts`),
    transcript: agentTranscriptKey(`agent-1`),
    changes: changesKey(),
};

describe(`what may go to disk`, () => {
    it(`keeps a working-tree file diff out: two whole file texts, one per changed file`, () => {
        expect(keys.workingDiff).toContain(UNPERSISTED);
        expect(mirrors(keys.workingDiff)).toBe(false);
    });

    it(`keeps an agent's file diff out, on exactly the same terms`, () => {
        expect(keys.agentDiff).toContain(UNPERSISTED);
        expect(mirrors(keys.agentDiff)).toBe(false);
    });

    it(`keeps a conversation transcript out: it has a per-record store of its own`, () => {
        expect(keys.transcript).toContain(UNPERSISTED);
        expect(mirrors(keys.transcript)).toBe(false);
    });

    it(`still mirrors the small, shape-stable lists a reload has to paint from`, () => {
        expect(mirrors(keys.changes)).toBe(true);
        expect(mirrors([`workspace`, `tree`, `shared`, `sandbox-1`])).toBe(true);
    });

    it(`never mirrors a sandbox row, which carries the tunnel's connect token`, () => {
        expect(mirrors([`sandbox`, `list`])).toBe(false);
    });
});
