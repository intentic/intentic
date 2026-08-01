import { basename } from "node:path";
import type { HookJSONOutput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { IsolatedAgent, PersistedAgent } from "./agents/agents-store.js";
import type { IsolationPlan, TurnIsolation } from "./agents/isolation.js";
import { overlaysDir } from "./agents/isolation.js";

/* Test-support seams shared across this package's suites. Not part of the build (tsconfig `exclude`, like
 * e2e-harness.ts), but IS type-checked — tsconfig.test.json puts it and every *.test.ts in one program.
 *
 * It exists because the same fake was being written out longhand in file after file: four copies of a
 * `TurnIsolation` here, six of a throwing API table over in _libs/providers. A copy cannot be updated when the
 * seam it stands in for grows a method, so each one quietly starts describing a daemon that no longer exists
 * — `planFor` kept returning `undefined` in all four copies for as long as it took someone to notice, which
 * the interface's own comment records as the bug that made isolation silently do nothing. One definition per
 * seam, and the compiler now says so at the definition instead of at a route three layers away.
 */

// Every method throws, named, until the test provides it. Use for a WIDE seam the code under test barely
// touches (37-method git, 22-field settings): enumerating no-ops for the other 35 is noise that says nothing,
// and it goes stale the moment the interface grows. What a test does provide is checked against T as usual;
// what it doesn't, fails loudly with the method's own name instead of as a bare 500 from the route.
// NoInfer: T comes from the seam being stood in for (the annotated target), never from the subset a test
// happens to provide — otherwise the stand-in silently narrows to exactly what was written and checks nothing.
export const unstubbed = <T extends object>(seam: string, provided: NoInfer<Partial<T>>): T =>
    new Proxy(provided as T, {
        get: (target, key) =>
            key in target
                ? target[key as keyof T]
                : () => {
                      throw new Error(`${seam}.${String(key)} was called, and this test did not stub it`);
                  },
    });

/* What a hook the daemon installs actually returns. `HookJSONOutput` is a union, and only its SYNCHRONOUS side
 * carries `hookSpecificOutput` — the field every hook suite here asserts on. Reading it off the union is what
 * the type checker refuses; saying which side is meant, and failing loudly if a hook ever answers with the
 * other one, is what the suites already assume.
 */
export const syncHookOutput = (output: HookJSONOutput): SyncHookJSONOutput => {
    if ("async" in output) {
        throw new Error("the hook answered in its async form, which carries no hookSpecificOutput");
    }
    return output;
};

/* A container without CAP_SYS_ADMIN — which is what every test runner gets, and what the worktree suites
 * assert the symlink-mirroring fallback against. `planFor` still answers: WHERE the worktree sits is a fact
 * about the layout, not about the kernel, and the redirect layer needs the same answer the mounts would have
 * used (isolation.ts, TurnIsolation.planFor).
 */
export const noIsolation = (root: string, historyRoot: string = "/history"): TurnIsolation => ({
    available: async () => false,
    planFor: async (worktree: string): Promise<IsolationPlan> => ({
        worktree,
        root,
        mirrors: [],
        overlays: overlaysDir(historyRoot, basename(worktree)),
    }),
});

/* One agent card, mid-life: a branch of its own, a turn's worth of counters at zero, nothing landed yet. It is
 * an IsolatedAgent rather than a PersistedAgent because every path that reads an agent's PLACEMENT (land, the
 * standings, origins) takes the branch-carrying subtype, and a fixture that returns the supertype only ever
 * type-checks by accident. `repos` is readonly: a ConversationWorktree hands its own back that way.
 */
export const isolatedAgent = (repos: readonly PersistedAgent["repos"][number][], overrides: Partial<IsolatedAgent> = {}): IsolatedAgent => {
    const id = overrides.id ?? "c1";
    return {
        id,
        branch: `agent/${id}`,
        title: "fix the thing",
        provider: "claude",
        harness: "native",
        repos: [...repos],
        status: "idle",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
};
