// A swap run from this button is relayed by the daemon it replaces, so its stream dies at the cutover. That is the swap
// happening: the button waits for the sandbox to come back and then gets out of the way, leaving the card to say how it
// went, instead of ending every self-update in "Lost contact with that device". Only a stream that died while the
// sandbox never went quiet is lost contact, and a device that answered in words is quoted. The wait is armed at the
// press and ends on the sandbox answering on what it was swapped onto, since a relayed stream can stay open forever.
import "@intentic/testing/dom";
import type { EnvironmentRebuildWait } from "@intentic/sandbox-contract";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { useOsPreference } from "@intentic/ui";
import { IconStub } from "@intentic/ui/testing";
import * as useDevicesOriginal from "../../../sandbox/devices/useDevices";
import { bashCommand } from "../../../../app/environments/scriptCommand";

const reachable = ref(true);
const fleet = ref<{ id: string; title: string; status: string }[]>([]);
jest.mock(`../../../agents/fleet/useAgents`, () => ({ useAgents: () => ({ fleet, refresh: async () => undefined }) }));
const autoResume = ref(false);
jest.mock(`../../../sandbox/overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings: computed(() => ({ autoResumeOnRestart: autoResume.value })) }),
}));
// What the sandbox answering right now runs: the version an update moves, the overlay a rebuild aims at.
interface Answering {
    version?: string;
    hash?: string;
}
const answering: Answering = { version: `1.316.0` };
jest.mock(`./swapLanding`, () => ({ appliedHash: async () => answering.hash, runningVersion: async () => answering.version }));
const swapServingSandbox = jest.fn(async (_hostId: string, _slug: string, _op: string): Promise<string | undefined> => undefined);
// Imported statically and spread: a module loaded inside a mock factory deadlocks bun's link of the graph naming it.
// The machine this page can ask directly; undefined is one it cannot reach, where the command is the way.
const hostRunning = ref<string | undefined>(`host-1`);
jest.mock(`../../../sandbox/devices/useDevices`, () => ({ ...useDevicesOriginal, swapServingSandbox, useHostRunning: () => hostRunning }));
jest.mock(`../../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(`sb1`), reachable }) }));
jest.mock(`../../../sandbox/devices/ConnectDeviceHint.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// The rebuild the sandbox holds for idle agents, and whether it can: off, as an older sandbox answers.
const idleWait = ref<EnvironmentRebuildWait | undefined>(undefined);
const waitsForAgents = ref(false);
const askIdle = jest.fn(async (_host: string, _hash: string): Promise<void> => undefined);
const cancelIdle = jest.fn(async (): Promise<void> => undefined);
jest.mock(`./useRebuildWhenIdle`, () => ({ useRebuildWhenIdle: () => ({ wait: idleWait, supported: waitsForAgents, ask: askIdle, cancel: cancelIdle }) }));

const { forgetRestarts, restartExpected } = await import("../../../sandbox/live/sandboxRestart");
const { default: HostRecreate } = await import("./HostRecreate.vue");

let app: App | undefined;
let backs = 0;

const settle = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

// Under fake timers a real timeout never fires, so those tests settle by moving the clock instead.
const settleFaked = async (): Promise<void> => {
    await advanceTimersByTimeAsync(0);
    await nextTick();
};

// The button, mounted and not yet pressed. A hash makes it a rebuild of that overlay; `gilded` is the update card's.
const mount = (hash?: string, gilded = false): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const action = hash === undefined ? `Update` : `Rebuild`;
    app = createApp({ render: () => h(HostRecreate, { slug: `work`, action, hash, gilded, onBack: () => (backs += 1) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    return el;
};

// A button by its words, the dialog's included: it teleports past the mount, so the last one of that name.
const buttonNamed = (words: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].findLast((candidate) => candidate.textContent?.trim() === words);

// The press and its confirmation: the dialog teleports past the mount, so its button is the last one of that name.
// `flush` lets the op settle; `beforeConfirm` reads the dialog while it is open. A hash makes it a rebuild of that overlay.
const press = async (
    { flush = settle, beforeConfirm, hash }: { flush?: () => Promise<void>; beforeConfirm?: () => void | Promise<void>; hash?: string } = {},
): Promise<void> => {
    const action = hash === undefined ? `Update` : `Rebuild`;
    const el = mount(hash);
    el.querySelector(`button`)?.click();
    await nextTick();
    await beforeConfirm?.();
    [...document.body.querySelectorAll(`button`)].findLast((button) => button.textContent?.trim() === `${action} now`)?.click();
    await flush();
};

// A swap whose stream never ends, as the relayed one did in WebKitGTK.
const neverEnds = (): void => {
    swapServingSandbox.mockImplementationOnce(async () => await new Promise<string | undefined>(() => {}));
};

const cutover = async (flush: () => Promise<void> = settle): Promise<void> => {
    reachable.value = false;
    await nextTick();
    reachable.value = true;
    await flush();
};

const shown = (): string => document.body.textContent ?? ``;

afterEach(() => {
    jest.useRealTimers();
    app?.unmount();
    app = undefined;
    backs = 0;
    hostRunning.value = `host-1`;
    reachable.value = true;
    fleet.value = [];
    autoResume.value = false;
    answering.version = `1.316.0`;
    delete answering.hash;
    swapServingSandbox.mockClear();
    idleWait.value = undefined;
    waitsForAgents.value = false;
    askIdle.mockClear();
    cancelIdle.mockClear();
    forgetRestarts();
    document.body.innerHTML = ``;
});

it(`waits out the cutover as the restart it is, and steps aside once the sandbox is back`, async () => {
    await press();
    expect(swapServingSandbox).toHaveBeenCalledWith(`host-1`, `work`, `update`, { onLine: expect.any(Function) });
    expect(shown()).toContain(`Restarting onto the update. This page picks it up again by itself once it's back.`);
    expect(shown()).not.toContain(`Lost contact`);
    // Every other surface reads the silence by this until the sandbox answers again.
    expect(restartExpected(`sb1`)?.untilAnswered).toBe(true);

    answering.version = `1.317.0`;
    await cutover();
    expect(backs).toBe(1);
    expect(shown()).not.toContain(`Restarting onto the update`);
    expect(shown()).not.toContain(`Lost contact`);
});

