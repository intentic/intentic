import { expect, test } from "vitest";
import { REPO_ROLES, workspacePaths } from "./workspace.js";

test("workspacePaths lays each repo out under <root>/repositories/<role>", () => {
    const paths = workspacePaths("/work");
    expect(paths.root).toBe("/work");
    expect(paths.repositories).toBe("/work/repositories");
    expect(paths.repos).toEqual({
        intent: "/work/repositories/intent",
        "desired-state": "/work/repositories/desired-state",
        app: "/work/repositories/app",
    });
});

test("every declared repo role has a derived path", () => {
    const paths = workspacePaths("/work");
    for (const role of REPO_ROLES) {
        expect(typeof paths.repos[role]).toBe("string");
    }
});
