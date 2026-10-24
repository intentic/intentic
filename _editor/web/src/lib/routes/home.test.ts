import { isAccountPath, isHomePath, masterRailAfter } from "./home";

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
    expect(masterRailAfter(true, `/deleted-sandboxes`)).toBe(true);
    expect(masterRailAfter(false, `/deleted-sandboxes`)).toBe(false);
    expect(masterRailAfter(true, `/workspace`)).toBe(false);
    expect(masterRailAfter(true, `/settingsx`)).toBe(false);
});

test.each([`/home`, `/home/box-1`, `/settings`, `/settings/appearance`, `/settings?plan=welcome`, `/settings/notifications#voice`, `/deleted-sandboxes`, `/deleted-sandboxes/`, `/deleted-sandboxes#deleted`])(
    `%s belongs to the account without needing a sandbox`,
    (path) => expect(isAccountPath(path)).toBe(true),
);

test.each([`/homework`, `/settingsx`, `/deleted-sandboxesx`, `/deleted-sandboxes/other`, `/workspace`, `/agents`, `/sandbox`, `/sandbox/agent`])(
    `%s is not an account page`,
    (path) => expect(isAccountPath(path)).toBe(false),
);
