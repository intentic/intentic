import { expect, test } from "vitest";
import { DeployOverviewResponseSchema } from "./contract";

/* The deployments board crosses the same seam and learned it the hard way. `repos` (workspace repo → Komodo
 * stack links) shipped REQUIRED, and the first sandbox whose daemon predated it rendered
 * `Invalid input: expected array, received undefined at repos` instead of the board, a dead page, on the one
 * surface whose job is to say whether production is up, to hide a band of suggestions.
 *
 * `viewer` is the deliberate contrast: also added later, also absent from an older daemon, but OPTIONAL rather
 * than defaulted, because its absence is information. The empty state tells "the key can see nothing" apart
 * from "we could not tell", and defaulting it would have collapsed the two. */

test("an overview from a daemon that predates repo links parses, with no links rather than no board", () => {
    const older = { komodoUrl: "https://komodo.example.com", reachable: true, resources: [], servers: [], alerts: [] };
    const parsed = DeployOverviewResponseSchema.parse(older);
    expect(parsed.repos).toEqual([]);
    // Absent, NOT defaulted: the empty state reads this to avoid claiming an empty Komodo it cannot vouch for.
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
    // Tolerance is for absence, not for the wrong shape: a `repos` that is present and wrong is real drift.
    expect(DeployOverviewResponseSchema.safeParse({ ...current, repos: "none" }).success).toBe(false);
});
