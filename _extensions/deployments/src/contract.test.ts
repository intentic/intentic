import { expect, test } from "vitest";
import { DeployOverviewResponseSchema } from "./contract";

// Pins that new response fields degrade gracefully for an older daemon: `repos` defaults to empty so a missing array
// doesn't break parsing, and `viewer` stays optional rather than defaulted, since its absence is itself informative.

test("an overview from a daemon that predates repo links parses, with no links rather than no board", () => {
    const older = { komodoUrl: "https://komodo.example.com", reachable: true, resources: [], servers: [], alerts: [] };
    const parsed = DeployOverviewResponseSchema.parse(older);
    expect(parsed.repos).toEqual([]);
    // The empty state relies on this being absent, not defaulted, to avoid a false claim of an empty Komodo.
    expect(parsed.viewer).toBeUndefined();
});

test("a board that did carry links keeps them, and garbage in them is still a failure", () => {
    const current = {
        komodoUrl: "https://komodo.example.com",
        reachable: true,
        viewer: { username: "intentic", admin: false },
        repos: [{ repo: "app", projectName: "app", composePath: "app/compose.yaml", suggestions: ["app-prod"] }],
        resources: [],
        servers: [],
        alerts: [],
    };
    expect(DeployOverviewResponseSchema.parse(current).repos[0]?.suggestions).toEqual(["app-prod"]);
    // Tolerance covers absence only; a `repos` present with the wrong shape is a real validation failure.
    expect(DeployOverviewResponseSchema.safeParse({ ...current, repos: "none" }).success).toBe(false);
});
