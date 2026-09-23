import "@intentic/testing/dom";
import type { AddressOffer, HostedOffer, SandboxSummary, SetupCode } from "@intentic/api-contract";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { computed, type EffectScope, effectScope, ref } from "vue";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { ladderOptionsOf } from "./machineLadder";
import { type CommandLaneHost, useCommandLane } from "./useCommandLane";
import { type HostedLaneHost, useHostedLane } from "./useHostedLane";
import { type SetupArrivalHost, useSetupArrival } from "./useSetupArrival";
import { type SetupRowHost, useSetupRow } from "./useSetupRow";

// Pins what arriving does by itself, over the lanes as the page runs them: a browser starts a machine only for a row it
// made and only where one can be had, the app installs on its own computer (handing back an idle machine first, and
// handing the code over once), a refusal brings the picker back, and a lost offer read is retried rather than judged.

interface World {
    readonly rows?: readonly SandboxSummary[];
    readonly hosted?: HostedOffer | Error;
    readonly address?: AddressOffer | Error;
    readonly inApp?: boolean;
    readonly query?: Record<string, string>;
}

const scopes: EffectScope[] = [];

const stage = (world: World = {}) => {
    const list = jest.fn(async () => [...(world.rows ?? [])]);
    const select = jest.fn((_id: string) => undefined);
    const create = jest.fn(async (name: string) => sandboxSummary({ id: `new`, name, token: `tok` }));
    const hostedProvision = jest.fn(async (id: string, _token: string) =>
        sandboxSummary({ id, token: `tok`, hosted: { region: `iad`, warm: true } }),
    );
    const hostedRelease = jest.fn(async (id: string) => sandboxSummary({ id, token: `tok` }));
    const answer = <T>(value: T | Error): Promise<T> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
    const platform = {
        hostedOffer: jest.fn(() => answer(world.hosted ?? { enabled: true, remaining: 1 })),
        addressOffer: jest.fn(() => answer(world.address ?? { enabled: true })),
        setupCode: jest.fn(async ({ sandboxId }: { sandboxId: string }): Promise<SetupCode> => ({
            code: `code-${sandboxId}`,
            hostname: `h.sbx.test`,
            expiresAt: `later`,
        })),
    };
    const runHere = jest.fn(() => undefined);
    const warmCredential = jest.fn(async () => undefined);
    const route = { query: world.query ?? {} };
    const scope = effectScope();
    scopes.push(scope);
    const flow = scope.run(() => {
        const row = useSetupRow({
            sandbox: unstubbed<SetupRowHost[`sandbox`]>(`sandbox`, { sandboxes: ref([]), create, select, remove: jest.fn(async () => undefined) }),
            enter: jest.fn(async () => undefined),
        });
        const hosted = useHostedLane({
            platform: unstubbed<HostedLaneHost[`platform`]>(`platform`, { hostedOffer: platform.hostedOffer }),
            sandbox: unstubbed<HostedLaneHost[`sandbox`]>(`sandbox`, { hostedProvision, hostedRelease }),
            row,
        });
        const lane = ref<`provision` | `attach`>(`provision`);
        const command = useCommandLane({
            platform: unstubbed<CommandLaneHost[`platform`]>(`platform`, { setupCode: platform.setupCode }),
            row,
            hosted,
            lane,
        });
        const ladder = computed(() =>
            ladderOptionsOf({
                hostedOffered: hosted.hostedOffered.value,
                hostedFull: hosted.hostedFull.value,
                hostedSuspended: hosted.hostedSuspended.value,
                plan: false,
                hours: null,
                commandOffered: command.addressed.value,
                installer: undefined,
            }),
        );
        const arrival = useSetupArrival({
            sandbox: unstubbed<SetupArrivalHost[`sandbox`]>(`sandbox`, { list, select }),
            platform: unstubbed<SetupArrivalHost[`platform`]>(`platform`, { hostedOffer: platform.hostedOffer, addressOffer: platform.addressOffer }),
            row,
            hosted,
            command,
            route,
            inApp: ref(world.inApp ?? false),
            ladder,
            warmCredential,
            runHere,
        });
        return { row, hosted, command, arrival };
    })!;
    return { list, select, create, hostedProvision, hostedRelease, platform, runHere, warmCredential, ...flow };
};

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    jest.useRealTimers();
});