it(`calls it lost contact only when the sandbox never went quiet after the stream died`, async () => {
    jest.useFakeTimers();
    await press({ flush: settleFaked });
    expect(shown()).toContain(`Restarting onto the update.`);
    await advanceTimersByTimeAsync(60_000);
    await nextTick();
    expect(shown()).toContain(`Lost contact with that device before this sandbox restarted.`);
    expect(backs).toBe(0);
});

// The twelve minutes of "Rebuilding" after the rebuild had applied: the stream stayed open, and the wait was its.
it(`ends a rebuild once the sandbox answers on the approved overlay, though the swap's stream never ends`, async () => {
    neverEnds();
    await press({ hash: `approved` });
    expect(shown()).toContain(`Rebuild running…`);
    expect(shown()).not.toContain(`Restarting onto the rebuilt environment`);

    answering.hash = `approved`;
    await cutover();
    expect(backs).toBe(1);
    expect(shown()).not.toContain(`Rebuild running…`);
    expect(shown()).toContain(`Rebuild now`);
});

// Asked, not waited for: the page's own connection need not blink for the rebuild to be seen landing.
it(`sees a rebuild land by asking, even with no drop in this page's connection`, async () => {
    jest.useFakeTimers();
    neverEnds();
    await press({ flush: settleFaked, hash: `approved` });
    answering.hash = `approved`;
    await advanceTimersByTimeAsync(5_000);
    await nextTick();
    expect(backs).toBe(1);
});

// A blink mid-download is not the swap landing: the sandbox answers on the version the press was made on.
it(`keeps waiting when the sandbox answers again on the same version`, async () => {
    neverEnds();
    await press();
    await cutover();
    expect(backs).toBe(0);
    expect(shown()).toContain(`Update running…`);
});

it(`stops waiting with words to refresh when the sandbox went quiet and never came back`, async () => {
    jest.useFakeTimers();
    neverEnds();
    await press({ flush: settleFaked, hash: `approved` });
    reachable.value = false;
    await nextTick();
    await advanceTimersByTimeAsync(3 * 60_000);
    await nextTick();
    expect(shown()).toContain(`Stopped waiting for the sandbox to come back.`);
    expect(shown()).not.toContain(`Rebuild running…`);
    expect(backs).toBe(0);
});

it(`names the agents a restart stops, and says they wait to be continued`, async () => {
    fleet.value = [
        { id: `one`, title: `Build the API`, status: `running` },
        { id: `two`, title: `Fix the tests`, status: `running` },
        { id: `three`, title: `Done already`, status: `idle` },
    ];
    let dialog = ``;
    await press({
        beforeConfirm: () => {
            dialog = shown();
        },
    });
    expect(dialog).toContain(
        `This stops the 2 agents that are working now: Build the API, Fix the tests. Their work is kept, and each waits for you to continue it once the sandbox is back.`,
    );
});

