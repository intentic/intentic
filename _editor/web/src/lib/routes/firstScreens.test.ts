import { HOME_PATH, rootLanding, sandboxEntry, sandboxLanding } from "./firstScreens";

// Home is the first screen; a sandbox's own first screen is its board. A guest keeps the one way in it has.

const MEMBER = { isGuest: false, homeOnly: false };
const GUEST = { isGuest: true, homeOnly: false };
const HOME_ONLY = { isGuest: true, homeOnly: true };

test(`the bare address opens Home, for the person and for a home-only guest`, () => {
    expect(rootLanding(MEMBER, false)).toBe(HOME_PATH);
    expect(rootLanding(HOME_ONLY, false)).toBe(HOME_PATH);
});

test(`a guest of a box still opens on its chat, the only screen it has there`, () => {
    expect(rootLanding(GUEST, false)).toBe(`/chat`);
});

test(`the Android app keeps opening on the board it draws itself`, () => {
    expect(rootLanding(MEMBER, true)).toBe(`/agents`);
    expect(rootLanding(GUEST, true)).toBe(`/chat`);
});

test(`entering a sandbox lands on its board, never back on Home`, () => {
    expect(sandboxLanding(MEMBER)).toBe(`/agents`);
    expect(sandboxLanding(GUEST)).toBe(`/chat`);
    expect(sandboxLanding(HOME_ONLY)).toBe(HOME_PATH);
});

test(`opening a sandbox returns to the screen it was left on, and to its board when it was left on none`, () => {
    expect(sandboxEntry(`/workspace/src/app.ts`, MEMBER)).toBe(`/workspace/src/app.ts`);
    expect(sandboxEntry(`/agents/a1?view=changes`, MEMBER)).toBe(`/agents/a1?view=changes`);
    expect(sandboxEntry(undefined, MEMBER)).toBe(`/agents`);
});

test.each([`/`, `/home`, `/home/box-1`, `/settings/appearance`, `/deleted-sandboxes`])(
    `%s is no screen of a sandbox, so opening one lands on its board`,
    (remembered) => expect(sandboxEntry(remembered, MEMBER)).toBe(`/agents`),
);
