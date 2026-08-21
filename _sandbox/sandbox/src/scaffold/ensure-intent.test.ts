import { describe, expect, test } from "vitest";
import { dependencySpec } from "./ensure-intent.js";

// The workspace is the unpublished 0.0.0 sentinel, so both deps must link to a bundled/workspace copy: never
// `~0.0.0` (unresolvable on npm). Asserting sdk resolves catches the regression that made the naive scaffold-
// relative link fail: the daemon bundles graph but not sdk unless both are declared direct deps of the sandbox.
describe("dependencySpec (version 0.0.0 in the workspace)", () => {
    test("links graph to a resolvable bundled/workspace copy", () => {
        expect(dependencySpec("@intentic/graph")).toMatch(/^link:.*[/\\]graph$/);
    });

    test("links sdk to a resolvable bundled/workspace copy", () => {
        expect(dependencySpec("@intentic/sdk")).toMatch(/^link:.*[/\\]sdk$/);
    });
});
