import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createEngine } from "../index.js";
import { makeFixtureWorkspace } from "../testing.js";
import type { QueryRequest } from "../types.js";

let root: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    // A source file with a raw NUL byte (as shipped in real repos by editor/codegen accidents): ripgrep treats
    // the whole file as binary, so the index is the only engine that can still see inside it.
    writeFileSync(join(root, "repositories/alpha/src/nul-file.ts"), "export const nulSeparated = (a: string): string => `${a}\u0000${a}`;\n");
});
afterAll(() => cleanup());

const request = (verb: QueryRequest["verb"], query: string): QueryRequest => ({
    verb,
    query,
    scope: {},
    render: { budget: 1200 },
    options: {},
    echo: `${verb} ${query}`,
});

test("a stray NUL byte does not void a file's symbols or chunks", async () => {
    const engine = createEngine({ root });
    const def = await engine.run(request("def", "nulSeparated"));
    expect(def.exitCode).toBe(0);
    expect(def.result.groups[0]?.path).toBe("repositories/alpha/src/nul-file.ts");

    const ask = await engine.run(request("ask", "nul separated string helper"));
    expect(ask.result.groups.some((group) => group.path === "repositories/alpha/src/nul-file.ts")).toBe(true);
});