it(`says the stopped agents pick up by themselves where the owner turned that on`, async () => {
    autoResume.value = true;
    fleet.value = [{ id: `one`, title: `Build the API`, status: `running` }];
    let dialog = ``;
    await press({
        beforeConfirm: () => {
            dialog = shown();
        },
    });
    expect(dialog).toContain(`This stops the agent that is working now: Build the API. It picks up again by itself once the sandbox is back.`);
});

it(`quotes the device when it answered, since then nothing was swapped out from under the page`, async () => {
    swapServingSandbox.mockResolvedValueOnce(`"work" already runs 1.316.0.`);
    await press();
    expect(shown()).toContain(`"work" already runs 1.316.0.`);
    expect(shown()).not.toContain(`Restarting onto the update.`);
    expect(restartExpected(`sb1`)).toBeUndefined();
});

// E2: a turn a restart killed is recorded, not held, so nothing afterwards can run it again with one press. The owner
// says so before the restart instead, on a sandbox that can hear it, and it runs again on the boot after.
it(`asks the sandbox to pick the stopped agents up again once it is back, unless the owner unticks it`, async () => {
    waitsForAgents.value = true;
    fleet.value = [{ id: `one`, title: `Build the API`, status: `running` }];
    let dialog = ``;
    await press({
        beforeConfirm: () => {
            dialog = shown();
        },
    });
    expect(dialog).toContain(`This stops the agent that is working now: Build the API. It picks up again by itself once the sandbox is back.`);
    expect(dialog).toContain(`Let it pick up again by itself once the sandbox is back`);
    expect(swapServingSandbox).toHaveBeenCalledWith(`host-1`, `work`, `update`, { resumeTurns: true, onLine: expect.any(Function) });
    app?.unmount();
    document.body.innerHTML = ``;
    swapServingSandbox.mockClear();

    await press({
        beforeConfirm: async () => {
            document.body.querySelector<HTMLInputElement>(`input[type="checkbox"]`)?.click();
            await nextTick();
            dialog = shown();
        },
    });
    expect(dialog).toContain(`Its work is kept, and it waits for you to continue it once the sandbox is back.`);
    expect(swapServingSandbox).toHaveBeenCalledWith(`host-1`, `work`, `update`, { onLine: expect.any(Function) });
});

it(`offers a sandbox too old to wait or resume neither, and says the stopped agents wait`, async () => {
    fleet.value = [{ id: `one`, title: `Build the API`, status: `running` }];
    let dialog = ``;
    await press({
        hash: `approved`,
        beforeConfirm: () => {
            dialog = shown();
        },
    });
    expect(dialog).not.toContain(`pick up again by itself`);
    expect(dialog).not.toContain(`Rebuild when`);
    expect(swapServingSandbox).toHaveBeenCalledWith(`host-1`, `work`, `rebuild`, { hash: `approved`, onLine: expect.any(Function) });
});

it(`hands a rebuild to the sandbox to start once its agents are idle, instead of now`, async () => {
    waitsForAgents.value = true;
    fleet.value = [
        { id: `one`, title: `Build the API`, status: `running` },
        { id: `two`, title: `Fix the tests`, status: `running` },
    ];
    mount(`approved`).querySelector(`button`)?.click();
    await nextTick();
    buttonNamed(`Rebuild when they're idle`)?.click();
    await settle();
    expect(askIdle).toHaveBeenCalledWith(`host-1`, `approved`);
    expect(swapServingSandbox).not.toHaveBeenCalled();
    expect(restartExpected(`sb1`)).toBeUndefined();
});

it(`says who a waiting rebuild waits on, and withdraws it when cancelled or replaced by Rebuild now`, async () => {
    waitsForAgents.value = true;
    idleWait.value = { host: `host-1`, hash: `approved`, requestedAt: 1, phase: `waiting`, waitingOn: [`Build the API`, `Fix the tests`] };
    mount(`approved`);
    await nextTick();
    expect(shown()).toContain(`Rebuilds by itself once these are no longer working: Build the API, Fix the tests.`);
    buttonNamed(`Cancel rebuild`)?.click();
    await settle();
    expect(cancelIdle).toHaveBeenCalledTimes(1);

    buttonNamed(`Rebuild now`)?.click();
    await nextTick();
    buttonNamed(`Rebuild now`)?.click();
    await settle();
    expect(cancelIdle).toHaveBeenCalledTimes(2);
    expect(swapServingSandbox).toHaveBeenCalledWith(`host-1`, `work`, `rebuild`, { hash: `approved`, onLine: expect.any(Function) });
});

