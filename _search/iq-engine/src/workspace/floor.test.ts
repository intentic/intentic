import { expect, test } from "vitest";
import { isIqDenied } from "./floor.js";

test("the floor denies the agent plane's own byproducts at any depth", () => {
    expect(isIqDenied(".intentic/cache/iq/index.db")).toBe(true);
    expect(isIqDenied(".intentic/auth/token.json")).toBe(true);
    expect(isIqDenied(".intentic/sessions/a.jsonl")).toBe(true);
    expect(isIqDenied("refs/nested-workspace/.intentic/cache/iq/index.db")).toBe(true); // a checkout that is itself a workspace
    // The manifests a user writes stay searchable — excluding all of .intentic/ would trade one blind spot for another.
    expect(isIqDenied(".intentic/settings.json")).toBe(false);
    expect(isIqDenied(".intentic/environment.Dockerfile")).toBe(false);
});

// The floor is what `--ignored` can never lift, so git metadata is deliberately NOT in it: `.git` is junk you
// may still want to browse as history (see workspace-ignore), and lifting it is a documented escape hatch.
test("the floor leaves git metadata to the liftable ignore layer", () => {
    expect(isIqDenied(".git")).toBe(false);
    expect(isIqDenied("intentic/.git")).toBe(false);
    expect(isIqDenied(".gitignore")).toBe(false);
});
