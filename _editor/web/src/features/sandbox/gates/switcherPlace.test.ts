import "@intentic/testing/dom";
import type { SandboxSummary } from "@intentic/api-contract";
import { createApp, defineComponent, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, useRouter } from "vue-router";
import { LINK_HOST, type LocalHost } from "../../../app/environments/localHost";

// Pins the one place the sandbox switcher differs between the workspace and the desktop app's window on a folder: what
// a pick, the setup and the recently deleted do from each, that a folder's window asks the platform for the account's
// sandboxes once it is up and each time the panel opens, and that its remove dialog's door is this computer, through
// the app, when this computer holds the sandbox.

const refreshed: string[] = [];
const user = ref<{ email: string } | null>({ email: `ada@example.com` });
jest.mock(`../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({
        refresh: () => {
            refreshed.push(`list`);
            return Promise.resolve([]);
        },
    }),
}));
jest.mock(`../../../client/auth/useAccount`, () => ({ useAccount: () => ({ user }) }));

const opened: string[] = [];
let refuse: string | undefined;
let held: readonly string[] = [];
const removed: string[] = [];
const host: LocalHost = {
    ...LINK_HOST,
    openWorkspace: (path?: string) => {
        if (refuse !== undefined) {
            return Promise.reject(new Error(refuse));
        }
        opened.push(path ?? `/`);
        return Promise.resolve();
    },
    signIn: () => Promise.resolve(),
    machine: {
        holds: (slug: string) => Promise.resolve(held.includes(slug)),
        remove: (slug: string) => {
            removed.push(slug);
            return Promise.resolve();
        },
    },
};

const { openWorkspacePath, useFolderPlace } = await import("./switcherPlace");
const { useRemovalDoor } = await import("./removal/useRemovalDoor");

const FACE = { daemonUrl: `http://127.0.0.1:47148`, token: `t`, id: `f1`, name: `Taxes`, path: `/home/ada/Taxes` };

interface Mounted<T> {
    readonly value: T;
    readonly unmount: () => void;
    readonly path: () => string;
}

const mount = <T>(use: () => T): Mounted<T> => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:any(.*)*`, component: { render: () => null } }] });
    let value: T | undefined;
    const app = createApp(
        defineComponent({
            setup: () => {
                value = use();
                return () => null;
            },
        }),
    );
    app.use(router);
    app.mount(document.createElement(`div`));
    if (value === undefined) {
        throw new Error(`setup did not run`);
    }
    return { value, unmount: () => app.unmount(), path: () => router.currentRoute.value.fullPath };
};

beforeEach(() => {
    refreshed.length = 0;
    opened.length = 0;
    removed.length = 0;
    refuse = undefined;
    held = [];
    user.value = { email: `ada@example.com` };
    window.__INTENTIC_LOCAL_HOST__ = host;
});
afterEach(() => {
    delete window.__INTENTIC_LOCAL__;
    delete window.__INTENTIC_LOCAL_HOST__;
});

describe(`in the workspace`, () => {
    it(`stands on no folder, asks nothing of the app, and goes to a workspace path by its own route`, async () => {
        let going: Promise<void> | undefined;
        const mounted = mount(() => {
            going = openWorkspacePath(useRouter(), `/setup`);
            return useFolderPlace(ref(false));
        });
        await going;
        expect({ local: mounted.value.local, signedOut: mounted.value.signedOut.value, refreshed, opened, path: mounted.path() }).toEqual({
            local: false,
            signedOut: false,
            refreshed: [],
            opened: [],
            path: `/setup`,
        });
        mounted.unmount();
    });
});

describe(`in a local window`, () => {
    beforeEach(() => {
        window.__INTENTIC_LOCAL__ = FACE;
    });

    it(`stands on its folder and asks for the account's sandboxes once up and each time the panel opens`, async () => {
        const open = ref(false);
        const mounted = mount(() => useFolderPlace(open));
        open.value = true;
        await nextTick();
        expect({ local: mounted.value.local, folder: mounted.value.folder.value, refreshed }).toEqual({
            local: true,
            folder: { name: `Taxes`, path: `/home/ada/Taxes` },
            refreshed: [`list`, `list`],
        });
        mounted.unmount();
    });

    it(`opens a sandbox, the add dialog and the recently deleted as the workspace, through the app`, async () => {
        const open = ref(true);
        const mounted = mount(() => useFolderPlace(open));
        await mounted.value.openFromFolder(`sbx-work`);
        const event = new MouseEvent(`click`, { cancelable: true });
        mounted.value.addSandbox(event);
        await nextTick();
        expect({ opened, closed: !open.value, prevented: event.defaultPrevented, stayed: mounted.path() }).toEqual({
            opened: [`/?sandbox=sbx-work`, `/?add=sandbox`],
            closed: true,
            prevented: true,
            stayed: `/`,
        });
        mounted.unmount();
    });

    it(`says why a sandbox did not open, by its row, and keeps the panel up`, async () => {
        refuse = `The workspace window could not be opened.`;
        const open = ref(true);
        const mounted = mount(() => useFolderPlace(open));
        await mounted.value.openFromFolder(`sbx-work`);
        expect({ failure: mounted.value.failure.value, open: open.value }).toEqual({
            failure: { id: `sbx-work`, message: `The workspace window could not be opened.` },
            open: true,
        });
        mounted.unmount();
    });

    it(`offers the sign-in in place of the sandboxes while nobody is signed in`, () => {
        user.value = null;
        const mounted = mount(() => useFolderPlace(ref(false)));
        expect(mounted.value.signedOut.value).toBe(true);
        mounted.unmount();
    });

    it(`removes a sandbox this computer holds through the app, and names this computer as looked at when it holds none`, async () => {
        const row: SandboxSummary = {
            id: `sbx-work`,
            name: `work`,
            image: null,
            daemonUrl: `https://work.intentic.dev`,
            lastSeenAt: `2026-10-21T12:00:00.000Z`,
            setupCodeClaimedAt: null,
            setupReport: null,
            bootReport: null,
            announceRefusal: null,
            removedAt: null,
            removedBy: null,
            token: null,
            role: `owner`,
            providedAddress: false,
            localHostname: null,
            hosted: null,
        };
        held = [`work`];
        const holding = mount(() => useRemovalDoor(() => row, () => `work`));
        await new Promise((settle) => setTimeout(settle, 0));
        await holding.value.door.value?.carry?.(`work`);
        const elsewhere = mount(() => useRemovalDoor(() => row, () => `other`));
        await new Promise((settle) => setTimeout(settle, 0));
        expect({
            door: holding.value.door.value?.machineLabel,
            removed,
            elsewhere: elsewhere.value.door.value,
            looked: elsewhere.value.looked.value.length,
            looking: elsewhere.value.looking.value,
        }).toEqual({ door: `This computer`, removed: [`work`], elsewhere: undefined, looked: 1, looking: false });
        holding.unmount();
        elsewhere.unmount();
    });
});
