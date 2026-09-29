import "@intentic/testing/dom";
import { effectScope, nextTick, ref } from "vue";

const clock = ref(0);
const reachable = ref(false);
const connection = ref({ failure: { kind: `network` as const, message: `offline` }, unavailableSince: 0 });
const active = ref({ id: `box`, role: `owner`, hosted: null, removedAt: null });
const activeWakeRefused = ref(undefined);

jest.mock("@intentic/ui/async", () => ({ useNow: () => clock }));
jest.mock("../client/useSandbox", () => ({ useSandbox: () => ({ active, connection, reachable, activeWakeRefused }) }));
jest.mock("../live/sandboxRestart", () => ({ restartExpected: () => undefined }));
const { useRecoveryDue, useVisibleOutage } = await import("./useRecovery");

it(`excludes hidden time and waits for a failed reconnect after wake`, async () => {
    let visible = true;
    let now = 0;
    const original = Object.getOwnPropertyDescriptor(document, `visibilityState`);
    Object.defineProperty(document, `visibilityState`, { configurable: true, get: () => visible ? `visible` : `hidden` });
    const nowSpy = jest.spyOn(Date, `now`).mockImplementation(() => now);
    const scope = effectScope();
    const state = scope.run(() => ({ due: useRecoveryDue(), outage: useVisibleOutage() }))!;
    try {
        now = 10_000;
        clock.value = now;
        visible = false;
        document.dispatchEvent(new Event(`visibilitychange`));
        now = 130_000;
        clock.value = now;
        visible = true;
        document.dispatchEvent(new Event(`visibilitychange`));
        expect(state.outage.elapsed.value).toBe(10_000);
        expect(state.due.value).toBe(false);
        now = 250_000;
        clock.value = now;
        expect(state.outage.elapsed.value).toBe(130_000);
        expect(state.due.value).toBe(false);
        connection.value = { ...connection.value, failure: { kind: `network`, message: `retry failed` } };
        await nextTick();
        expect(state.due.value).toBe(true);
    } finally {
        scope.stop();
        nowSpy.mockRestore();
        if (original !== undefined) {Object.defineProperty(document, `visibilityState`, original);}
    }
});
