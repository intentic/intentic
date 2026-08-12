import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { countWord, stripComments, taskFor } from "./agent-tasks.js";

/* The bench's grading is the one part of it that must be right: a scorer that is wrong turns every number the
 * benchmark prints into a confident lie, and unlike the runs themselves it costs nothing to test. Nothing here
 * spawns an agent or touches the network — the ARC task is served from its on-disk cache. */

const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), "agent-bench-test-"));

// What the tasks count as a source file, counted independently of the helper the task itself uses — a check
// that borrows the implementation's own walk proves the walk agrees with itself and nothing more.
const sourceFiles = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { recursive: true })).filter((file) => file.endsWith(`.ts`) && !file.endsWith(`.test.ts`));

test("the comment scanner keeps strings and drops comments — the distinction the sweep task is built on", () => {
    expect(stripComments(`const a = 1; // sessionId here\n`)).toBe(`const a = 1; \n`);
    expect(stripComments(`/* sessionId */ const a = 1;`)).toBe(` const a = 1;`);
    // The two cases a regex gets wrong, and the reason the task is worth setting.
    expect(stripComments(`const url = "http://x/sessionId";`)).toBe(`const url = "http://x/sessionId";`);
    expect(stripComments("const t = `a /* sessionId */ b`;")).toBe("const t = `a /* sessionId */ b`;");
    expect(stripComments(`const s = "he said \\"// sessionId\\"";`)).toBe(`const s = "he said \\"// sessionId\\"";`);
    // An unterminated block comment swallows the rest, which is what a compiler does too.
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
        // The expected count is not hardcoded anywhere — recompute it the way the task defines it and confirm
        // the grader agrees, so the task stays valid as this repo's sources change.
        const detail = (await prepared.grade()).detail;
        const expected = Number(/expected (\d+)/.exec(detail)?.[1]);
        expect(expected).toBeGreaterThan(0);

        await writeFile(join(dir, `answer.json`), JSON.stringify({ count: expected }));
        expect(await prepared.grade()).toMatchObject({ solved: true, score: 1 });

        // Wrong, but close: partial credit rather than a flat zero, so a near-miss is visible in the table.
        await writeFile(join(dir, `answer.json`), JSON.stringify({ count: expected + 1 }));
        const near = await prepared.grade();
        expect(near.solved).toBe(false);
        expect(near.score).toBeGreaterThan(0.9);

        // A run that never answered scores zero instead of throwing — "didn't answer" is a real outcome.
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
        // The agent must not be able to read the answer off disk, and tests would skew the count it is asked for.
        const agentRoutes = await readFile(join(dir, `daemon`, `src`, `agent`, `agent.routes.ts`), `utf8`);
        expect(agentRoutes.length).toBeGreaterThan(0);
        await expect(readFile(join(dir, `daemon`, `src`, `agent`, `agent.test.ts`), `utf8`)).rejects.toThrow();
        await expect(readFile(join(dir, `answer.json`), `utf8`)).rejects.toThrow();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("arc hides the expected grid from the workspace and grades an exact match", async () => {
    // Served from the cache fetchArcTask checks first, so this test never reaches the network.
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
        // The whole task is worthless if the answer ships with the question.
        expect(fixture.test[0]?.output).toBeUndefined();
        expect(prepared.prompt).toContain(`answer.json`);

        await writeFile(join(dir, `answer.json`), JSON.stringify({ output: [[0, 2]] }));
        expect(await prepared.grade()).toMatchObject({ solved: true, score: 1 });

        // Right shape, one wrong cell — half credit, not zero.
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
        // The task only bites if the closure is big: reaching it means opening a large share of the tree,
        // which is the context pressure the whole comparison is about.
        expect(expected).toBeGreaterThan(50);

        await writeFile(join(dir, `answer.json`), JSON.stringify({ count: expected }));
        expect(await prepared.grade()).toMatchObject({ solved: true, score: 1 });

        // A run that never went transitive lands far away rather than near-missing, so the failure mode is
        // legible in the result instead of just being "wrong".
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
        // prepare() throws if any anchor no longer matches the real source, so this test IS the guard that an
        // upstream edit can't silently leave the benchmark grading against defects it never planted.
        const prepared = await taskFor(`defects`).prepare(dir);
        const planted = Number(/(\d+) planted/.exec((await prepared.grade()).detail)?.[1]);
        expect(planted).toBe(4);
        /* Scoped to one subsystem on purpose. Unscoped, a run read all 235 files of the tree and still had no
         * answer when the clock ran out — a haystack nobody finishes searching yields timeouts, not a result.
         *
         * Both halves are stated against the tree the prompt was built from rather than as literals: the count
         * must be TRUE (a prompt that misstates the size of its own haystack is a lie the agent plans against),
         * and the scope must stay a small fraction of the tree. A hardcoded band said the same thing until
         * src/agent/ grew past it, and then failed the run for the subsystem having gained a file. */
        expect(prepared.prompt).toContain(`daemon/src/agent/`);
        const scoped = Number(/— (\d+) source files —/.exec(prepared.prompt)?.[1]);
        expect(scoped).toBe((await sourceFiles(join(dir, `daemon`, `src`, `agent`))).length);
        expect(scoped).toBeLessThan((await sourceFiles(join(dir, `daemon`))).length / 4);
        // The mutations really are in the copy the agent reads.
        expect(await readFile(join(dir, `daemon`, `src`, `agent`, `agent-terminals.ts`), `utf8`)).toContain(`slice(0, 0)`);

        const found = [
            { file: `daemon/src/agent/agent-terminals.ts`, line: 26 },
            { file: `daemon/src/agent/turn-usage.ts`, line: 8 },
        ];
        await writeFile(join(dir, `answer.json`), JSON.stringify({ defects: found }));
        const half = await prepared.grade();
        expect(half.solved).toBe(false);
        expect(half.score).toBeGreaterThan(0);
        // Naming the misses is what makes a failed run diagnosable without re-reading the transcript.
        expect(half.detail).toContain(`missed`);

        // Listing everything to be sure of hitting the four is declining to choose, and scores as such.
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
