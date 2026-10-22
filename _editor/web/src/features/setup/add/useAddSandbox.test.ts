import "@intentic/testing/dom";
import type { AddressOffer, HostedOffer, SandboxSummary, SetupCode } from "@intentic/api-contract";
import type { Device } from "@intentic/sandbox-contract/schemas/devices";
import { unstubbed } from "@intentic/testing";
import { computed, type EffectScope, effectScope, ref } from "vue";
import { listedDevice } from "../../../testing/listedDevice";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { forgetOperations } from "../../../workbench/operations/operations";

// Adding a sandbox from the dialog: it offers only what starts in one press (this computer in the app, a connected
// machine, a machine of ours with room), makes the row only on the press, hands it where it was picked with a fresh
// code, deletes a row whose start was refused before reaching a machine, and keeps one a machine already has.

const relays = ref<{ sandboxId: string; devices: Device[] }[]>([]);
jest.mock(`../../sandbox/live/useDeviceRelays`, () => ({
    useDeviceRelays: () => ({ relays: computed(() => relays.value), looking: ref(false), look: jest.fn(async () => {}) }),
}));
const manageDeviceSandbox = jest.fn(async (..._args: unknown[]) => `Set up.`);
jest.mock(`../../../models/sandbox/devices/useDevices`, () => ({ manageDeviceSandbox }));
jest.mock(`../../../app/analytics`, () => ({ track: jest.fn() }));

const { HOSTED, nameProblem, pickOf, useAddSandbox } = await import("./useAddSandbox");
const { HERE } = await import("../flow/useSetupOnMachine");

interface World {
    readonly rows?: readonly SandboxSummary[];
    readonly hosted?: HostedOffer;
    readonly address?: AddressOffer;
    readonly inApp?: boolean;
    readonly machines?: readonly Device[];
    readonly setupCode?: Error;
    readonly provision?: Error;
}

const scopes: EffectScope[] = [];

const stage = (world: World = {}) => {
    relays.value = world.machines === undefined ? [] : [{ sandboxId: `live`, devices: [...world.machines] }];
    const sandboxes = ref<SandboxSummary[]>([...(world.rows ?? [sandboxSummary({ id: `live`, name: `workspace`, lastSeenAt: `2026-10-22T08:00:00Z` })])]);
    const create = jest.fn(async (name: string) => sandboxSummary({ id: `new`, name, token: `tok` }));
    const remove = jest.fn(async (_id: string) => undefined);
    const select = jest.fn((_id: string) => undefined);
    const hostedProvision = jest.fn(async (id: string, _token: string) => {
        if (world.provision !== undefined) {
            throw world.provision;
        }
        return sandboxSummary({ id, token: `tok`, hosted: { region: `iad`, warm: true } });
    });
    const platform = {
        hostedOffer: jest.fn(async () => world.hosted ?? { enabled: true, remaining: 1 }),
        addressOffer: jest.fn(async () => world.address ?? { enabled: true }),
        setupCode: jest.fn(async ({ sandboxId }: { sandboxId: string }): Promise<SetupCode> => {
            if (world.setupCode !== undefined) {
                throw world.setupCode;
            }
            return { code: `code-${sandboxId}`, hostname: `sandbox-abc.sbx.test`, expiresAt: `later` };
        }),
        hostedStatus: jest.fn(async () => ({ machine: `started` as const })),
    };
    const openDesktopLink = jest.fn((_link: string) => undefined);
    const enter = jest.fn(async () => undefined);
    const scope = effectScope();
    scopes.push(scope);
    const add = scope.run(() =>
        useAddSandbox({
            sandbox: unstubbed<Parameters<typeof useAddSandbox>[0][`sandbox`]>(`sandbox`, {
                sandboxes,
                create,
                select,
                remove,
                hostedProvision,
                hostedRelease: jest.fn(),
                refresh: jest.fn(async () => sandboxes.value),
            }),
            platform: unstubbed<Parameters<typeof useAddSandbox>[0][`platform`]>(`platform`, platform),
            inApp: () => world.inApp ?? false,
            machines: () => true,
            buildsFromCheckout: false,
            platformUrl: undefined,
            mobile: ref(false),
            openDesktopLink,
            warmCredential: jest.fn(async () => undefined),
            enter,
        }),
    )!;
    return { add, create, remove, hostedProvision, platform, openDesktopLink };
};

const rog = listedDevice({ key: `rog`, label: `rog`, hostId: `rog`, online: true, sandboxes: [] });

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    relays.value = [];
    manageDeviceSandbox.mockClear();
    forgetOperations();
});

