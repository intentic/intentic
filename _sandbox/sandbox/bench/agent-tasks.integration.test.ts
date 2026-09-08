import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { countWord, stripComments, taskFor } from "./agent-tasks.js";

// The bench's grading must be right, since a wrong scorer turns every printed number into a lie; nothing here spawns an
// agent or touches the network (ARC is served from its on-disk cache).

const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), "agent-bench-test-"));

// A file-counting walk independent of the task's own, so the check doesn't just confirm the task agrees with itself.
const sourceFiles = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { recursive: true })).filter((file) => file.endsWith(`.ts`) && !file.endsWith(`.test.ts`));

test("the comment scanner keeps strings and drops comments: the distinction the sweep task is built on", () => {
    expect(stripComments(`const a = 1; // sessionId here\n`)).toBe(`const a = 1; \n`);
    expect(stripComments(`/* sessionId */ const a = 1;`)).toBe(` const a = 1;`);
    // URL text, a template literal, and an escaped quote: three shapes a naive regex would break on.
    expect(stripComments(`const url = "http://x/sessionId";`)).toBe(`const url = "http://x/sessionId";`);
    expect(stripComments("const t = `a /* sessionId */ b`;")).toBe("const t = `a /* sessionId */ b`;");
    expect(stripComments(`const s = "he said \\"// sessionId\\"";`)).toBe(`const s = "he said \\"// sessionId\\"";`);
    // An unterminated block comment swallows the rest, matching what a compiler does.
    expect(stripComments(`const a = 1; /* sessionId`)).toBe(`const a = 1; `);
});

test("counting is whole-word and case-sensitive", () => {
    expect(countWord(`sessionId sessionId`, `sessionId`)).toBe(2);
    expect(countWord(`sessionIds mySessionId SessionId`, `sessionId`)).toBe(0);
    expect(countWord(`request.sessionId ?? sessionId`, `sessionId`)).toBe(2);
    expect(countWord(``, `sessionId`)).toBe(0);
});

