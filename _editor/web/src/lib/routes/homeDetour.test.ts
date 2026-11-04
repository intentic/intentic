import type { PageName } from "@intentic/sandbox-contract/app-routes";
import type { FrameKind } from "./links";
import { backIsHome, homeChatOf, homeViewFor, homeViewGuard, homeViewOf } from "./homeDetour";

// Home shows a sandbox's own view where its chat was, rather than sending the person into the sandbox for it: one rule
// at the router for every door pressed in Home's frame, a link inside the sandbox going where it says, and Back to the
// very chat the view was opened from.

const BOX = `a1b2c3d4e5f6`;
const HOME = { name: `home`, path: `/home/${BOX}`, params: { sandbox: BOX } } as const;
const BARE_HOME = { name: `home`, path: `/home`, params: {} } as const;
const at = (frame: FrameKind, name: PageName, params: Record<string, string>, query: Record<string, string> = {}, hash = ``) => ({
    meta: { frame, page: name },
    params: { sandbox: BOX, ...params },
    query,
    hash,
});
const models = (frame: FrameKind = `home`, query: Record<string, string> = {}, hash = ``) =>
    at(frame, `sandboxSettings`, { tab: `models` }, query, hash);

test(`a press on Home that leads to a sandbox's Models in Home's frame shows it on Home, carrying what the link asked of it`, () => {
    expect(homeViewFor(models(), HOME)).toEqual({ path: `/home/${BOX}`, query: { show: `models` }, hash: `` });
    // "Try again" names the provider whose sign-in to start; a picked provider's Connect names the tile to open.
    expect(homeViewFor(models(`home`, { provider: `claude` }), HOME)).toEqual({
        path: `/home/${BOX}`,
        query: { provider: `claude`, show: `models` },
        hash: ``,
    });
    expect(homeViewFor(models(`home`, { open: `codex` }, `#keys`), HOME)).toEqual({
        path: `/home/${BOX}`,
        query: { open: `codex`, show: `models` },
        hash: `#keys`,
    });
    // Home with no sandbox named yet is the sandbox open.
    expect(homeViewFor(models(), BARE_HOME)).toEqual({ path: `/home`, query: { show: `models` }, hash: `` });
});

test(`it is Home's rule alone, in Home's frame, and only for the views Home can show of the sandbox it shows`, () => {
    // Inside a sandbox, Models is Models, and a link into the sandbox from Home goes where it says.
    expect(homeViewFor(models(`inside`), { name: `inside:agents`, path: `/s/${BOX}/agents`, params: { sandbox: BOX } })).toBeUndefined();
    expect(homeViewFor(models(`inside`), HOME)).toBeUndefined();
    // From Home, everything else still goes where it says.
    expect(homeViewFor(at(`home`, `agent`, { id: `a-1` }), HOME)).toBeUndefined();
    expect(homeViewFor(at(`home`, `sandboxSettings`, { tab: `agent` }), HOME)).toBeUndefined();
    expect(homeViewFor(at(`home`, `account`, {}), HOME)).toBeUndefined();
    // Another sandbox's Models is no view of the chat on screen.
    expect(homeViewFor({ ...models(), params: { sandbox: `other`, tab: `models` } }, HOME)).toBeUndefined();
    // Home itself (a view's own query writes) is no view to show.
    expect(
        homeViewFor({ meta: { frame: `home` }, params: { sandbox: BOX }, query: { show: `models`, open: `claude` }, hash: `` }, HOME),
    ).toBeUndefined();
});

test(`the guard is the rule`, () => {
    expect(homeViewGuard(models(`inside`), HOME)).toBe(true);
    expect(homeViewGuard(models(), HOME)).toEqual({ path: `/home/${BOX}`, query: { show: `models` }, hash: `` });
});

test(`the view shown is read off the address, and only a view Home knows`, () => {
    expect(homeViewOf({ show: `models` })).toBe(`models`);
    expect(homeViewOf({ show: `secrets` })).toBeUndefined();
    expect(homeViewOf({})).toBeUndefined();
});

test(`back is a step back to the very chat the view was opened from, else that chat's address`, () => {
    expect(homeChatOf({ path: `/home/box-1` })).toEqual({ path: `/home/box-1` });
    expect(backIsHome({ back: `/home` }, { path: `/home` })).toBe(true);
    expect(backIsHome({ back: `/home/box-1` }, { path: `/home/box-1` })).toBe(true);
    // Opened by a reload or a link: nothing behind it, or somewhere else, or another view of Home's.
    expect(backIsHome({ back: null }, { path: `/home` })).toBe(false);
    expect(backIsHome({ back: `/s/box-1/agents` }, { path: `/home` })).toBe(false);
    expect(backIsHome({ back: `/home?show=models` }, { path: `/home` })).toBe(false);
});