describe(`a browser's arrival`, () => {
    it(`starts a machine for the row it made, and warms the sandbox credential`, async () => {
        const { create, hostedProvision, warmCredential, hosted, arrival } = stage();
        await arrival.readArrival();
        expect(create.mock.calls).toEqual([[`workspace`]]);
        expect(hostedProvision.mock.calls).toEqual([[`new`, `tok`]]);
        expect({ arrival: arrival.arrival.value, machine: hosted.machine.value, loaded: arrival.loaded.value }).toEqual({
            arrival: `hosted`,
            machine: `hosted`,
            loaded: true,
        });
        expect(warmCredential).toHaveBeenCalledTimes(1);
    });

    it(`resumes a row it found rather than starting anything for it`, async () => {
        const found = sandboxSummary({ id: `s1`, token: `tok`, setupCodeClaimedAt: `2026-09-23T10:00:00Z` });
        const { select, create, hostedProvision, row, arrival } = stage({ rows: [found], query: { sandbox: `s1` } });
        await arrival.readArrival();
        expect(select.mock.calls).toEqual([[`s1`]]);
        expect({ id: row.created.value?.id, resuming: row.resuming.value, arrival: arrival.arrival.value }).toEqual({
            id: `s1`,
            resuming: true,
            arrival: `choose`,
        });
        expect([create, hostedProvision].map((call) => call.mock.calls.length)).toEqual([0, 0]);
    });

    it(`picks up the machine already on the row, onto the wait card`, async () => {
        const found = sandboxSummary({ id: `h1`, token: `tok`, hosted: { region: `iad`, warm: false } });
        const { hostedProvision, hosted, arrival } = stage({ rows: [found] });
        await arrival.readArrival();
        expect(hosted.machine.value).toBe(`hosted`);
        expect(hosted.hostedSince.value).toBe(Date.now());
        expect(hostedProvision).not.toHaveBeenCalled();
    });
});

describe(`the app's arrival`, () => {
    it(`installs on this computer, handing the code to the app once however often it is minted again`, async () => {
        const { runHere, command, arrival } = stage({ inApp: true });
        await arrival.readArrival();
        expect(arrival.arrival.value).toBe(`local`);
        await advanceTimersByTimeAsync(500);
        expect(command.commandReady.value).toBe(true);
        expect(runHere).toHaveBeenCalledTimes(1);
        command.remint();
        await advanceTimersByTimeAsync(0);
        expect(runHere).toHaveBeenCalledTimes(1);
    });

    it(`keeps the machine and shows the picker when the platform will not take it back`, async () => {
        const found = sandboxSummary({ id: `h1`, token: `tok`, hosted: { region: `iad`, warm: false } });
        const { hostedRelease, hosted, arrival } = stage({ rows: [found], inApp: true });
        hostedRelease.mockRejectedValueOnce(new Error(`network`));
        await arrival.readArrival();
        expect({ machine: hosted.machine.value, arrival: arrival.arrival.value }).toEqual({ machine: `hosted`, arrival: `choose` });
    });
});

describe(`offers that could not be read`, () => {
    it(`are a retry rather than a verdict, and reading again finds the same row`, async () => {
        const { create, list, platform, arrival } = stage({ hosted: new Error(`timeout`), address: new Error(`timeout`) });
        await arrival.readArrival();
        expect(arrival.lanes.value).toEqual({ kind: `unreachable` });
        platform.hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
        list.mockResolvedValue([sandboxSummary({ id: `new`, token: `tok` })]);
        await arrival.readArrival();
        expect(arrival.laneTakeable.value).toBe(true);
        expect(create).toHaveBeenCalledTimes(1);
    });
});

describe(`a replacement sandbox`, () => {
    it(`lands on the picker, and may be handed to the app afresh`, async () => {
        const { runHere, command, arrival } = stage({ inApp: true });
        await arrival.readArrival();
        await advanceTimersByTimeAsync(500);
        arrival.forget();
        expect(arrival.arrival.value).toBe(`choose`);
        await advanceTimersByTimeAsync(0);
        arrival.arrival.value = `local`;
        command.remint();
        await advanceTimersByTimeAsync(0);
        expect(runHere).toHaveBeenCalledTimes(2);
    });
});
