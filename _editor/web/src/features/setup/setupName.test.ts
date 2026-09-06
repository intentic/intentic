import { expect, test } from "vitest";
import { autoSandboxName } from "./setupName";

test("the first sandbox is named without a suffix: there is nothing to tell it apart from", () => {
    expect(autoSandboxName([])).toBe(`workspace`);
});

test("a second sandbox counts up rather than colliding", () => {
    expect(autoSandboxName([`workspace`])).toBe(`workspace-2`);
    expect(autoSandboxName([`workspace`, `workspace-2`])).toBe(`workspace-3`);
});

test("a freed name is reused, so the numbers don't run away from the list", () => {
    expect(autoSandboxName([`workspace`, `workspace-3`])).toBe(`workspace-2`);
    expect(autoSandboxName([`workspace-2`])).toBe(`workspace`);
});

test("names the user chose are just names: only a collision moves the counter", () => {
    expect(autoSandboxName([`work`, `staging`])).toBe(`workspace`);
    expect(autoSandboxName([`  Workspace `])).toBe(`workspace-2`);
});
