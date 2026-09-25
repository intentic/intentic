import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOOD_DOWN_FILE } from "../../constants/src/test-suites.mjs";
import { requirementOf } from "./requires.js";

const never = (): void => {
    throw new Error("registered a test where none was due");
};

test("a met requirement runs and leaves the title alone", () => {
    const needs = requirementOf(true, "procps on PATH", { CI: "true" }, never);
    expect({ runs: needs.runs, title: needs.title("finds it") }).toEqual({ runs: true, title: "finds it" });
});

test("unmet on a developer's machine: stands down, says what is missing in the title", () => {
    const needs = requirementOf(false, "procps on PATH", { CI: "0" }, never);
    expect({ runs: needs.runs, title: needs.title("finds it") }).toEqual({ runs: false, title: "finds it (stood down: needs procps on PATH)" });
});

test("unmet on CI: a failing test naming the requirement is registered where it was asked", () => {
    const registered: { title: string; body: () => void }[] = [];
    const needs = requirementOf(false, "a built dist", { CI: "true" }, (title, body) => registered.push({ title, body }));
    expect(needs.runs).toBe(false);
    expect(registered.map(({ title }) => title)).toEqual(["requires a built dist"]);
    expect(registered[0]?.body).toThrow("this machine lacks a built dist, which CI provides on purpose");
});

test("each test that stands down is written for suites to count", () => {
    const dir = mkdtempSync(join(tmpdir(), "requires-"));
    try {
        const file = join(dir, "stood-down");
        const needs = requirementOf(false, "a built dist", { [STOOD_DOWN_FILE]: file }, never);
        needs.title("one");
        needs.title("two");
        expect(readFileSync(file, "utf8")).toBe("a built dist\tone\na built dist\ttwo\n");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