describe(`what it offers`, () => {
    it(`names the next free sandbox and offers this computer first in the app, then each machine, then one of ours`, async () => {
        const { add } = stage({ inApp: true, machines: [rog] });
        await add.read();
        expect({ name: add.name.value, offered: add.options.value.map((option) => option.value), pick: add.pick.value }).toEqual({
            name: `workspace-2`,
            offered: [HERE, `rog`, HOSTED],
            pick: HERE,
        });
    });

    it(`offers no this computer in a browser, and no machine of ours once the account has none left`, async () => {
        const { add } = stage({ machines: [rog], hosted: { enabled: true, remaining: 0 } });
        await add.read();
        expect(add.options.value.map((option) => option.value)).toEqual([`rog`]);
    });

    it(`offers nothing that needs a code where the platform mints no addresses`, async () => {
        const { add } = stage({ inApp: true, machines: [rog], address: { enabled: false } });
        await add.read();
        expect(add.options.value.map((option) => option.value)).toEqual([HOSTED]);
    });

    it(`keeps a pick only while it is on offer`, () => {
        const options = [
            { value: `rog`, label: `rog`, icon: `server` as const },
            { value: HOSTED, label: `Intentic`, icon: `cloud` as const },
        ];
        expect([pickOf(HOSTED, options), pickOf(`omen`, options), pickOf(undefined, [])]).toEqual([HOSTED, `rog`, undefined]);
    });

    it(`refuses an empty name and one the platform would`, () => {
        expect([nameProblem(`  `) !== undefined, nameProblem(`x`.repeat(61)) !== undefined, nameProblem(` storefront `)]).toEqual([true, true, undefined]);
    });
});

describe(`the press`, () => {
    it(`makes the row under the typed name and hands this computer's app a fresh code for it`, async () => {
        const { add, create, openDesktopLink } = stage({ inApp: true });
        await add.read();
        add.name.value = ` storefront `;
        await add.create();
        const link = new URL(openDesktopLink.mock.calls[0]?.[0] ?? ``);
        expect({
            made: create.mock.calls.map(([name]) => name),
            started: add.started.value?.kind,
            code: link.searchParams.get(`code`),
            sandbox: link.searchParams.get(`sandbox`),
            name: link.searchParams.get(`name`),
        }).toEqual({ made: [`storefront`], started: `here`, code: `code-new`, sandbox: `new`, name: `storefront` });
    });

    it(`sets it up on the machine picked, through the sandbox that reaches it, with the row's code`, async () => {
        const { add } = stage({ machines: [rog] });
        await add.read();
        add.pick.value = `rog`;
        await add.create();
        expect({ started: add.started.value?.kind, call: manageDeviceSandbox.mock.calls[0]?.slice(0, 3) }).toEqual({
            started: `machine`,
            call: [`rog`, `sandbox-abc`, `create`],
        });
    });

    it(`starts a machine of ours on the row`, async () => {
        const { add, hostedProvision } = stage({ hosted: { enabled: true, remaining: 1 } });
        await add.read();
        await add.create();
        expect({ started: add.started.value?.kind, provisioned: hostedProvision.mock.calls.map(([id]) => id) }).toEqual({
            started: `hosted`,
            provisioned: [`new`],
        });
    });

    it(`deletes the row and brings the form back when no code could be minted for it`, async () => {
        const { add, remove } = stage({ machines: [rog], setupCode: new Error(`down`) });
        await add.read();
        await add.create();
        expect({ started: add.started.value, removed: remove.mock.calls.map(([id]) => id), error: add.error.value !== null }).toEqual({
            started: undefined,
            removed: [`new`],
            error: true,
        });
    });

    it(`deletes the row when the machine of ours is refused`, async () => {
        const { add, remove } = stage({ provision: new Error(`no`) });
        await add.read();
        await add.create();
        expect({ started: add.started.value, removed: remove.mock.calls.map(([id]) => id), error: add.error.value !== null }).toEqual({
            started: undefined,
            removed: [`new`],
            error: true,
        });
    });

    it(`keeps the row a machine already has when its run fails, for the same press again`, async () => {
        manageDeviceSandbox.mockRejectedValueOnce(new Error(`docker is not running`));
        const { add, remove } = stage({ machines: [rog] });
        await add.read();
        await add.create();
        expect({ started: add.started.value?.kind, failed: add.onMachine.run.failure.value !== undefined, removed: remove.mock.calls.length }).toEqual({
            started: `machine`,
            failed: true,
            removed: 0,
        });
        await add.retry();
        expect({ calls: manageDeviceSandbox.mock.calls.length, failed: add.onMachine.run.failure.value !== undefined }).toEqual({ calls: 2, failed: false });
    });

    it(`makes nothing for a name it refuses`, async () => {
        const { add, create } = stage({ machines: [rog] });
        await add.read();
        add.name.value = ``;
        await add.create();
        expect(create).not.toHaveBeenCalled();
    });
});
