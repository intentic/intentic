// THE LOCK SCREEN AND ADMINISTRATOR PROMPTS ROW on a Windows computer's remote access section: what it says the service
// is, the one thing it offers a maintainer, what it says while the computer's administrator is being asked, and how a
// no and a failure come back. The computer is the injected service api; nothing reaches a sandbox.
import type { Device } from "@intentic/sandbox-contract/schemas/devices";
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, ref } from "vue";
import type { RemoteServiceChange, RemoteServiceState } from "../../../../models/sandbox/devices/remote/remoteApi";
import { deviceRow } from "../../../../models/sandbox/devices/deviceRows";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";

jest.mock(`../../../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc() }));
jest.mock(`../../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ active: computed(() => ({ id: `s1`, name: `work`, tier: `owner` })), activeSandboxId: ref(`s1`), reachable: ref(true) }),
}));

const { default: RemoteServiceRow } = await import("./RemoteServiceRow.vue");
const { REMOTE_SERVICE_API } = await import("../../../../models/sandbox/devices/remote/remoteApi");
const { forgetOperations } = await import("../../../../workbench/operations/operations");
const { queryClient } = await import("../../../../lib/queryPersistence");

const NOT_SET_UP: RemoteServiceState = { supported: true, installed: false, outOfDate: false, agentVersion: `1.431.0` };
const SET_UP: RemoteServiceState = { supported: true, installed: true, state: `running`, version: `1.431.0`, agentVersion: `1.431.0`, outOfDate: false };

// The computer as the row reaches it: its status as `now` holds it, and each change held until the test answers it,
// as the person at the computer answers the UAC prompt.
const computer = (start: RemoteServiceState) => {
    let now = start;
    const asked: RemoteServiceChange[] = [];
    let answer: ((after: RemoteServiceState) => void) | undefined;
    const api = {
        service: async () => now,
        changeService: async (_device: string, action: RemoteServiceChange) => {
            asked.push(action);
            const after = await new Promise<RemoteServiceState>((done) => void (answer = done));
            if (after.declined !== true && after.error === undefined) {
                now = after;
            }
            return after;
        },
    };
    return { api, asked, answers: (after: RemoteServiceState) => answer?.(after) };
};

// SAFETY: a fixture's facts, holding only the field the row reads; the rest of DeviceFacts is optional to it.
const rog = deviceRow(
    { key: `rog`, label: `rog`, hostId: `rog`, card: `rog`, online: true, platform: `windows`, facts: { features: [`remote`, `remote-service`] } as Device[`facts`] },
    undefined,
);

let app: App | undefined;
const mount = (api: ReturnType<typeof computer>[`api`], editable = true): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(RemoteServiceRow, { row: rog, machineName: `rog`, editable }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.use(VueQueryPlugin, { queryClient });
    app.provide(REMOTE_SERVICE_API, api);
    app.mount(el);
};
const shown = (): string => document.body.textContent ?? ``;
const button = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((each) => each.textContent?.trim() === label);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();
    forgetOperations();
});

it(`sets it up through the computer's administrator, saying so while it waits, then offers removing it`, async () => {
    const pc = computer(NOT_SET_UP);
    mount(pc.api);
    await waitFor(() => expect(shown()).toContain(`Not set up`));
    expect(shown()).toContain(`Lock screen and admin prompts`);
    button(`Set up`)?.click();

    await waitFor(() => expect(shown()).toContain(`Waiting for the administrator’s yes on rog…`));
    expect(pc.asked).toEqual([`install`]);
    expect(button(`Set up`)).toBeUndefined();

    pc.answers(SET_UP);
    await waitFor(() => expect(button(`Remove`)).not.toBeUndefined());
    expect(shown()).not.toContain(`Waiting for the administrator`);
});

it(`offers an update for an older service, and says so when the administrator does not say yes`, async () => {
    const older = { ...SET_UP, version: `1.430.0`, outOfDate: true };
    const pc = computer(older);
    mount(pc.api);
    await waitFor(() => expect(shown()).toContain(`Set up, older version`));
    button(`Update`)?.click();
    await waitFor(() => expect(pc.asked).toEqual([`install`]));

    pc.answers({ ...older, declined: true });
    await waitFor(() => expect(shown()).toContain(`The administrator’s yes wasn’t given on rog, so nothing changed.`));
    expect(button(`Update`)).not.toBeUndefined();
});

it(`shows the computer's own words when the change did not do what it was asked`, async () => {
    const pc = computer(SET_UP);
    mount(pc.api);
    await waitFor(() => expect(button(`Remove`)).not.toBeUndefined());
    button(`Remove`)?.click();
    await waitFor(() => expect(pc.asked).toEqual([`uninstall`]));

    pc.answers({ ...SET_UP, error: `Removing the lock-screen service failed as administrator (intentic-remoted exited 1).` });
    await waitFor(() => expect(shown()).toContain(`Couldn’t change the lock-screen service`));
    expect(shown()).toContain(`Removing the lock-screen service failed as administrator (intentic-remoted exited 1).`);
});

it(`shows anyone below Full access where it stands, with nothing to press`, async () => {
    mount(computer(NOT_SET_UP).api, false);
    await waitFor(() => expect(shown()).toContain(`Not set up`));
    expect(document.body.querySelectorAll(`button`)).toHaveLength(0);
});
