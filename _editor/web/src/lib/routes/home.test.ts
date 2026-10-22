import { isHomePath, masterRailAfter } from "./home";

// The master view's rail: worn on /home, kept on the person's own pages opened from there, and given back to the sandbox's
// rail by any page of a sandbox.

test("home paths are the master view, nothing else is", () => {
    expect(isHomePath(`/home`)).toBe(true);
    expect(isHomePath(`/home/box-1`)).toBe(true);
    expect(isHomePath(`/homework`)).toBe(false);
});

test("settings opened from the master view keep its rail; a sandbox's page gives it back", () => {
    expect(masterRailAfter(false, `/home`)).toBe(true);
    expect(masterRailAfter(true, `/settings/appearance`)).toBe(true);
    expect(masterRailAfter(true, `/settings`)).toBe(true);
    expect(masterRailAfter(false, `/settings`)).toBe(false);
    expect(masterRailAfter(true, `/workspace`)).toBe(false);
    expect(masterRailAfter(true, `/settingsx`)).toBe(false);
});
