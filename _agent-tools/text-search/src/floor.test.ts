import { isStateDenied } from "./floor.js";

test("the floor denies the agent plane by default, at any depth", () => {
    expect(isStateDenied(".intentic/local/cache/derived/docs/terms.pdf.md")).toBe(true);
    expect(isStateDenied(".intentic/local/cache/code-counts.db")).toBe(true);
    expect(isStateDenied(".intentic/secrets/auth/token.json")).toBe(true);
    expect(isStateDenied(".intentic/records/sessions/claude/projects/-work/a.jsonl")).toBe(true);
    expect(isStateDenied("refs/nested-workspace/.intentic/local/cache/code-counts.db")).toBe(true); // a nested checkout that is itself a workspace
    // Machine ledgers and clones: denied by the default, not by name.
    expect(isStateDenied(".intentic/records/loops.json")).toBe(true);
    expect(isStateDenied(".intentic/records/chores/runs/2026-01-01.json")).toBe(true);
    expect(isStateDenied(".intentic/local/extensions/some-extension/src/index.ts")).toBe(true);
    expect(isStateDenied(".intentic/local/tmp/build.log")).toBe(true);
    // An unrecognized file gets the default: denied, not a free pass.
    expect(isStateDenied(".intentic/undeclared-tomorrow.json")).toBe(true);
});

test("the authored and versioned slice stays searchable: excluding all of .intentic/ would trade one blind spot for another", () => {
    expect(isStateDenied(".intentic")).toBe(false); // the walk must descend to reach the slice below
    expect(isStateDenied(".intentic/config/settings.json")).toBe(false);
    expect(isStateDenied(".intentic/config/environment.Dockerfile")).toBe(false);
    expect(isStateDenied(".intentic/config/environment.custom.Dockerfile")).toBe(false);
    expect(isStateDenied(".intentic/config/approvals/reddit-post.json")).toBe(false);
    expect(isStateDenied(".intentic/config/skills/my-skill/SKILL.md")).toBe(false);
    expect(isStateDenied(".intentic/config/docs/intentic/repo.md")).toBe(false);
    expect(isStateDenied(".intentic/config/workspace-extensions/my-ext/index.ts")).toBe(false);
    expect(isStateDenied(".intentic/config/automations.json")).toBe(false);
    // capabilities.json holds no tokens now (moved to the vault); auth/ is what actually holds the line.
    expect(isStateDenied(".intentic/config/capabilities.json")).toBe(false);
    expect(isStateDenied(".intentic/config/extension-settings.json")).toBe(false);
});

test("the floor leaves git metadata to the liftable ignore layer", () => {
    expect(isStateDenied(".git")).toBe(false);
    expect(isStateDenied("intentic/.git")).toBe(false);
    expect(isStateDenied(".gitignore")).toBe(false);
});
