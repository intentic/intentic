import { homePath, insidePath, page } from "@intentic/sandbox-contract/app-routes";
import { HOME_PATH, insideScreen, rootLanding, sandboxEntry, sandboxLanding } from "./firstScreens";

// Home is the first screen; a sandbox's own first screen is its board, inside it. A guest keeps the one way in it has.

const MEMBER = { isGuest: false, homeOnly: false };
const GUEST = { isGuest: true, homeOnly: false };
const HOME_ONLY = { isGuest: true, homeOnly: true };
const BOX = `a1b2c3d4e5f6`;

test(`the bare address opens Home, for the person and for a home-only guest`, () => {
    expect(HOME_PATH).toBe(homePath());
    expect(rootLanding(MEMBER, false, BOX)).toBe(HOME_PATH);
    expect(rootLanding(HOME_ONLY, false, BOX)).toBe(HOME_PATH);
});

test(`a guest of a box still opens on its chat, the only screen it has there`, () => {
    expect(rootLanding(GUEST, false, BOX)).toBe(insidePath(BOX, page.chat()));
});

test(`the Android app keeps opening on the board it draws itself`, () => {
    expect(rootLanding(MEMBER, true, BOX)).toBe(insidePath(BOX, page.agents()));
    expect(rootLanding(GUEST, true, BOX)).toBe(insidePath(BOX, page.chat()));
});

test(`with no sandbox to open, Home is the landing for everyone`, () => {
    expect(rootLanding(GUEST, true, undefined)).toBe(HOME_PATH);
});

test(`entering a sandbox lands on its board, never back on Home`, () => {
    expect(sandboxLanding(BOX, MEMBER)).toBe(`/s/${BOX}/agents`);
    expect(sandboxLanding(BOX, GUEST)).toBe(`/s/${BOX}/chat`);
    expect(sandboxLanding(BOX, HOME_ONLY)).toBe(homePath(BOX));
});

test(`opening a sandbox returns to the screen it was left on, and to its board when it was left on none`, () => {
    const file = insidePath(BOX, page.workspace(`src/app.ts`));
    expect(sandboxEntry(BOX, file, MEMBER)).toBe(file);
    const changes = insidePath(BOX, page.agent(`a1`, { query: { view: `changes` } }));
    expect(sandboxEntry(BOX, changes, MEMBER)).toBe(changes);
    expect(sandboxEntry(BOX, undefined, MEMBER)).toBe(insidePath(BOX, page.agents()));
});

test(`a screen kept before frames is read as that sandbox's`, () => {
    expect(sandboxEntry(BOX, `/workspace/src/app.ts`, MEMBER)).toBe(insidePath(BOX, page.workspace(`src/app.ts`)));
    expect(sandboxEntry(BOX, `/sandbox/models?provider=claude`, MEMBER)).toBe(
        insidePath(BOX, page.sandboxSettings(`models`, { query: { provider: `claude` } })),
    );
});

test.each([
    `/`,
    `/home`,
    `/home/box-1`,
    `/home/account/appearance`,
    `/settings/appearance`,
    `/deleted-sandboxes`,
    `/s/${BOX}/account`,
    `/s/other/workspace`,
    `/s/${BOX}`,
])(`%s is no screen of the sandbox, so opening it lands on its board`, (remembered) => {
    expect(sandboxEntry(BOX, remembered, MEMBER)).toBe(insidePath(BOX, page.agents()));
});

test(`a screen is the address inside the sandbox, a page of it in Home's frame being none`, () => {
    expect(insideScreen(BOX, `/s/${BOX}/browsers/desktop`)).toBe(`/s/${BOX}/browsers/desktop`);
    expect(insideScreen(BOX, `/home/${BOX}/workspace`)).toBeUndefined();
});
