import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import { inSetup } from "../../../testing/inSetup";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { hostedBlock, type HostedStartHost, useHostedStart } from "./useHostedStart";
import type { HostedOffer } from "@intentic/api-contract";

const REQUEST = `56ef8187-00b7-4235-9fa2-27db9121d9ee`;
const NEXT_REQUEST = `56ef8187-00b7-4235-9fa2-27db9121d9ef`;
const stage = (rows = [sandboxSummary({ id: `local`, lastSeenAt: `2026-10-20T00:00:00Z` })]) => {
    let saved: ReturnType<HostedStartHost[`journey`][`read`]>;
    let nextRequest = REQUEST;
    const listed = [...rows];
    const offer = jest.fn<HostedStartHost[`platform`][`sandbox`][`hostedOffer`]>(async () => ({ enabled: true, startJourney: true, remaining: 1 }));
    const create = jest.fn<HostedStartHost[`sandbox`][`create`]>(async () => {
        const row = sandboxSummary({ id: `new`, token: `token` });
        listed.push(row);
        return row;
    });
    const refresh = jest.fn<HostedStartHost[`sandbox`][`refresh`]>(async () => [...listed]);
    const reset = jest.fn(() => {
        saved = undefined;
    });
    const enter = jest.fn<HostedStartHost[`enter`]>(async () => undefined);
    const checkout = jest.fn<HostedStartHost[`platform`][`hostedPlan`][`checkout`]>(async () => ({ url: `https://checkout.example/session` }));
    const setSlots = jest.fn<HostedStartHost[`platform`][`hostedPlan`][`setSlots`]>(async () => ({ enabled: true, onPlan: true, priceUsd: 20 }));
    const state = jest.fn<HostedStartHost[`platform`][`hostedPlan`][`state`]>(async () => ({ enabled: true, onPlan: false, priceUsd: 20 }));
    const redirect = jest.fn();
    const host: HostedStartHost = {
        platform: {
            sandbox: unstubbed<HostedStartHost[`platform`][`sandbox`]>(`sandbox`, { hostedOffer: offer }),
            hostedPlan: unstubbed<HostedStartHost[`platform`][`hostedPlan`]>(`plan`, { state, checkout, setSlots }),
        },
        sandbox: unstubbed<HostedStartHost[`sandbox`]>(`store`, { refresh, create }),
        journey: {
            read: () => saved,
            request: () => {
                saved ??= { requestId: nextRequest };
                return saved.requestId;
            },
            remember: (requestId, sandboxId, tier) => {
                saved = { requestId, sandboxId, tier };
                nextRequest = NEXT_REQUEST;
            },
            reset,
        },
        enter,
        redirect,
        exclusive: (work) => work(),
    };
    const mounted = inSetup(() => useHostedStart(host));
    return { ...mounted.result, stop: mounted.stop, offer, createCall: create, refresh, reset, enter, checkout, setSlots, state, redirect, host };
};

it(`reads cloud options for an existing local workspace without creating or opening anything`, async () => {
    const world = stage();
    await world.load();
    expect(world.loaded.value).toBe(true);
    expect(world.owned.value).toEqual([]);
    expect(world.createCall).not.toHaveBeenCalled();
    expect(world.enter).not.toHaveBeenCalled();
    expect(world.tier.value).toBe(`free`);
    world.stop();
});

it(`distinguishes owned cloud sandboxes from shared access`, async () => {
    const owned = sandboxSummary({ id: `ours`, hosted: { region: `iad`, warm: false } });
    const shared = sandboxSummary({ id: `theirs`, role: `viewer`, hosted: { region: `iad`, warm: false } });
    const world = stage([owned, shared]);
    await world.load();
    expect(world.owned.value.map((row) => row.id)).toEqual([`ours`]);
    expect(world.shared.value.map((row) => row.id)).toEqual([`theirs`]);
    expect(world.createCall).not.toHaveBeenCalled();
    world.stop();
});

it.each([
    [{ enabled: false, remaining: 0 }, `unavailable`],
    [{ enabled: true, remaining: 1 }, `upgrade`],
    [{ enabled: true, startJourney: true, remaining: 0, needsGoogle: true }, `google`],
    [{ enabled: true, startJourney: true, remaining: 0, full: true }, `full`],
    [{ enabled: true, startJourney: true, remaining: 0, suspended: true }, `restricted`],
    [{ enabled: true, startJourney: true, remaining: 0 }, `occupied`],
    [{ enabled: true, startJourney: true, remaining: 1, hours: { allowance: 40, remaining: 0 } }, `hours`],
] satisfies [HostedOffer, string][])(`explains %j as %s without falling back to this computer`, async (offer, expected) => {
    expect(hostedBlock(offer)).toBe(expected);
    const world = stage();
    world.offer.mockResolvedValue(offer);
    await world.load();
    await world.create();
    expect(world.createCall).not.toHaveBeenCalled();
    expect(world.enter).not.toHaveBeenCalled();
    world.stop();
});

