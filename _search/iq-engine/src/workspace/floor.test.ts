import { expect, test } from "vitest";
import { isIqDenied } from "./floor.js";

test("the floor denies the agent plane by default, at any depth", () => {
    expect(isIqDenied(".intentic/cache/iq/index.db")).toBe(true);
    // The vector sidecar sits BESIDE cache/iq — the miss that showed a deny-list can't hold the line.
    expect(isIqDenied(".intentic/cache/iq-vectors.db")).toBe(true);
    expect(isIqDenied(".intentic/auth/token.json")).toBe(true);
    expect(isIqDenied(".intentic/sessions/claude/projects/-work/a.jsonl")).toBe(true);
    expect(isIqDenied("refs/nested-workspace/.intentic/cache/iq/index.db")).toBe(true); // a checkout that is itself a workspace
    // Machine ledgers and clones the old deny-list never named — denied by construction now.
    expect(isIqDenied(".intentic/loops.json")).toBe(true);
    expect(isIqDenied(".intentic/chores/runs/2026-01-01.json")).toBe(true);
    expect(isIqDenied(".intentic/extensions/some-extension/src/index.ts")).toBe(true);
    expect(isIqDenied(".intentic/tmp/build.log")).toBe(true);
    // A file the table has never heard of gets the default, not a free pass.
    expect(isIqDenied(".intentic/undeclared-tomorrow.json")).toBe(true);
});

test("the authored and versioned slice stays searchable — excluding all of .intentic/ would trade one blind spot for another", () => {
    expect(isIqDenied(".intentic")).toBe(false); // the walk must descend to reach the slice below
    expect(isIqDenied(".intentic/settings.json")).toBe(false);
    expect(isIqDenied(".intentic/environment.Dockerfile")).toBe(false);
    expect(isIqDenied(".intentic/environment.custom.Dockerfile")).toBe(false);
    expect(isIqDenied(".intentic/drafts/reddit-post.json")).toBe(false);
    expect(isIqDenied(".intentic/skills/my-skill/SKILL.md")).toBe(false);
    expect(isIqDenied(".intentic/docs/intentic/repo.md")).toBe(false);
    expect(isIqDenied(".intentic/workspace-extensions/my-ext/index.ts")).toBe(false);
    expect(isIqDenied(".intentic/automations.json")).toBe(false);
    /* THE ONE THAT CHANGED SIDES, and the assertion that says the guarantee did not. This used to be asserted in
     * the denied block above, on the grounds that the index must not copy capability tokens into search text. The
     * tokens left the file for the vault, so it is `versioned` now — searchable, findable, and reviewable — while
     * `auth/` (asserted denied above, and where both vaults live) is what actually holds the line. The floor moved
     * from hiding the file that held credentials to the file holding none. */
    expect(isIqDenied(".intentic/capabilities.json")).toBe(false);
    expect(isIqDenied(".intentic/extension-settings.json")).toBe(false);
});

// The floor is what `--ignored` can never lift, so git metadata is deliberately NOT in it: `.git` is junk you
// may still want to browse as history (see workspace-ignore), and lifting it is a documented escape hatch.
test("the floor leaves git metadata to the liftable ignore layer", () => {
    expect(isIqDenied(".git")).toBe(false);
    expect(isIqDenied("intentic/.git")).toBe(false);
    expect(isIqDenied(".gitignore")).toBe(false);
});
