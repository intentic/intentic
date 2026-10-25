import { backIsHome, goInside, homeChatOf, homeViewFor, homeViewGuard, homeViewOf } from "./homeDetour";

// Home shows a sandbox's own view where its chat was, rather than sending the person into the sandbox for it: one rule
// at the router for every door, a deliberate step inside past it, and Back to the very chat the view was opened from.

const HOME = { name: `home`, path: `/home` } as const;
const PHONE_HOME = { name: `home`, path: `/home/box-1` } as const;
const at = (path: string, query: Record<string, string> = {}, hash = ``) => ({ path, query, hash });

test(`a press on Home that leads to a sandbox's Models shows it on Home, carrying what the link asked of it`, () => {
    expect(homeViewFor(at(`/sandbox/models`), HOME)).toEqual({ path: `/home`, query: { show: `models` }, hash: `` });
    // "Try again" names the provider whose sign-in to start; a picked provider's Connect names the tile to open.
    expect(homeViewFor(at(`/sandbox/models`, { provider: `claude` }), HOME)).toEqual({
        path: `/home`,
        query: { provider: `claude`, show: `models` },
        hash: ``,
    });
    expect(homeViewFor(at(`/sandbox/models`, { open: `codex` }, `#keys`), HOME)).toEqual({
        path: `/home`,
        query: { open: `codex`, show: `models` },
        hash: `#keys`,
    });
});

test(`a phone's home keeps its sandbox in the address`, () => {
    expect(homeViewFor(at(`/sandbox/models`), PHONE_HOME)).toEqual({ path: `/home/box-1`, query: { show: `models` }, hash: `` });
});

test(`it is Home's rule alone, and only for the views Home can show`, () => {
    // From inside a sandbox, Models is Models.
    expect(homeViewFor(at(`/sandbox/models`), { name: `agents`, path: `/agents` })).toBeUndefined();
    // From Home, everything else still goes where it says.
    expect(homeViewFor(at(`/agents/a-1`), HOME)).toBeUndefined();
    expect(homeViewFor(at(`/sandbox/agent`), HOME)).toBeUndefined();
    expect(homeViewFor(at(`/settings`), HOME)).toBeUndefined();
    // Home itself (a view's own query writes) is no view to show.
    expect(homeViewFor(at(`/home`, { show: `models`, open: `claude` }), HOME)).toBeUndefined();
});

test(`a sandbox entered on purpose lands on the view it names, even its Models`, async () => {
    let during: ReturnType<typeof homeViewGuard> | undefined;
    await goInside(async () => {
        during = homeViewGuard(at(`/sandbox/models`), HOME);
    });

    expect(during).toBe(true);
    // Only that one step: the next press on Home is Home's again.
    expect(homeViewGuard(at(`/sandbox/models`), HOME)).toEqual({ path: `/home`, query: { show: `models` }, hash: `` });
});

test(`a step inside that fails still gives the rule back`, async () => {
    await expect(
        goInside(async () => {
            throw new Error(`refused`);
        }),
    ).rejects.toThrow(`refused`);

    expect(homeViewGuard(at(`/sandbox/models`), HOME)).not.toBe(true);
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
    expect(backIsHome({ back: `/agents` }, { path: `/home` })).toBe(false);
    expect(backIsHome({ back: `/home?show=models` }, { path: `/home` })).toBe(false);
});
