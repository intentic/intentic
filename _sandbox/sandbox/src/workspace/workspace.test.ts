import { WORKSPACE_ROOT } from "@intentic/constants";
import { REPO_ROLES } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { workspacePaths } from "./workspace.js";

test("workspacePaths lays each role repo out directly under <root>", () => {
    const paths = workspacePaths(WORKSPACE_ROOT);
    expect(paths.root).toBe("/work");
    expect(paths.repos).toEqual({
        intent: "/work/intent",
        "desired-state": "/work/desired-state",
        app: "/work/app",
    });
});

test("every declared repo role has a derived path", () => {
    const paths = workspacePaths(WORKSPACE_ROOT);
    for (const role of REPO_ROLES) {
        expect(typeof paths.repos[role]).toBe("string");
    }
});
