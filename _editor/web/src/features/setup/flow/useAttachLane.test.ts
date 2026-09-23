import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { type EffectScope, effectScope, ref } from "vue";
import type { AttachOutcome } from "../setupAttach";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { type AttachLaneHost, useAttachLane } from "./useAttachLane";
import { type SetupRowHost, useSetupRow } from "./useSetupRow";

// Pins the attach lane: nothing is probed for an address that is not one, for our own, or twice at once; the probe
// presents the pasted token over the row's own; any answer but ok is kept for the card to explain; and only an
// admitted daemon is recorded on the row, which is then the workspace that opens.

const scopes: EffectScope[] = [];

const stage = (over: { minted?: string; idToken?: string | undefined; outcome?: AttachOutcome } = {}) => {
    const rows = unstubbed<SetupRowHost[`sandbox`]>(`sandbox`, {
        sandboxes: ref([]),
        create: mock(async (name: string) => sandboxSummary({ id: `new`, name, token: `new-token` })),
        select: mock(),
        remove: mock(async () => undefined),
    });
    const enter = mock(async () => undefined);
    const attach = mock(async (_id: string, _url: string) => undefined);
    const probe = mock<AttachLaneHost[`probe`]>(async () => over.outcome ?? { kind: `ok` });
    const getIdToken = mock(async () => (`idToken` in over ? over.idToken : `id-token`));
    const scope = effectScope();
    scopes.push(scope);
    const { row, lane } = scope.run(() => {
        const setupRow = useSetupRow({ sandbox: rows, enter });
        const attachLane = useAttachLane({
            sandbox: unstubbed<AttachLaneHost[`sandbox`]>(`sandbox`, { attach }),
            row: setupRow,
            minted: () => over.minted,
            getIdToken,
            probe,
        });
        return { row: setupRow, lane: attachLane };
    })!;
    return { rows, enter, attach, probe, getIdToken, row, lane };
};

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

describe(`what may be probed`, () => {
    it(`probes nothing until the field holds an https domain`, async () => {
        const { probe, lane } = stage();
        await lane.connectDomain();
        lane.domain.value = `http://sandbox.example.com`;
        expect(lane.domainProblem.value).toBe(
            `Needs to be https. This app is served over HTTPS, so your browser would block calls to an http:// sandbox.`,
        );
        await lane.connectDomain();
        expect(probe).not.toHaveBeenCalled();
    });

    it(`refuses an address of ours before the press, since nothing answers there until the command runs`, async () => {
        const { probe, lane } = stage({ minted: `sandbox-fa0b431303b8.sbx.intentic.dev` });
        lane.domain.value = `sandbox-fa0b431303b8.sbx.intentic.dev`;
        expect(lane.ownAddress.value).toBe(
            `That address is ours, and it answers only once your sandbox is running. Nothing to connect to yet: run the install command instead.`,
        );
        await lane.connectDomain();
        expect(probe).not.toHaveBeenCalled();
    });

    it(`drops a second press while the first is still probing`, async () => {
        const { probe, lane } = stage();
        lane.domain.value = `sandbox.example.com/`;
        const first = lane.connectDomain();
        await lane.connectDomain();
        await first;
        expect(probe.mock.calls).toEqual([[{ daemonUrl: `https://sandbox.example.com`, idToken: `id-token` }]]);
        expect(lane.attaching.value).toBe(false);
    });

    it(`asks for a Google sign-in rather than probing without one`, async () => {
        const { probe, row, lane } = stage({ idToken: undefined });
        lane.domain.value = `sandbox.example.com`;
        await lane.connectDomain();
        expect(row.error.value).toEqual({ tone: `danger`, title: `Sign in with Google to reach your sandbox.` });
        expect(probe).not.toHaveBeenCalled();
    });
});

describe(`the probe's answer`, () => {
    it(`presents the pasted token over the row's own`, async () => {
        const { probe, row, lane } = stage({ outcome: { kind: `needs-token` } });
        row.created.value = sandboxSummary({ id: `s1`, token: `row-token` });
        lane.domain.value = `sandbox.example.com`;
        await lane.connectDomain();
        lane.attachToken.value = ` pasted `;
        await lane.connectDomain();
        expect(probe.mock.calls.map(([args]) => args.connectToken)).toEqual([`row-token`, `pasted`]);
        expect(lane.attachOutcome.value).toEqual({ kind: `needs-token` });
    });

    it(`records nothing for a daemon that did not let this account in`, async () => {
        const { attach, lane } = stage({ outcome: { kind: `denied`, message: `Owned by someone else.` } });
        lane.domain.value = `sandbox.example.com`;
        await lane.connectDomain();
        expect(lane.attachOutcome.value).toEqual({ kind: `denied`, message: `Owned by someone else.` });
        expect(attach).not.toHaveBeenCalled();
    });

    it(`records an admitted daemon on the row and opens the workspace on it`, async () => {
        const { rows, enter, attach, row, lane } = stage();
        row.created.value = sandboxSummary({ id: `s1` });
        lane.domain.value = `sandbox.example.com`;
        await lane.connectDomain();
        expect(attach.mock.calls).toEqual([[`s1`, `https://sandbox.example.com`]]);
        expect(rows.select).toHaveBeenCalledWith(`s1`);
        expect(enter).toHaveBeenCalledTimes(1);
        expect(row.finished.value).toBe(true);
    });

    it(`creates the row first when the arrival's create never landed`, async () => {
        const { attach, lane } = stage();
        lane.domain.value = `sandbox.example.com`;
        await lane.connectDomain();
        expect(attach.mock.calls).toEqual([[`new`, `https://sandbox.example.com`]]);
    });

    it(`says why the connection failed`, async () => {
        const { attach, row, lane } = stage();
        attach.mockRejectedValueOnce(new Error(`already attached elsewhere`));
        lane.domain.value = `sandbox.example.com`;
        await lane.connectDomain();
        expect(row.error.value).toEqual({ tone: `danger`, title: `Could not connect your sandbox.`, detail: `already attached elsewhere` });
    });

    it(`forgets a half-finished attach`, () => {
        const { lane } = stage();
        const left = () => ({ outcome: lane.attachOutcome.value, token: lane.attachToken.value });
        lane.attachOutcome.value = { kind: `timeout` };
        lane.attachToken.value = `pasted`;
        lane.resetAttach();
        expect(left()).toEqual({ outcome: undefined, token: `` });
    });
});
