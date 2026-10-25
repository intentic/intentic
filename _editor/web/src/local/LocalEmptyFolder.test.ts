import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick } from "vue";
import type { LocalFace } from "../app/environments/local";
import { LINK_HOST, type LocalFound, type LocalHost, type LocalPlace } from "../app/environments/localHost";

// The main window's empty folder on a first launch: it offers the folders this computer already works in, opens the one
// pressed in its own place, and stops offering them once told to. A folder window the reader opened stays as it was.

const { default: LocalEmptyFolder } = await import("./LocalEmptyFolder.vue");

const HOME_FOLDER = `C:\\Users\\ada\\intentic\\local`;

const FOUND: LocalFound = {
    providers: [],
    projects: [
        {
            path: `\\\\wsl.localhost\\Ubuntu\\home\\ada\\api`,
            shown: `/home/ada/api`,
            name: `api`,
            sources: [`codex`, `claude-code`],
            lastActive: Math.floor(Date.now() / 1000) - 3600,
            wsl: `Ubuntu`,
            git: true,
            sandbox: false,
        },
        {
            path: HOME_FOLDER,
            shown: HOME_FOLDER,
            name: `local`,
            sources: [`claude-code`],
            lastActive: null,
            wsl: null,
            git: false,
            sandbox: false,
        },
    ],
};

const RECENTS: LocalPlace[] = [{ path: `C:\\Users\\ada\\code\\shop`, folder: true, openedAt: 1_790_000_000, exists: true, sandbox: true }];

const hostWith = (found: LocalFound, point = jest.fn(async (_path: string) => undefined)): LocalHost & { point: typeof point } => ({
    ...LINK_HOST,
    native: true,
    places: async () => RECENTS,
    found: async () => found,
    facts: async () => ({ accountSeen: false, homeFolder: HOME_FOLDER }),
    point,
});

const face = (home: boolean): LocalFace => ({ daemonUrl: `http://127.0.0.1:1`, token: `t`, id: `f`, name: `local`, path: HOME_FOLDER, sandbox: false, home });

const mount = async (host: LocalHost, home = true): Promise<{ el: HTMLElement; unmount: () => void }> => {
    window.__INTENTIC_LOCAL__ = face(home);
    window.__INTENTIC_LOCAL_HOST__ = host;
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(LocalEmptyFolder) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    // The three readings, then the render they feed.
    for (let tick = 0; tick < 5; tick += 1) {
        await nextTick();
        await Promise.resolve();
    }
    return {
        el,
        unmount: () => {
            app.unmount();
            el.remove();
        },
    };
};

afterEach(() => {
    localStorage.clear();
    delete window.__INTENTIC_LOCAL__;
    delete window.__INTENTIC_LOCAL_HOST__;
});

const rows = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-test="found-project"]`)].map((row) => row.textContent ?? ``);
const rowButtons = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>(`[data-test="found-project"] button`)];

it(`offers the folders opened here and the ones the tools found, by where they live, never the folder it shows`, async () => {
    const { el, unmount } = await mount(hostWith(FOUND));
    const offered = rows(el);
    expect(offered).toHaveLength(2);
    // The distro's folder was used more recently, so its group comes first; each says where it is, short.
    expect(offered[0]).toContain(`api`);
    expect(offered[0]).toContain(`~`);
    expect(offered[0]).not.toContain(`wsl.localhost`);
    expect(offered[1]).toContain(`shop`);
    expect(offered[1]).toContain(`~\\code`);
    expect(offered[1]).toContain(`Has a sandbox`);
    const labels = [...el.querySelectorAll(`[data-test="found-projects"] section`)].map((group) => group.textContent ?? ``);
    expect(labels[0]).toContain(`WSL · Ubuntu`);
    expect(labels[1]).toContain(`Windows`);
    expect(el.textContent).toContain(`Nothing leaves it.`);
    unmount();
});

it(`opens the folder pressed in this window's place, by the path this computer opens it at`, async () => {
    const host = hostWith(FOUND);
    const { el, unmount } = await mount(host);
    rowButtons(el)[0]?.click();
    await nextTick();
    expect(host.point).toHaveBeenCalledWith(`\\\\wsl.localhost\\Ubuntu\\home\\ada\\api`);
    unmount();
});

it(`says where a folder could not be opened, on its own row`, async () => {
    const host = hostWith(FOUND, jest.fn(async (): Promise<undefined> => {
        throw new Error(`api isn't there any more.`);
    }));
    const { el, unmount } = await mount(host);
    rowButtons(el)[0]?.click();
    // The refusal settles a task later, then renders.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(rows(el)[0]).toContain(`api isn't there any more.`);
    unmount();
});

