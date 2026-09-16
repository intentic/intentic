// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Needs jsdom: the stream router's import chain reaches the app's environment read at module eval.

vi.mock("../../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
vi.mock("../client/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
vi.mock("../client/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { AGENT_DIFF, AGENTS, GIT_CHANGES } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { registry } from "../../agents/fleet/useAgents-registry";
import { applySystemEvent, CHANGES_REFRESH_MS } from "./systemEvents";

// One roster entry mid-land; nothing below reads past its status.
const LANDING: AgentSummary = {
    id: `a1`,
    status: `landing`,
    title: `Rewrite the parser`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
};

// An agent's review measures its branch against this workspace's tree and history, neither of which moves with a sha. A
// commit is `refsChanged`, a discard is `workspaceChanged`; this wires that signal to the agents' reviews.

const SANDBOX = `sbx-1`;

// A key, or the predicate deciding one; narrowed to the one field vue-query's Query actually needs here.
type Match = { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean };
let filters: Match[];

beforeEach(() => {
    filters = [];
    // Fake, because the rescan is throttled at module scope: one test's window would otherwise swallow the next one's
    // leading call.
    vi.useFakeTimers();
    vi.spyOn(queryClient, `invalidateQueries`).mockImplementation(async (given) => {
        filters.push(((typeof given === `function` ? given() : given) ?? {}) as Match);
    });
});

afterEach(() => {
    // Drains the trailing run so the throttle's window is closed again, not merely abandoned mid-flight.
    vi.advanceTimersByTime(5_000);
    vi.useRealTimers();
    registry.value = [];
});

// Whether anything in the batch would drop this key, by whichever means it was filed under.
const reaches = (key: readonly unknown[]): boolean =>
    filters.some(
        (filter) =>
            filter.predicate?.({ queryKey: key }) === true ||
            (filter.queryKey !== undefined && filter.queryKey.every((part, index) => key[index] === part)),
    );

it(`refreshes every open agent review when a commit moves the refs`, () => {
    applySystemEvent({ kind: `refsChanged`, repos: [`root`] }, SANDBOX);

    // Accepting a landing changes every review's answer about those files, in this box and any cached other.
    expect(reaches(AGENT_DIFF.of(`a1`))).toBe(true);
    expect(reaches(AGENT_DIFF.ofSandbox(`sbx-laptop`, `a2`))).toBe(true);
    // The rows a review opens are filed under it, so they go with it rather than outliving their own list.
    expect(reaches([...AGENT_DIFF.of(`a1`), `file`, `root`, `src/app.ts`])).toBe(true);
    // The workspace's own review still refreshes, which is what this signal always did.
    expect(reaches(GIT_CHANGES.of())).toBe(true);
    // Transcripts don't refresh: a commit says nothing about what anyone said, and rereading one is expensive.
    expect(reaches(AGENTS.of(`a1`, `transcript`))).toBe(false);
});

// A land writes the tree file by file and moves refs as it goes, so it fires this signal repeatedly against a patch
// that is only half applied. Each pass is a full `git status` + per-row diff over every repo, competing for the very
// git subprocesses the land is queued on — the scan is thrown away, and it makes the land it interrupted slower.
it(`leaves the review alone while a land is applying`, () => {
    registry.value = [LANDING];

    applySystemEvent({ kind: `refsChanged`, repos: [`root`] }, SANDBOX);
    expect(reaches(GIT_CHANGES.of())).toBe(false);
    expect(reaches(AGENT_DIFF.of(`a1`))).toBe(false);

    // Bounded by the land itself: the throttle's own trailing run reads the tree once the lease has cleared, and
    // useChanges refetches on the same transition for a browser sitting on a quiet workspace.
    applySystemEvent({ kind: `refsChanged`, repos: [`root`] }, SANDBOX);
    registry.value = [];
    vi.advanceTimersByTime(CHANGES_REFRESH_MS);
    expect(reaches(GIT_CHANGES.of())).toBe(true);
});
