import { afterAll, beforeAll, expect, test } from "vitest";
import { makeFixtureWorkspace } from "../testing.js";
import { filterScope, langOf } from "./scan.js";
import { sweep } from "./scan.js";
import type { FileEntry } from "../types.js";

let root: string;
let cleanup: () => Promise<void>;
let entries: FileEntry[];

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    entries = await sweep(root, false);
});
afterAll(() => cleanup());

const paths = (): string[] => entries.map((entry) => entry.path);

test("sweep admits tracked-looking files and is path-sorted", () => {
    expect(paths()).toContain("alpha/src/widget.ts");
    expect(paths()).toContain("beta/app.py");
    expect(paths()).toContain("notes.md");
    expect(paths()).toEqual(paths().toSorted());
});

test("sweep enforces .gitignore + junk dirs (incl. .git) by default and always self-excludes the index dir", async () => {
    expect(paths()).not.toContain("alpha/dist/decoy.js"); // .gitignore layer
    expect(paths().some((path) => path.includes(".git/"))).toBe(false); // .git is a junk-ignored dir
    // No security floor: a non-gitignore'd secret is indexed like any other file (role-based gating comes later).
    expect(paths()).toContain(".env");
    expect(paths()).toContain(".env.example");
    expect(paths().some((path) => path.startsWith(".intentic/iq"))).toBe(false); // index self-exclusion

    const full = await sweep(root, true);
    const fullPaths = full.map((entry) => entry.path);
    expect(fullPaths).toContain("alpha/dist/decoy.js"); // --ignored lifts .gitignore + junk dirs…
    expect(fullPaths.some((path) => path.includes(".git/"))).toBe(true); // …including .git now
    expect(fullPaths.some((path) => path.startsWith(".intentic/iq"))).toBe(false); // …but never the index dir
});

test("sweep tags files with their enclosing git repo", () => {
    const widget = entries.find((entry) => entry.path === "alpha/src/widget.ts");
    expect(widget?.repo).toBe("alpha");
    const notes = entries.find((entry) => entry.path === "notes.md");
    expect(notes?.repo).toBeUndefined();
});

test("filterScope narrows by path, lang, glob, and file class", () => {
    expect(filterScope(entries, { paths: ["beta"] }).map((entry) => entry.path)).toEqual(["beta/app.py"]);
    expect(filterScope(entries, { langs: ["python"] }).map((entry) => entry.path)).toEqual(["beta/app.py"]);
    expect(filterScope(entries, { globs: ["**/*.ts"] }).every((entry) => entry.path.endsWith(".ts"))).toBe(true);
    expect(filterScope(entries, { notGlobs: ["**/*.ts"] }).some((entry) => entry.path.endsWith(".ts"))).toBe(false);
    expect(filterScope(entries, { only: "tests" }).map((entry) => entry.path)).toEqual(["alpha/src/widget.spec.ts"]);
    expect(filterScope(entries, { repo: "alpha" }).every((entry) => entry.path.startsWith("alpha/"))).toBe(true);
});

test("langOf maps extensions", () => {
    expect(langOf("a/b.ts")).toBe("ts");
    expect(langOf("a/b.py")).toBe("python");
    expect(langOf("a/b.unknown")).toBeUndefined();
});
