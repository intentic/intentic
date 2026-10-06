import { autoSandboxName } from "../sandboxName";

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

test("a project's sandbox is named after its folder, and counts up from it the same way", () => {
    expect(autoSandboxName([`workspace`], `My App`)).toBe(`My App`);
    expect(autoSandboxName([`my app`, `My App-2`], `My App`)).toBe(`My App-3`);
});

// The platform refuses a name past 60 characters, and a folder's name has no such ceiling.
test("a long folder name is cut to what the platform takes, room left for its number", () => {
    const long = `a`.repeat(70);
    expect(autoSandboxName([], long)).toBe(`a`.repeat(60));
    expect(autoSandboxName([`a`.repeat(60)], long)).toBe(`${`a`.repeat(58)}-2`);
});
