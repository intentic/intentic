import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import { packageOf, pathOfUnit, suspectsOf } from "./land-breakage.js";

// Which land a breakage is charged to, read off the units the land verify reports (failure-units.mjs, land-tiers.mjs).

const land = (agentId: string): DependencyLandOrigin => ({
    kind: "land",
    agentId,
    branch: `agent/${agentId}`,
    repos: [{ repo: "intentic", from: "abc", dir: "" }],
});

test("every unit shape names the path it failed on", () => {
    expect(pathOfUnit("@intentic/web#test _editor/web/src/a.test.ts › outer > it")).toBe("_editor/web/src/a.test.ts");
    expect(pathOfUnit("@intentic/sandbox#typecheck _sandbox/sandbox/src/a.ts: TS2322 Type 'x'")).toBe("_sandbox/sandbox/src/a.ts");
    expect(pathOfUnit("lint _site/site/src/Footer.astro: import(no-duplicates) Duplicate")).toBe("_site/site/src/Footer.astro");
    expect(pathOfUnit("tidy layout: - _devices/machine: 3 colliding basename(s)")).toBe("_devices/machine");
    expect(pathOfUnit("rustfmt _sandbox/ic")).toBe("_sandbox/ic");
    expect(pathOfUnit("@intentic/web#test")).toBeUndefined();
    expect(packageOf("_editor/web/src/a.ts")).toBe("_editor/web");
});

test("of several lands, the one whose changes share a package with a failure is the one named", () => {
    const one = land("one");
    const two = land("two");
    const lands = [
        { land: one, paths: ["_editor/web/src/b.ts"] },
        { land: two, paths: ["_sandbox/sandbox/src/c.ts"] },
    ];
    expect(suspectsOf(["@intentic/sandbox#test _sandbox/sandbox/src/c.test.ts › x"], lands)).toEqual([two]);
    expect(suspectsOf(["lint _tools/x.mjs: r m"], lands)).toEqual([]);
    expect(suspectsOf(["@intentic/sandbox#test"], lands)).toEqual([one, two]);
});