it(`watches a rebuild the sandbox started by itself land, as it does one pressed here`, async () => {
    waitsForAgents.value = true;
    idleWait.value = { host: `host-1`, hash: `approved`, requestedAt: 1, phase: `rebuilding`, waitingOn: [] };
    mount(`approved`);
    await nextTick();
    expect(shown()).toContain(`Rebuilding now that no agent is working.`);
    expect(restartExpected(`sb1`)?.untilAnswered).toBe(true);

    answering.hash = `approved`;
    await cutover();
    expect(backs).toBe(1);
});

// A rebuild the device refused or failed never took the sandbox down: the page stops waiting for it to come back, and
// no surface goes on naming a restart.
it(`stops watching a rebuild the sandbox started once it fails without the sandbox going quiet`, async () => {
    waitsForAgents.value = true;
    idleWait.value = { host: `host-1`, hash: `approved`, requestedAt: 1, phase: `rebuilding`, waitingOn: [] };
    mount(`approved`);
    await nextTick();
    expect(restartExpected(`sb1`)?.untilAnswered).toBe(true);

    idleWait.value = { host: `host-1`, hash: `approved`, requestedAt: 1, phase: `failed`, waitingOn: [], message: `Manage sandboxes is off on rog.` };
    await nextTick();
    expect(restartExpected(`sb1`)).toBeUndefined();
    expect(shown()).not.toContain(`Rebuilding now that no agent is working.`);
});

// Walking away mid-swap doesn't stop the container being replaced: the restart stays named until the sandbox answers.
it(`keeps the restart named when the page is left mid-swap`, async () => {
    neverEnds();
    await press();
    app?.unmount();
    app = undefined;
    await settle();
    expect(restartExpected(`sb1`)?.untilAnswered).toBe(true);
});

it(`says a rebuild that waited did not go through, until dismissed`, async () => {
    waitsForAgents.value = true;
    idleWait.value = { host: `host-1`, hash: `approved`, requestedAt: 1, phase: `failed`, waitingOn: [], message: `Manage sandboxes is off on rog.` };
    mount(`approved`);
    await nextTick();
    expect(shown()).toContain(`The rebuild that waited for the agents didn't go through on that device.`);
    expect(shown()).toContain(`Manage sandboxes is off on rog.`);
    buttonNamed(`Dismiss`)?.click();
    await settle();
    expect(cancelIdle).toHaveBeenCalledTimes(1);
});

it(`folds a gilded update's command behind its gold button on a machine this page cannot reach`, async () => {
    hostRunning.value = undefined;
    useOsPreference().cmdOs.value = `unix`;
    const el = mount(undefined, true);
    const button = buttonNamed(`Update now`);
    expect(button?.classList.contains(`ui-button-gilded`)).toBe(true);
    // Nothing to run is printed at whoever opens the page; the press is what asks for it.
    expect(el.querySelector(`pre`)).toBeNull();
    expect(button?.getAttribute(`aria-expanded`)).toBe(`false`);
    button?.click();
    await nextTick();
    expect(shown()).toContain(`Run this in a terminal on the computer that runs your sandbox:`);
    expect(el.querySelector(`pre`)?.textContent).toBe(bashCommand(`update`, ``, `work`));
    expect(buttonNamed(`Update now`)?.getAttribute(`aria-expanded`)).toBe(`true`);
    buttonNamed(`Update now`)?.click();
    await nextTick();
    expect(el.querySelector(`pre`)).toBeNull();
});

it(`prints the command at once where the button is not the update card's, with what it costs under it`, () => {
    hostRunning.value = undefined;
    useOsPreference().cmdOs.value = `unix`;
    const el = mount();
    expect(el.querySelector(`pre`)?.textContent).toBe(bashCommand(`update`, ``, `work`));
    expect(shown()).toContain(`It downloads and builds first, which interrupts nothing, then restarts your sandbox for about half a minute.`);
});

it(`carries the gold from the update card's button into the confirmation that takes it`, async () => {
    mount(undefined, true);
    buttonNamed(`Update now`)?.click();
    await nextTick();
    const buttons = [...document.body.querySelectorAll(`button`)].filter((button) => button.textContent?.trim() === `Update now`);
    // The card's own and the dialog's, both gold.
    expect(buttons.map((button) => button.classList.contains(`ui-button-gilded`))).toEqual([true, true]);
});