it(`commits one stable request, then hands the named sandbox and hosted tier to setup`, async () => {
    const world = stage();
    await world.load();
    await world.create();
    expect(world.createCall.mock.calls).toEqual([[`workspace`, REQUEST]]);
    expect(world.enter.mock.calls).toEqual([[`new`, `free`]]);
    await world.create();
    expect(world.createCall.mock.calls).toEqual([
        [`workspace`, REQUEST],
        [`workspace`, REQUEST],
    ]);
    expect(world.host.journey.read()).toEqual({ requestId: REQUEST, sandboxId: `new`, tier: `free` });
    world.stop();
});

it(`keeps the request after a lost creation response and reuses it on retry`, async () => {
    const world = stage();
    world.createCall.mockRejectedValueOnce(new Error(`response lost`));
    await world.load();
    await world.create();
    expect(world.error.value).toBe(`response lost`);
    await world.create();
    expect(world.createCall.mock.calls).toEqual([
        [`workspace`, REQUEST],
        [`workspace`, REQUEST],
    ]);
    world.stop();
});

it(`keeps a failed account read retryable without creating a draft`, async () => {
    const world = stage();
    world.offer.mockRejectedValueOnce(new Error(`offline`));
    await world.load();
    expect(world.loaded.value).toBe(false);
    expect(world.error.value).toBe(`offline`);
    await world.create();
    expect(world.createCall).not.toHaveBeenCalled();
    await world.load();
    expect(world.loaded.value).toBe(true);
    world.stop();
});

it(`checks the selected paid tier and returns checkout to cloud setup without creating a draft`, async () => {
    const world = stage();
    world.offer.mockResolvedValue({ enabled: true, startJourney: true, remaining: 0 });
    await world.chooseTier(`standard`);
    expect(world.offer.mock.calls).toEqual([[{ tier: `standard` }]]);
    await world.purchase();
    expect(world.checkout.mock.calls).toEqual([[{ tier: `standard`, returnTo: `/start/hosted` }]]);
    expect(world.redirect.mock.calls).toEqual([[`https://checkout.example/session`]]);
    expect(world.createCall).not.toHaveBeenCalled();
    world.stop();
});

it(`does not purchase when the selected tier already has room`, async () => {
    const world = stage();
    await world.chooseTier(`standard`);
    await world.purchase();
    expect(world.checkout).not.toHaveBeenCalled();
    expect(world.setSlots).not.toHaveBeenCalled();
    world.stop();
});

it(`rechecks entitlement before adding a charge`, async () => {
    const world = stage();
    world.offer.mockResolvedValueOnce({ enabled: true, startJourney: true, remaining: 0 });
    await world.chooseTier(`standard`);
    await world.purchase();
    expect(world.block.value).toBe(undefined);
    expect(world.checkout).not.toHaveBeenCalled();
    expect(world.setSlots).not.toHaveBeenCalled();
    world.stop();
});

it(`retries an ambiguous subscription update at the same absolute quantity`, async () => {
    const world = stage();
    world.offer.mockResolvedValue({ enabled: true, startJourney: true, remaining: 0 });
    world.state.mockResolvedValue({ enabled: true, onPlan: true, priceUsd: 20 });
    world.setSlots.mockRejectedValueOnce(new Error(`response lost`));
    await world.chooseTier(`standard`);
    await world.purchase();
    expect(world.error.value).toBe(`response lost`);
    await world.purchase();
    expect(world.setSlots.mock.calls).toEqual([[{ tier: `standard`, quantity: 1 }], [{ tier: `standard`, quantity: 1 }]]);
    expect(world.checkout).not.toHaveBeenCalled();
    world.stop();
});

it(`resumes a committed journey at its original tier across a second tab's different choice`, async () => {
    const world = stage();
    world.host.journey.remember(REQUEST, `new`, `standard`);
    await world.load();
    world.refresh.mockResolvedValueOnce([sandboxSummary({ id: `new`, token: `token` })]);
    await world.create();
    expect(world.enter.mock.calls).toEqual([[`new`, `standard`]]);
    expect(world.reset).not.toHaveBeenCalled();
    world.stop();
});

it(`starts a new journey when a fresh account read confirms the previous sandbox was removed`, async () => {
    const world = stage();
    world.host.journey.remember(REQUEST, `removed`, `standard`);
    await world.load();
    await world.create();
    expect(world.refresh).toHaveBeenCalledTimes(2);
    expect(world.reset).toHaveBeenCalledTimes(1);
    expect(world.createCall.mock.calls).toEqual([[`workspace`, NEXT_REQUEST]]);
    expect(world.enter.mock.calls).toEqual([[`new`, `free`]]);
    expect(world.host.journey.read()).toEqual({ requestId: NEXT_REQUEST, sandboxId: `new`, tier: `free` });
    world.stop();
});

it(`keeps the previous request when its existence cannot be checked`, async () => {
    const world = stage();
    world.host.journey.remember(REQUEST, `new`, `standard`);
    await world.load();
    world.refresh.mockRejectedValueOnce(new Error(`offline`));
    await world.create();
    expect(world.error.value).toBe(`offline`);
    expect(world.reset).not.toHaveBeenCalled();
    expect(world.createCall).not.toHaveBeenCalled();
    world.stop();
});