it(`stops offering them once told to, and keeps the way back`, async () => {
    const first = await mount(hostWith(FOUND));
    const hide = [...first.el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Hide this list`));
    hide?.click();
    await nextTick();
    expect(rows(first.el)).toHaveLength(0);
    expect(first.el.textContent).toContain(`This folder is empty`);
    expect(first.el.textContent).toContain(`Show recent projects`);
    first.unmount();
    // A later launch remembers.
    const again = await mount(hostWith(FOUND));
    expect(rows(again.el)).toHaveLength(0);
    again.unmount();
});

it(`leaves a folder window, and a computer with nothing to offer, as the empty folder it is`, async () => {
    const folderWindow = await mount(hostWith(FOUND), false);
    expect(rows(folderWindow.el)).toHaveLength(0);
    expect(folderWindow.el.textContent).toContain(`This folder is empty`);
    folderWindow.unmount();
    const bare = await mount({ ...hostWith({ providers: [], projects: [] }), places: async () => [] });
    expect(rows(bare.el)).toHaveLength(0);
    expect(bare.el.textContent).not.toContain(`Show recent projects`);
    bare.unmount();
});

// 2026-10-25: a folder whose sandbox belongs to another account than the one signed in says so, and its row opens into
// the ways on rather than into a folder whose button could only refuse the reader.
describe(`a folder synced with another account's sandbox`, () => {
    const OTHERS: LocalPlace[] = [
        { path: `C:\\Users\\ada\\code\\translate`, folder: true, openedAt: 1_790_000_000, exists: true, sandbox: true, holder: `other`, owner: `ada@work.example` },
        { path: `C:\\Users\\ada\\code\\shop`, folder: true, openedAt: 1_789_000_000, exists: true, sandbox: true, holder: `mine` },
    ];
    const hostOf = (extra: Partial<Omit<LocalHost, `point`>> = {}): ReturnType<typeof hostWith> => ({
        ...hostWith({ providers: [], projects: [] }),
        places: async () => OTHERS,
        roster: async () => ({ account: { email: `ada@home.example` }, sandboxes: [] }),
        ...extra,
    });
    const settle = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await nextTick();
    };

    it(`says "Other account" on its row, and "Has a sandbox" only on the signed-in account's own`, async () => {
        const { el, unmount } = await mount(hostOf());
        const [other, mine] = rows(el);
        expect(other).toContain(`Other account`);
        expect(other).not.toContain(`Has a sandbox`);
        expect(mine).toContain(`Has a sandbox`);
        unmount();
    });

    it(`opens in place into whose it is and the ways on, instead of into the folder`, async () => {
        const signIn = jest.fn(async () => undefined);
        const host = hostOf({ signIn });
        const { el, unmount } = await mount(host);
        rowButtons(el)[0]?.click();
        await nextTick();
        expect(host.point).not.toHaveBeenCalled();
        const panel = el.querySelector(`[data-test="other-account-panel"]`);
        expect(panel?.textContent).toContain(`belongs to ada@work.example`);
        expect(panel?.textContent).toContain(`signed in as ada@home.example`);
        el.querySelector<HTMLButtonElement>(`[data-test="switch-account"]`)?.click();
        await settle();
        expect(signIn).toHaveBeenCalledWith({ switchAccount: true });
        expect(el.querySelector(`[data-test="other-account-panel"]`)?.textContent).toContain(`Finish signing in in your browser`);
        el.querySelector<HTMLButtonElement>(`[data-test="open-files"]`)?.click();
        await nextTick();
        expect(host.point).toHaveBeenCalledWith(`C:\\Users\\ada\\code\\translate`);
        unmount();
    });

    it(`unlinks only on a second press, then reads the list again`, async () => {
        const unlink = jest.fn(async (_path: string) => undefined);
        const places = jest.fn(async () => OTHERS);
        const { el, unmount } = await mount(hostOf({ unlink, places }));
        rowButtons(el)[0]?.click();
        await nextTick();
        const press = (): void => el.querySelector<HTMLButtonElement>(`[data-test="unlink"]`)?.click();
        press();
        await nextTick();
        expect(unlink).not.toHaveBeenCalled();
        expect(el.textContent).toContain(`Both keep their files`);
        press();
        await settle();
        expect(unlink).toHaveBeenCalledWith(`C:\\Users\\ada\\code\\translate`);
        expect(places).toHaveBeenCalledTimes(2);
        expect(el.querySelector(`[data-test="other-account-panel"]`)).toBeNull();
        unmount();
    });
});
