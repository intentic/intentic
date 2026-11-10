import "@intentic/testing/dom";
import type { SandboxSummary } from "@intentic/api-contract";
import { createApp, defineComponent, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, useRouter } from "vue-router";
import { LINK_HOST, type LocalHost } from "../../../app/environments/localHost";

// Pins the one place the rail's top differs between the workspace and the desktop app's window on a folder: what a pick,
// the setup and the recently deleted do from each, that a folder's window asks the platform for the account's sandboxes
// once its rail is up and again each time it unrolls, and that its remove dialog's door is this computer, through the
// app, when this computer holds the sandbox.

const refreshed: string[] = [];
const user = ref<{ email: string } | null>({ email: `ada@example.com` });
jest.mock(`../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({
        sandboxes: { value: [] },
        refresh: () => {
            refreshed.push(`list`);
            return Promise.resolve([]);
        },
    }),
}));
jest.mock(`../../../client/auth/useAccount`, () => ({ useAccount: () => ({ user }) }));

const opened: string[] = [];
const signIns: string[] = [];
let refuse: string | undefined;
let held: readonly string[] = [];
let rosterIds: readonly string[] = [];
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
    signIn: () => {
        signIns.push(`sign-in`);
        return Promise.resolve();
    },
    roster: () => Promise.resolve({ account: null, sandboxes: rosterIds.map((id) => ({ id, name: id, place: `cloud`, shared: false })) }),
    machine: {
        holds: (slug: string) => Promise.resolve(held.includes(slug)),
        remove: (slug: string) => {
            removed.push(slug);
            return Promise.resolve();
        },
    },
};

const { openWorkspacePath, resetFolderPlace, useFolderPlace } = await import("./switcherPlace");
const { useNotifications } = await import("../../../workbench/notifications/notifications");
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
    signIns.length = 0;
    resetFolderPlace();
    useNotifications().dismissReceipt();
    removed.length = 0;
    refuse = undefined;
    held = [];
    rosterIds = [];
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
            return useFolderPlace();
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

    it(`wears the order the workspace last told the app, read again when the rail unrolls`, async () => {
        rosterIds = [`b`, `a`];
        const clock = jest.spyOn(Date, `now`).mockReturnValue(1_000_000);
        const rail = mount(() => useFolderPlace());
        await new Promise((resolve) => setTimeout(resolve, 0));
        const first = rail.value.arranged.value;
        rosterIds = [`a`, `b`, `c`];
        clock.mockReturnValue(1_060_000);
        const unrolled = mount(() => useFolderPlace());
        await new Promise((resolve) => setTimeout(resolve, 0));
        clock.mockRestore();
        expect({ first, unrolled: rail.value.arranged.value }).toEqual({ first: [`b`, `a`], unrolled: [`a`, `b`, `c`] });
        rail.unmount();
        unrolled.unmount();
    });

    it(`stands on its folder and asks for the account's sandboxes once for the parts mounting together, and again later`, () => {
        const clock = jest.spyOn(Date, `now`).mockReturnValue(1_000_000);
        const logo = mount(() => useFolderPlace());
        const cluster = mount(() => useFolderPlace());
        const together = [...refreshed];
        clock.mockReturnValue(1_060_000);
        const unrolled = mount(() => useFolderPlace());
        clock.mockRestore();
        expect({ local: logo.value.local, folder: logo.value.folder.value, together, later: refreshed }).toEqual({
            local: true,
            folder: { name: `Taxes`, path: `/home/ada/Taxes` },
            together: [`list`],
            later: [`list`, `list`],
        });
        for (const mounted of [logo, cluster, unrolled]) {
            mounted.unmount();
        }
    });

    it(`opens a sandbox and the add as the workspace, through the app`, async () => {
        const mounted = mount(() => useFolderPlace());
        await mounted.value.openFromFolder(`sbx-work`);
        mounted.value.addSandbox();
        await nextTick();
        expect({ opened, stayed: mounted.path() }).toEqual({ opened: [`/?sandbox=sbx-work`, `/?add=sandbox`], stayed: `/` });
        mounted.unmount();
    });

    it(`opens a sandbox's settings as the workspace on that sandbox, through the app`, async () => {
        const mounted = mount(() => useFolderPlace());
        await mounted.value.openSettingsFromFolder(`sbx-work`, `/sandbox`);
        expect(opened).toEqual([`/sandbox?sandbox=sbx-work`]);
        mounted.unmount();
    });

    it(`says why a sandbox did not open in the window's notification lane, in the app's own words`, async () => {
        refuse = `The workspace window could not be opened.`;
        const mounted = mount(() => useFolderPlace());
        await mounted.value.openFromFolder(`sbx-work`);
        const said = useNotifications().receipt.value;
        expect({ tone: said?.tone, detail: said?.detail, opened }).toEqual({ tone: `problem`, detail: `The workspace window could not be opened.`, opened: [] });
        mounted.unmount();
    });

    it(`signs in first when Add sandbox is pressed while nobody is signed in`, async () => {
        user.value = null;
        const mounted = mount(() => useFolderPlace());
        mounted.value.addSandbox();
        await nextTick();
        expect({ signedOut: mounted.value.signedOut.value, signIns, opened }).toEqual({ signedOut: true, signIns: [`sign-in`], opened: [] });
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
        const holding = mount(() =>
            useRemovalDoor(
                () => row,
                () => `work`,
            ),
        );
        await new Promise((settle) => setTimeout(settle, 0));
        await holding.value.door.value?.carry?.(`work`);
        const elsewhere = mount(() =>
            useRemovalDoor(
                () => row,
                () => `other`,
            ),
        );
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
