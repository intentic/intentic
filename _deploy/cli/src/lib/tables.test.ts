import type { Step } from "@intentic/engine";
import { test, expect } from "bun:test";
import { planSummary, planTable, resourceTable, teardownTable } from "./tables.js";

const steps: Step[] = [
    { id: "host-1", type: "host", action: "create" },
    { id: "app-dns", type: "cf-route", action: "noop" },
    { id: "shop-web", type: "deployment", action: "update", reason: "image changed" },
];

test("planTable aligns the resource column regardless of how long the action or type is", () => {
    expect(planTable(steps)).toEqual([
        "ACTION  RESOURCE  TYPE        WHY",
        "create  host-1    host",
        "noop    app-dns   cf-route",
        "update  shop-web  deployment  image changed",
    ]);
});

test("planTable drops the WHY column when no step has a reason", () => {
    const [header] = planTable(steps.filter((step) => step.reason === undefined));
    expect(header).toBe("ACTION  RESOURCE  TYPE");
});

test("planTable says so rather than printing a bare header for an empty graph", () => {
    expect(planTable([])).toEqual(["The artifact declares no resources."]);
});

test("planSummary counts the actions and names the command that executes them", () => {
    expect(planSummary(steps, [])).toEqual(["", "3 resources: 1 to create, 1 to update, 1 unchanged. Run `intentic deploy apply` to execute."]);
});

// A first apply is all-create, and "12 resources: 12 to create" says the same number twice.
test("planSummary states one action covering everything as 'all', not as the total repeated", () => {
    const creates: Step[] = steps.map(({ id, type }) => ({ id, type, action: "create" }));
    expect(planSummary(creates, [])).toEqual(["", "3 resources, all to create. Run `intentic deploy apply` to execute."]);
});

// All-noop is the engine's success condition, and counting rows to discover it is what this line saves.
test("planSummary states that an all-noop plan is the converged state", () => {
    const converged = steps.map(({ id, type }): Step => ({ id, type, action: "noop" }));
    expect(planSummary(converged, [])).toEqual(["", "3 resources, all unchanged: state reads true, apply has nothing to do."]);
});

test("planSummary puts orphans in their own block, not in the action column", () => {
    expect(planSummary([], [{ id: "leftover-api", type: "deployment" }])).toEqual([
        "",
        "1 orphan on the host, not in the desired graph:",
        "  leftover-api  deployment",
        "Delete it with `intentic deploy apply --yes`, or declare it to keep it.",
    ]);
});

test("resourceTable labels every row with one verb", () => {
    expect(resourceTable("delete", [{ id: "leftover-api", type: "deployment" }])).toEqual([
        "ACTION  RESOURCE      TYPE",
        "delete  leftover-api  deployment",
    ]);
});

test("teardownTable separates a protected resource's count from the number that gets deleted", () => {
    expect(
        teardownTable([
            { id: "shop-web", type: "deployment", protected: false },
            { id: "host-1", type: "host", protected: true },
        ]),
    ).toEqual([
        "ACTION  RESOURCE  TYPE        NOTE",
        "delete  shop-web  deployment",
        "keep    host-1    host        protected",
        "",
        "Nothing was deleted, and 1 protected resource never will be.",
        "`intentic deploy destroy --yes` tears down the resource above. This cannot be undone.",
    ]);
});

test("teardownTable says there is nothing to delete when everything is protected", () => {
    const lines = teardownTable([{ id: "host-1", type: "host", protected: true }]);
    expect(lines.at(-1)).toBe("Every resource the artifact declares is protected: destroy has nothing to delete.");
});
