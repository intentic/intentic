import { expect, test } from "vitest";
import { resolveWithin } from "./workspace-files-paths.js";

test("resolveWithin returns the absolute path for a contained file", () => {
    expect(resolveWithin("/work/intent", "deploy.config.ts")).toBe("/work/intent/deploy.config.ts");
    expect(resolveWithin("/work/intent", "nested/file.ts")).toBe("/work/intent/nested/file.ts");
});

test("resolveWithin rejects the repo dir itself", () => {
    expect(resolveWithin("/work/intent", ".")).toBeUndefined();
    expect(resolveWithin("/work/intent", "")).toBeUndefined();
});

test("resolveWithin rejects paths that climb out of the repo", () => {
    expect(resolveWithin("/work/intent", "../desired-state/secret")).toBeUndefined();
    expect(resolveWithin("/work/intent", "../../etc/passwd")).toBeUndefined();
    expect(resolveWithin("/work/intent", "/etc/passwd")).toBeUndefined();
});

test("resolveWithin normalizes a contained path that uses ..", () => {
    expect(resolveWithin("/work/intent", "nested/../deploy.config.ts")).toBe("/work/intent/deploy.config.ts");
});
