import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A root test run cannot provoke EACCES or EIO, so the walk's two reads lie for exactly the paths named below and tell
// the truth everywhere else. The originals are held first: the mock must never call back into itself.
const realReaddir = fsPromises.readdir;
const realStat = fsPromises.stat;
const failing = (code: string, path: string): Promise<never> => Promise.reject(Object.assign(new Error(`${code}: ${path}`), { code }));
jest.mock("node:fs/promises", () => ({
    ...fsPromises,
    readdir: (...args: Parameters<typeof realReaddir>) => {
        const dir = String(args[0]);
        if (dir.endsWith("/locked")) {
            return failing("EACCES", dir);
        }
        if (dir.endsWith("/vanished")) {
            return failing("ENOENT", dir);
        }
        return realReaddir(...args);
    },
    stat: (...args: Parameters<typeof realStat>) => (String(args[0]).endsWith("/flaky.ts") ? failing("EIO", String(args[0])) : realStat(...args)),
}));

const { sweep } = await import("./scan.js");
const { createEngine } = await import("../index.js");

let root: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "iq-sweep-unreadable-"));
    for (const path of ["ok.ts", "locked/secret.ts", "vanished/gone.ts", "src/flaky.ts", "src/fine.ts"]) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), "export const x = 1;\n");
    }
});
afterAll(() => rm(root, { recursive: true, force: true }));

test("a path that fails to read is named with its code; one that vanished mid-walk is a race, not a report", async () => {
    const { entries, unreadable } = await sweep(root, false);
    expect(entries.map((entry) => entry.path)).toEqual(["ok.ts", "src/fine.ts"]);
    expect(unreadable).toEqual(["locked (EACCES)", "src/flaky.ts (EIO)"]);
});

test("every answer names what it could not read, and counts itself as a floor", async () => {
    const outcome = await createEngine({ root }).run({
        verb: "files",
        query: "fine",
        scope: {},
        render: { budget: 1500 },
        options: {},
        echo: "files fine",
    });
    expect(outcome.result.groups.map((group) => group.path)).toEqual(["src/fine.ts"]);
    expect(outcome.result.note).toBe("unreadable, left out: locked (EACCES), src/flaky.ts (EIO)");
    expect(outcome.result.partial).toBe(true);
    expect(outcome.text).toContain("unreadable, left out: locked (EACCES), src/flaky.ts (EIO)");
});

test("an unreadable root fails the sweep instead of answering with an empty workspace", async () => {
    await expect(sweep(join(root, "locked"), false)).rejects.toThrow("EACCES");
});
