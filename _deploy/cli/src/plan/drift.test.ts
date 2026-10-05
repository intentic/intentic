import { driftReasons } from "./plan.command.js";

const clean = { steps: [{ action: "noop" }], orphans: [], unowned: [], pending: [], retired: [], scanSkipped: [] };

test("a converged plan with nothing to delete and nothing to settle is no drift", () => {
    expect(driftReasons(clean)).toEqual([]);
});

test("the drift check fails on anything apply would change or delete, and anything a person must settle", () => {
    expect(
        driftReasons({
            steps: [{ action: "noop" }, { action: "update" }, { action: "create" }],
            orphans: [{ id: "old", type: "postgres" }],
            unowned: [{ id: "legacy", type: "outline" }],
            pending: [{ id: "old-repo", type: "repo" }],
            retired: [
                { id: "host", address: "10.0.0.1", leftovers: [{ id: "forgejo", type: "forgejo" }], unowned: [] },
                { id: "host", address: "10.0.0.2", leftovers: [], unowned: [], error: "connect ECONNREFUSED" },
            ],
            scanSkipped: [{ source: "host", reason: "not reachable over SSH" }],
            baselineError: "not valid JSON",
        }),
    ).toEqual([
        "2 resources to create or update",
        "1 orphan",
        "1 unowned resource",
        "1 pending deletion",
        "1 leftover on retired hosts",
        "1 retired host not scanned",
        "the orphan scan missed 1 source",
        "the prune baseline cannot be read",
    ]);
});