test("sweep grades an exact integer, derived from the fixture the agent is looking at", async () => {
    const dir = await workspace();
    try {
        const prepared = await taskFor(`sweep`).prepare(dir);
        // Recomputed via the grader itself rather than hardcoded, so the test stays valid as the repo's sources change.
        const detail = (await prepared.grade()).detail;
        const expected = Number(/expected (\d+)/.exec(detail)?.[1]);
        expect(expected).toBeGreaterThan(0);

        await writeFile(join(dir, `answer.json`), JSON.stringify({ count: expected }));
        expect(await prepared.grade()).toMatchObject({ solved: true, score: 1 });

        // Close but wrong: partial credit, not a flat zero.
        await writeFile(join(dir, `answer.json`), JSON.stringify({ count: expected + 1 }));
        const near = await prepared.grade();
        expect(near.solved).toBe(false);
        expect(near.score).toBeGreaterThan(0.9);

        // A missing answer scores zero rather than throwing.
        await rm(join(dir, `answer.json`));
        const missing = await prepared.grade();
        expect(missing).toMatchObject({ solved: false, score: 0 });
        expect(missing.detail).toContain(`no answer.json`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("sweep's fixture is a copy that carries no test files and no answer", async () => {
    const dir = await workspace();
    try {
        await taskFor(`sweep`).prepare(dir);
        const entries = await readdir(join(dir, `daemon`));
        expect(entries).toEqual(expect.arrayContaining([`src`, `contract`]));
        // Test files and the answer itself must not be readable; only they would skew the count the agent is asked for.
        const agentRoutes = await readFile(join(dir, `daemon`, `src`, `agent`, `routes`, `agent.routes.ts`), `utf8`);
        expect(agentRoutes.length).toBeGreaterThan(0);
        await expect(readFile(join(dir, `daemon`, `src`, `agent`, `run`, `agent.test.ts`), `utf8`)).rejects.toThrow();
        await expect(readFile(join(dir, `answer.json`), `utf8`)).rejects.toThrow();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("arc hides the expected grid from the workspace and grades an exact match", async () => {
    // Served from the cache fetchArcTask checks first, so this never reaches the network.
    const id = `benchtest0`;
    const cache = join(tmpdir(), `intentic-arc-agi-2`);
    await mkdir(cache, { recursive: true });
    await writeFile(
        join(cache, `${id}.json`),
        JSON.stringify({
            train: [{ input: [[1, 0]], output: [[0, 1]] }],
            test: [{ input: [[2, 0]], output: [[0, 2]] }],
        }),
    );
    const dir = await workspace();
    try {
        const prepared = await taskFor(`arc:${id}`).prepare(dir);
        const fixture = JSON.parse(await readFile(join(dir, `task.json`), `utf8`)) as { test: { output?: unknown }[] };
        expect(fixture.test[0]?.output).toBeUndefined();
        expect(prepared.prompt).toContain(`answer.json`);

        await writeFile(join(dir, `answer.json`), JSON.stringify({ output: [[0, 2]] }));
        expect(await prepared.grade()).toMatchObject({ solved: true, score: 1 });

        // One wrong cell: half credit, not zero.
        await writeFile(join(dir, `answer.json`), JSON.stringify({ output: [[0, 9]] }));
        expect(await prepared.grade()).toMatchObject({ solved: false, score: 0.5 });

        // Wrong shape has no cell-wise correspondence at all.
        await writeFile(join(dir, `answer.json`), JSON.stringify({ output: [[0], [2]] }));
        expect(await prepared.grade()).toMatchObject({ solved: false, score: 0 });
    } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(join(cache, `${id}.json`), { force: true });
    }
});

test("deps grades the transitive closure, and answering from the entry file alone is visibly wrong", async () => {
    const dir = await workspace();
    try {
        const prepared = await taskFor(`deps`).prepare(dir);
        const expected = Number(/expected (\d+)/.exec((await prepared.grade()).detail)?.[1]);
        // Only meaningful if the closure is large enough to pressure context.
        expect(expected).toBeGreaterThan(50);

        await writeFile(join(dir, `answer.json`), JSON.stringify({ count: expected }));
        expect(await prepared.grade()).toMatchObject({ solved: true, score: 1 });

        // Missing the transitive closure lands far away, not a near miss.
        await writeFile(join(dir, `answer.json`), JSON.stringify({ count: 25 }));
        const shallow = await prepared.grade();
        expect(shallow.solved).toBe(false);
        expect(shallow.score).toBeLessThan(0.5);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("defects plants every anchor it grades against, and padding the answer is punished", async () => {
    const dir = await workspace();
    try {
        // prepare() throws if a planted anchor no longer matches source, guarding against silent drift.
        const prepared = await taskFor(`defects`).prepare(dir);
        const planted = Number(/(\d+) planted/.exec((await prepared.grade()).detail)?.[1]);
        expect(planted).toBe(4);
        // Checked against the tree itself, not a hardcoded band: a fixed number broke once the subsystem grew past it.
        expect(prepared.prompt).toContain(`daemon/src/agent/`);
        const scoped = Number(/(\d+) source files/.exec(prepared.prompt)?.[1]);
        expect(scoped).toBe((await sourceFiles(join(dir, `daemon`, `src`, `agent`))).length);
        expect(scoped).toBeLessThan((await sourceFiles(join(dir, `daemon`))).length / 4);
        expect(await readFile(join(dir, `daemon`, `src`, `agent`, `tools`, `agent-terminals.ts`), `utf8`)).toContain(`slice(0, 0)`);

        const found = [
            { file: `daemon/src/agent/tools/agent-terminals.ts`, line: 26 },
            { file: `daemon/src/agent/run/turn/turn-usage.ts`, line: 8 },
        ];
        await writeFile(join(dir, `answer.json`), JSON.stringify({ defects: found }));
        const half = await prepared.grade();
        expect(half.solved).toBe(false);
        expect(half.score).toBeGreaterThan(0);
        // Detail names what's missed, so a failed run is diagnosable without the transcript.
        expect(half.detail).toContain(`missed`);

        const padded = [...found, ...Array.from({ length: 20 }, (_, index) => ({ file: `daemon/src/app.ts`, line: index + 1 }))];
        await writeFile(join(dir, `answer.json`), JSON.stringify({ defects: padded }));
        expect((await prepared.grade()).score).toBeLessThan(half.score);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("an unknown task spec fails loudly rather than silently benchmarking nothing", () => {
    expect(() => taskFor(`nope`)).toThrow(/unknown task/);
});
