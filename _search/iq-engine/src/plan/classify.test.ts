import { expect, test } from "vitest";
import { classify } from "./classify.js";

test.each([
    ["src/workspace/scan.ts", "path"],
    ["**/*.test.ts", "path"],
    ["wkignore", "identifier"],
    ["createIgnoreScope", "identifier"],
    ["Widget.name", "identifier"],
    ["createSdkMcpServer\\(", "regex"],
    ["MAX_[A-Z_]+", "regex"],
    ["where do we enforce the secrets floor?", "natural"],
    ["how does the daemon expose tools", "natural"],
] as const)("classify(%s) = %s", (query, kind) => {
    expect(classify(query)).toBe(kind);
});
