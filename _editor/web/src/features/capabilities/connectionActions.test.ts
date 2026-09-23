// Pins what a row confirms before it acts: a removal and a disconnect close their dialog whether or not the daemon took
// them (the refusal goes to the page's notice), a rename stays open on its own refusal, and a disconnect re-reads the
// device list either way.
import "@intentic/testing/dom";
import type { NoticeModel } from "@intentic/ui";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { effectScope, type EffectScope, ref } from "vue";
import * as actualUseDevices from "../sandbox/devices/useDevices";
import type { DeviceConnection } from "./model/deviceConnections";

// The one call a disconnect makes, answered per case.
const revokeSyncDevice = mock<(machine: string) => Promise<void>>(async () => {});
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realUseDevices = { ...actualUseDevices };
mock.module(`../sandbox/devices/useDevices`, () => ({ ...realUseDevices, revokeSyncDevice }));

const { useConnectionActions } = await import("./connectionActions");

const ROG: DeviceConnection = {
    id: `device:rog`,
    entryId: `linux`,
    title: `rog`,
    detail: `Linux`,
    state: `live`,
    tone: `success`,
    rank: 3,
    note: `no command access`,
    machine: `rog`,
};

const scopes: EffectScope[] = [];
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    revokeSyncDevice.mockReset();
});

const actionsOn = () => {
    const state = {
        remove: { mutateAsync: mock<(id: string) => Promise<unknown>>(async () => undefined) },
        rename: { mutateAsync: mock<(input: { id: string; to: string }) => Promise<unknown>>(async () => undefined) },
        refetchFleet: mock(),
        error: ref<NoticeModel | null>({ tone: `danger`, title: `an older failure` }),
    };
    const scope = effectScope();
    scopes.push(scope);
    return { state, actions: scope.run(() => useConnectionActions(state))! };
};

describe(`removing a connection`, () => {
    it(`does nothing until a connection is being confirmed`, async () => {
        const { state, actions } = actionsOn();

        await actions.confirmRemove();
        expect(state.remove.mutateAsync.mock.calls).toEqual([]);
    });

    it(`removes the one named in the dialog and closes it`, async () => {
        const { state, actions } = actionsOn();
        actions.confirmRemoveId.value = `office`;

        await actions.confirmRemove();
        expect(state.remove.mutateAsync.mock.calls).toEqual([[`office`]]);
        expect(actions.confirmRemoveId.value).toBeUndefined();
        expect(state.error.value).toBeNull();
    });

    it(`closes on a refusal too, saying why on the page`, async () => {
        const { state, actions } = actionsOn();
        actions.confirmRemoveId.value = `office`;
        state.remove.mutateAsync.mockRejectedValueOnce(new Error(`in use by a running turn`));

        await actions.confirmRemove();
        expect(actions.confirmRemoveId.value).toBeUndefined();
        expect(state.error.value).toEqual({ tone: `danger`, title: `Could not remove the capability.`, detail: `in use by a running turn` });
    });
});

describe(`renaming a connection`, () => {
    it(`opens on a clean slate, renames, and closes`, async () => {
        const { state, actions } = actionsOn();
        actions.renameError.value = { tone: `danger`, title: `Could not rename that connection.` };

        actions.askRename(`office`);
        expect([actions.renameId.value, actions.renameError.value]).toEqual([`office`, undefined]);
        await actions.confirmRename(`hq`);
        expect([state.rename.mutateAsync.mock.calls, actions.renameId.value]).toEqual([[[{ id: `office`, to: `hq` }]], undefined]);
    });

    it(`stays open with the refusal beside the name still in the field`, async () => {
        const { state, actions } = actionsOn();
        state.rename.mutateAsync.mockRejectedValueOnce(new Error(`hq is taken`));

        actions.askRename(`office`);
        await actions.confirmRename(`hq`);
        expect(actions.renameId.value).toBe(`office`);
        expect(actions.renameError.value).toEqual({ tone: `danger`, title: `Could not rename that connection.`, detail: `hq is taken` });
    });

    it(`does nothing with no connection being renamed`, async () => {
        const { state, actions } = actionsOn();

        await actions.confirmRename(`hq`);
        expect(state.rename.mutateAsync.mock.calls).toEqual([]);
    });
});

describe(`disconnecting a machine that only syncs`, () => {
    it(`ends its enrollment by the machine's name, busy while the daemon works, and re-reads the device list`, async () => {
        const { state, actions } = actionsOn();
        let done: () => void = () => undefined;
        revokeSyncDevice.mockImplementationOnce(() => new Promise<void>((resolve) => (done = resolve)));
        actions.disconnecting.value = ROG;

        const pending = actions.confirmDisconnectDevice();
        expect([actions.disconnectingDevice.value, state.error.value, revokeSyncDevice.mock.calls]).toEqual([true, null, [[`rog`]]]);
        done();
        await pending;

        expect([actions.disconnectingDevice.value, state.refetchFleet.mock.calls.length]).toEqual([false, 1]);
        expect(actions.disconnecting.value).toBeUndefined();
    });

    it(`closes and re-reads on a refusal too, saying why on the page`, async () => {
        const { state, actions } = actionsOn();
        revokeSyncDevice.mockRejectedValueOnce(new Error(`owner only`));
        actions.disconnecting.value = ROG;

        await actions.confirmDisconnectDevice();
        expect(state.error.value).toEqual({ tone: `danger`, title: `Could not disconnect that machine.`, detail: `owner only` });
        expect([actions.disconnectingDevice.value, state.refetchFleet.mock.calls.length]).toEqual([false, 1]);
        expect(actions.disconnecting.value).toBeUndefined();
    });

    it(`does nothing with no machine named`, async () => {
        const { state, actions } = actionsOn();

        await actions.confirmDisconnectDevice();
        expect([revokeSyncDevice.mock.calls, state.refetchFleet.mock.calls]).toEqual([[], []]);
    });
});
