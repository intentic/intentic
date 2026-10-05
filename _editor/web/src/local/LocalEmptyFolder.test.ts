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

const rows = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-test="found-projects"] li`)].map((row) => row.textContent ?? ``);

it(`offers the folders opened here and the ones the tools found, never the folder it shows`, async () => {
    const { el, unmount } = await mount(hostWith(FOUND));
    const offered = rows(el);
    expect(offered).toHaveLength(2);
    expect(offered[0]).toContain(`shop`);
    expect(offered[0]).toContain(`Opened here before`);
    expect(offered[0]).toContain(`Has a sandbox`);
    expect(offered[1]).toContain(`/home/ada/api`);
    expect(offered[1]).toContain(`WSL · Ubuntu`);
    expect(offered[1]).toContain(`Codex, Claude Code`);
    expect(el.textContent).toContain(`Nothing leaves it.`);
    unmount();
});

it(`opens the folder pressed in this window's place, by the path this computer opens it at`, async () => {
    const host = hostWith(FOUND);
    const { el, unmount } = await mount(host);
    [...el.querySelectorAll<HTMLButtonElement>(`[data-test="found-projects"] li button`)][1]?.click();
    await nextTick();
    expect(host.point).toHaveBeenCalledWith(`\\\\wsl.localhost\\Ubuntu\\home\\ada\\api`);
    unmount();
});

it(`says where a folder could not be opened, on its own row`, async () => {
    const host = hostWith(FOUND, jest.fn(async (): Promise<undefined> => {
        throw new Error(`api isn't there any more.`);
    }));
    const { el, unmount } = await mount(host);
    [...el.querySelectorAll<HTMLButtonElement>(`[data-test="found-projects"] li button`)][1]?.click();
    // The refusal settles a task later, then renders.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(rows(el)[1]).toContain(`api isn't there any more.`);
    unmount();
});

it(`stops offering them once told to, and keeps the way back`, async () => {
    const first = await mount(hostWith(FOUND));
    const hide = [...first.el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Don't show these`));
    hide?.click();
    await nextTick();
    expect(rows(first.el)).toHaveLength(0);
    expect(first.el.textContent).toContain(`This folder is empty`);
    expect(first.el.textContent).toContain(`Show the folders found on this computer`);
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
    expect(bare.el.textContent).not.toContain(`Show the folders found`);
    bare.unmount();
});
