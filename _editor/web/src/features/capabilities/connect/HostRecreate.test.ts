// A swap run from this button is relayed by the daemon it replaces, so its stream dies at the cutover. That is the swap
// happening: the button waits for the sandbox to come back and then gets out of the way, leaving the card to say how it
// went, instead of ending every self-update in "Lost contact with that device". Only a stream that died while the
// sandbox never went quiet is lost contact, and a device that answered in words is quoted.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import PrimeVue from "primevue/config";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as useDevicesOriginal from "../../sandbox/devices/useDevices";

const reachable = ref(true);
const swapServingSandbox = jest.fn(async (_hostId: string, _slug: string, _op: string): Promise<string | undefined> => undefined);
// Imported statically and spread: a module loaded inside a mock factory deadlocks bun's link of the graph naming it.
jest.mock(`../../sandbox/devices/useDevices`, () => ({ ...useDevicesOriginal, swapServingSandbox, useHostRunning: () => ref(`host-1`) }));
jest.mock(`../../sandbox/client/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(`sb1`), reachable }) }));
jest.mock(`../../sandbox/devices/ConnectDeviceHint.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { forgetRestarts, restartExpected } = await import("../../sandbox/live/sandboxRestart");
const { default: HostRecreate } = await import("./HostRecreate.vue");

let app: App | undefined;
let backs = 0;

const settle = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

// The press and its confirmation: the dialog teleports past the mount, so its button is the last one of that name.
// `flush` lets the op settle; under fake timers a real timeout would never fire, so that suite passes its own.
const update = async (flush: () => Promise<void> = settle): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(HostRecreate, { slug: `work`, action: `Update`, onBack: () => (backs += 1) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    el.querySelector(`button`)?.click();
    await nextTick();
    [...document.body.querySelectorAll(`button`)].findLast((button) => button.textContent?.trim() === `Update now`)?.click();
    await flush();
};

const shown = (): string => document.body.textContent ?? ``;

afterEach(() => {
    jest.useRealTimers();
    app?.unmount();
    app = undefined;
    backs = 0;
    reachable.value = true;
    swapServingSandbox.mockClear();
    forgetRestarts();
    document.body.innerHTML = ``;
});

it(`waits out the cutover as the restart it is, and steps aside once the sandbox is back`, async () => {
    await update();
    expect(swapServingSandbox).toHaveBeenCalledWith(`host-1`, `work`, `update`, { onLine: expect.any(Function) });
    expect(shown()).toContain(`Restarting onto the update. This page picks it up again by itself once it's back.`);
    expect(shown()).not.toContain(`Lost contact`);
    // Every other surface reads the silence by this until the sandbox answers again.
    expect(restartExpected(`sb1`)?.untilAnswered).toBe(true);

    reachable.value = false;
    await nextTick();
    reachable.value = true;
    await nextTick();
    expect(backs).toBe(1);
    expect(shown()).not.toContain(`Restarting onto the update`);
    expect(shown()).not.toContain(`Lost contact`);
});

it(`calls it lost contact only when the sandbox never went quiet after the stream died`, async () => {
    jest.useFakeTimers();
    await update(async () => {
        await advanceTimersByTimeAsync(0);
        await nextTick();
    });
    expect(shown()).toContain(`Restarting onto the update.`);
    await advanceTimersByTimeAsync(60_000);
    await nextTick();
    expect(shown()).toContain(`Lost contact with that device before this sandbox restarted.`);
    expect(backs).toBe(0);
});

it(`quotes the device when it answered, since then nothing was swapped out from under the page`, async () => {
    swapServingSandbox.mockResolvedValueOnce(`"work" already runs 1.316.0.`);
    await update();
    expect(shown()).toContain(`"work" already runs 1.316.0.`);
    expect(shown()).not.toContain(`Restarting onto the update.`);
    expect(restartExpected(`sb1`)).toBeUndefined();
});
