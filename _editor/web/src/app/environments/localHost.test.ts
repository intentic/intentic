import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { LocalHost } from "./localHost";

afterEach(unstubAllGlobals);

/* The page's window as localHost.ts reads it: one the app handed a host, or one it did not (a dev server, a test). */
const load = (host?: object): Promise<typeof import("./localHost")> => {
    stubGlobal(`window`, host === undefined ? {} : { __INTENTIC_LOCAL_HOST__: host });
    return freshImport<typeof import("./localHost")>("./localHost", import.meta.url);
};

test("a window the app handed a host answers with it, and any other with the link-only host", async () => {
    const bare = await load();
    expect(bare.localHost()).toBe(bare.LINK_HOST);
    // The app's own host, told apart from the link-only one by what it can reach.
    const host: LocalHost = { ...bare.LINK_HOST, native: true };
    expect((await load(host)).localHost()).toBe(host);
});

/* Without the app's host the shell reads nothing the app keeps: no account, no home folder, no recent places, no sandboxes, no views. */
test("the link-only host knows nothing of this computer and adds no view", async () => {
    const { LINK_HOST } = await load();
    expect([LINK_HOST.native, LINK_HOST.views]).toEqual([false, []]);
    expect(await LINK_HOST.facts()).toEqual({ accountSeen: false, homeFolder: `` });
    expect(await LINK_HOST.places()).toEqual([]);
    expect(await LINK_HOST.roster()).toEqual({ account: null, sandboxes: [] });
});

/* What it can do is what any local window could always ask by link: the system dialog, in a window of its own. */
test("the link-only host asks the app for its dialogs by link", async () => {
    jest.useFakeTimers();
    const heard: string[] = [];
    stubGlobal(`location`, {
        get href(): string {
            return heard.at(-1) ?? ``;
        },
        set href(link: string) {
            heard.push(link);
        },
    });
    stubGlobal(`document`, { readyState: `complete` });
    const { LINK_HOST } = await load();
    await LINK_HOST.pickFolder();
    jest.advanceTimersByTime(1_000);
    await LINK_HOST.pickFile();
    jest.advanceTimersByTime(1_000);
    jest.useRealTimers();
    expect(heard).toEqual([`intentic://local?do=open-folder`, `intentic://local?do=open-file`]);
});
