import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type CodebaseHealth, createResidentEngine, type ResidentEngine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";

const exec = promisify(execFile);

// The structured half of `hotspots` + `map`: the numbers the daemon serves to the codebase-health panel.
//
// The workspace ROOT is the repo under test here, and it is deliberately created the way the daemon creates it:
// `--separate-git-dir`, which leaves a `.git` POINTER FILE in the worktree rather than a directory. That is the
// shape the sweep used to miss, taking every git-backed verb (churn, hotspots, recent, log, who) with it.

const DAY_MS = 86_400_000;

let root: string;
let cleanup: () => Promise<void>;
let engine: ResidentEngine;

const commitRoot = async (message: string, paths: readonly string[], daysAgo: number): Promise<void> => {
    const when = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "root-author",
        GIT_AUTHOR_EMAIL: "root@example.com",
        GIT_COMMITTER_NAME: "root-author",
        GIT_COMMITTER_EMAIL: "root@example.com",
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
    };
    await exec("git", ["-C", root, "add", ...paths], { env });
    await exec("git", ["-C", root, "commit", "-q", "-m", message], { env });
};

// A root-repo file with branch points AND exports, so it can place in both rankings.
const gate = (arms: number): string =>
    `export const gate = (n: number): string => {\n${Array.from({ length: arms }, (_, i) => `    if (n === ${i}) {\n        return "arm-${i}";\n    }\n`).join("")}    return n > 0 && n < 10 ? "small" : "big";\n};\n`;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    // Separate git dir OUTSIDE the workspace: exactly the daemon's layout for /work, and it keeps the objects
    // out of the sweep.
    await exec("git", ["-C", root, "init", "-q", "--separate-git-dir", `${root}-gitdir`]);
    await writeFile(join(root, "gate.ts"), gate(3));
    await commitRoot("add the gate", ["gate.ts", "notes.md"], 30);
    await writeFile(join(root, "gate.ts"), gate(5));
    await commitRoot("widen the gate", ["gate.ts"], 0);
    engine = createResidentEngine({ root });
    await engine.warm();
});
afterAll(async () => {
    await engine.close();
    await cleanup();
});

test("a .git pointer file is a repo boundary: the workspace root's own churn reaches the hotspot ranking", async () => {
    const health = await engine.health({ scope: { repo: "" }, limit: 10 });
    const gateFile = health.hotspots.find((file) => file.path === "gate.ts");
    expect(gateFile).toMatchObject({ commits: 2 });
    expect(gateFile!.complexity).toBeGreaterThan(0);
    // The score IS the product: the panel plots it, so it must not be a rank in disguise.
    expect(gateFile!.score).toBe(gateFile!.commits * gateFile!.complexity);
    // notes.md is committed in the same repo but has no branch points, so it is not a hotspot.
    expect(health.hotspots.map((file) => file.path)).not.toContain("notes.md");
});

test("the churn window narrows the ranking without touching complexity", async () => {
    const recent = await engine.health({ scope: { repo: "" }, since: "7d", limit: 10 });
    const gateFile = recent.hotspots.find((file) => file.path === "gate.ts")!;
    expect(gateFile.commits).toBe(1); // the 30-day-old commit is outside the window
    expect(gateFile.score).toBe(gateFile.complexity);
});

test("scope picks ONE repo: a nested repo's hotspots and modules never mix with the root's", async () => {
    const alpha = await engine.health({ scope: { repo: "alpha" }, limit: 10 });
    expect(alpha.hotspots.length).toBeGreaterThan(0);
    expect(alpha.hotspots.every((file) => file.path.startsWith("alpha/"))).toBe(true);
    expect(alpha.modules.every((module) => module.path.startsWith("alpha/"))).toBe(true);
    // widget.ts is what the fixture's import graph points at, and it exports more than one symbol.
    const widget = alpha.modules.find((module) => module.path === "alpha/src/widget.ts");
    expect(widget?.exports).toBeGreaterThan(0);
    expect(alpha.totals.files).toBeGreaterThan(0);
    expect(alpha.totals.symbols).toBeGreaterThan(0);
    expect(alpha.totals.complexity).toBeGreaterThan(0);
});

test("totals count the whole scope while the lists stay capped", async () => {
    const capped = await engine.health({ scope: {}, limit: 1 });
    expect(capped.hotspots).toHaveLength(1);
    expect(capped.modules).toHaveLength(1);
    // The risk surface is a count of every qualifying file, not of the shown ones.
    expect(capped.totals.hotspots).toBeGreaterThan(1);
    // Unscoped totals cover both repos and the loose files, so they exceed any single repo's.
    const alpha = await engine.health({ scope: { repo: "alpha" }, limit: 1 });
    expect(capped.totals.files).toBeGreaterThan(alpha.totals.files);
});

test("resident health single-flights one full ranking and ref invalidation refreshes it", async () => {
    engine.invalidateHealth();
    const tracePath = join(root, "git-health-trace.log");
    const previousTrace = process.env["GIT_TRACE"];
    process.env["GIT_TRACE"] = tracePath;
    let short: CodebaseHealth;
    let full: CodebaseHealth;
    try {
        [short, full] = await Promise.all([engine.health({ scope: { repo: "" }, limit: 0 }), engine.health({ scope: { repo: "" }, limit: 10 })]);
    } finally {
        if (previousTrace === undefined) {
            delete process.env["GIT_TRACE"];
        } else {
            process.env["GIT_TRACE"] = previousTrace;
        }
    }

    const tracedLogs = (await readFile(tracePath, "utf8")).split("\n").filter((line) => line.includes("git log --numstat"));
    expect(tracedLogs).toHaveLength(1);
    expect(short.hotspots).toHaveLength(0);
    expect(full.hotspots.length).toBeGreaterThan(short.hotspots.length);

    const before = full.hotspots.find((file) => file.path === "gate.ts")!.commits;
    await writeFile(join(root, "gate.ts"), gate(6));
    await commitRoot("widen the gate again", ["gate.ts"], 0);
    // A commit moves refs without necessarily changing the indexed file set. Until that feed invalidates the
    // history cache, the old complete ranking is deliberately reused.
    expect((await engine.health({ scope: { repo: "" }, limit: 10 })).hotspots.find((file) => file.path === "gate.ts")?.commits).toBe(before);

    engine.invalidateHealth();
    expect((await engine.health({ scope: { repo: "" }, limit: 10 })).hotspots.find((file) => file.path === "gate.ts")?.commits).toBe(before + 1);
});
