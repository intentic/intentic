import "@intentic/testing/dom";
import { computed, effectScope, nextTick, ref } from "vue";
import type { DiagnosisNotice } from "../diagnosis/presentation";
import { receiveDesktopShown } from "../../../workbench/window/onScreen";

const clock = ref(0);
const reachable = ref(false);
const connection = ref({ failure: { kind: `network` as const, message: `offline` }, unavailableSince: 0 });
const active = ref({ id: `box`, role: `owner`, hosted: null, removedAt: null });
const activeWakeRefused = ref(undefined);

jest.mock("@intentic/ui/async", () => ({ useNow: () => clock }));
jest.mock("../../../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ active, connection, reachable, activeWakeRefused }) }));
jest.mock("../live/sandboxRestart", () => ({ restartExpected: () => undefined }));
jest.mock("../diagnosis/useDiagnosis", () => ({ useDiagnosis: () => computed(() => undefined) }));
const { useRecoveryDue, useVisibleOutage } = await import("./useVisibleOutage");

// Hidden as onScreen says it: here the desktop app's word, which is the one a Windows window in the tray gives, its
// document still saying visible.
it(`excludes hidden time and waits for a failed reconnect after wake`, async () => {
    let now = 0;
    const nowSpy = jest.spyOn(Date, `now`).mockImplementation(() => now);
    const scope = effectScope();
    // A diagnosis with a way back, so the only thing left deciding is whether a failure was seen since the page woke.
    const wayBack: DiagnosisNotice = {
        title: `box isn't connected`,
        body: ``,
        waiting: false,
        tone: `warning`,
        chain: [],
        action: `fix`,
        otherActions: [],
        findings: [],
        sayAtOnce: false,
    };
    const state = scope.run(() => {
        const outage = useVisibleOutage();
        return { due: useRecoveryDue(outage, computed(() => wayBack)), outage };
    })!;
    try {
        now = 10_000;
        clock.value = now;
        receiveDesktopShown(false);
        now = 130_000;
        clock.value = now;
        receiveDesktopShown(true);
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
        receiveDesktopShown(true);
    }
});
