import { homePath, insidePath, page } from "@intentic/sandbox-contract/app-routes";
import { DELETED_PATH, isAccountPath, isAccountRoute, isHomePath } from "./home";

// Home's own page, and the account's pages, which need no sandbox: read off the address in either form it comes in.

const BOX = `a1b2c3d4e5f6`;

test(`Home's own page is Home with or without a sandbox named, and nothing below it`, () => {
    expect(isHomePath(homePath())).toBe(true);
    expect(isHomePath(homePath(BOX))).toBe(true);
    expect(isHomePath(`${homePath()}?add=sandbox`)).toBe(true);
    expect(isHomePath(homePath(BOX, page.workspace()))).toBe(false);
    expect(isHomePath(homePath(undefined, page.account()))).toBe(false);
    expect(isHomePath(`/homework`)).toBe(false);
});

test.each([
    homePath(),
    homePath(BOX),
    homePath(undefined, page.account()),
    homePath(undefined, page.account(`appearance`, { query: { plan: `welcome` } })),
    homePath(undefined, page.deletedSandboxes()),
    insidePath(BOX, page.account(`notifications`, { hash: `voice` })),
    insidePath(BOX, page.deletedSandboxes()),
    // The same pages at their addresses from before frames.
    `/settings`,
    `/settings/appearance`,
    `/deleted-sandboxes`,
    `/deleted-sandboxes#deleted`,
    DELETED_PATH,
])(`%s belongs to the account without needing a sandbox`, (path) => expect(isAccountPath(path)).toBe(true));

test.each([
    `/homework`,
    `/settingsx`,
    `/deleted-sandboxesx`,
    `/deleted-sandboxes/other`,
    insidePath(BOX),
    insidePath(BOX, page.workspace()),
    homePath(BOX, page.agents()),
    homePath(BOX, page.sandboxSettings()),
    `/workspace`,
    `/agents`,
    `/sandbox`,
    `/sandbox/agent`,
])(`%s is not an account page`, (path) => expect(isAccountPath(path)).toBe(false));

test(`a route is the account's on Home's own page and on an account page in either frame`, () => {
    expect(isAccountRoute({ meta: { frame: `home` }, params: {} })).toBe(true);
    expect(isAccountRoute({ meta: { frame: `inside`, page: `account` }, params: { sandbox: BOX } })).toBe(true);
    expect(isAccountRoute({ meta: { frame: `home`, page: `deletedSandboxes` }, params: {} })).toBe(true);
    expect(isAccountRoute({ meta: { frame: `home`, page: `workspace` }, params: { sandbox: BOX } })).toBe(false);
    expect(isAccountRoute({ meta: {}, params: {} })).toBe(false);
});
