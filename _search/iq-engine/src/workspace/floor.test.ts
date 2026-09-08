import { expect, test } from "vitest";
import { isIqDenied } from "./floor.js";

test("the floor denies the agent plane by default, at any depth", () => {
    expect(isIqDenied(".intentic/local/cache/iq/index.db")).toBe(true);
    // The vector sidecar sits beside cache/iq, not nested under it.
    expect(isIqDenied(".intentic/local/cache/iq-vectors.db")).toBe(true);
    expect(isIqDenied(".intentic/secrets/auth/token.json")).toBe(true);
    expect(isIqDenied(".intentic/records/sessions/claude/projects/-work/a.jsonl")).toBe(true);
    expect(isIqDenied("refs/nested-workspace/.intentic/local/cache/iq/index.db")).toBe(true); // a nested checkout that is itself a workspace
    // Machine ledgers and clones: denied by the default, not by name.
    expect(isIqDenied(".intentic/records/loops.json")).toBe(true);
    expect(isIqDenied(".intentic/records/chores/runs/2026-01-01.json")).toBe(true);
    expect(isIqDenied(".intentic/local/extensions/some-extension/src/index.ts")).toBe(true);
    expect(isIqDenied(".intentic/local/tmp/build.log")).toBe(true);
    // An unrecognized file gets the default: denied, not a free pass.
    expect(isIqDenied(".intentic/undeclared-tomorrow.json")).toBe(true);
});

test("the authored and versioned slice stays searchable: excluding all of .intentic/ would trade one blind spot for another", () => {
    expect(isIqDenied(".intentic")).toBe(false); // the walk must descend to reach the slice below
    expect(isIqDenied(".intentic/config/settings.json")).toBe(false);
    expect(isIqDenied(".intentic/config/environment.Dockerfile")).toBe(false);
    expect(isIqDenied(".intentic/config/environment.custom.Dockerfile")).toBe(false);
    expect(isIqDenied(".intentic/config/approvals/reddit-post.json")).toBe(false);
    expect(isIqDenied(".intentic/config/skills/my-skill/SKILL.md")).toBe(false);
    expect(isIqDenied(".intentic/config/docs/intentic/repo.md")).toBe(false);
    expect(isIqDenied(".intentic/config/workspace-extensions/my-ext/index.ts")).toBe(false);
    expect(isIqDenied(".intentic/config/automations.json")).toBe(false);
    // capabilities.json holds no tokens now (moved to the vault); auth/ is what actually holds the line.
    expect(isIqDenied(".intentic/config/capabilities.json")).toBe(false);
    expect(isIqDenied(".intentic/config/extension-settings.json")).toBe(false);
});

test("the floor leaves git metadata to the liftable ignore layer", () => {
    expect(isIqDenied(".git")).toBe(false);
    expect(isIqDenied("intentic/.git")).toBe(false);
    expect(isIqDenied(".gitignore")).toBe(false);
});
