// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

// Same edge the other stream-router tests cut: the import chain reaches the app's environment read at module
// eval, and jsdom plus these three mocks are the whole of what it wants (see filePush.test.ts).

vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
vi.mock("./sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import { AGENT_DIFF, AGENTS, GIT_CHANGES } from "../queryKeys";
import { queryClient } from "../queryPersistence";
import { applySystemEvent } from "./systemEvents";

/* THE EDGE THAT WAS MISSING, and the whole of why the agent review went stale after a landing was dealt with.
 *
 * An agent's review is not a reading of its branch: it is that branch measured against THIS workspace, which
 * files of it your tree is holding and which your history has taken (agents/agent-changes.ts presentInMain).
 * Both answers move when you commit or discard in the Changes panel, and NEITHER moves a sha, so nothing the
 * review was invalidated by could see it: the diff query is pull-only, refreshed by a land made in this browser
 * or by a change in the agent's own status, and accepting half a landing is neither. The panel kept its
 * pre-commit answer until something else happened to refetch it.
 *
 * A commit reaches here as `refsChanged`, a discard as `workspaceChanged`, and both already refreshed the
 * workspace's own review. This is that same signal reaching the agents'. */

const SANDBOX = `sbx-1`;

// A key, or the predicate that decides about one. The predicate is narrowed to the only thing any of ours
// reads: vue-query hands it a whole Query, and a test cannot build one of those.
type Match = { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean };
let filters: Match[];

beforeEach(() => {
    filters = [];
    vi.spyOn(queryClient, `invalidateQueries`).mockImplementation(async (given) => {
        filters.push(((typeof given === `function` ? given() : given) ?? {}) as Match);
    });
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

    // The user accepting a landing: their history now carries those files, so every review's answer about them
    // changed, in this box and in any other one this browser has cached.
    expect(reaches(AGENT_DIFF.of(`a1`))).toBe(true);
    expect(reaches(AGENT_DIFF.ofSandbox(`sbx-laptop`, `a2`))).toBe(true);
    // The rows a review opens are filed under it, so they go with it rather than outliving their own list.
    expect(reaches([...AGENT_DIFF.of(`a1`), `file`, `root`, `src/app.ts`])).toBe(true);
    // The workspace's own review still refreshes, which is what this signal always did.
    expect(reaches(GIT_CHANGES.of())).toBe(true);
    /* And the transcripts do NOT, which is why this is a predicate rather than the agent family's prefix: a
     * transcript is the most expensive read in the app and a commit says nothing about what anyone said. */
    expect(reaches(AGENTS.of(`a1`, `transcript`))).toBe(false);
});
