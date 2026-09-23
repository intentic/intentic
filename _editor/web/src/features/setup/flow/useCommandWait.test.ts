import "@intentic/testing/dom";
import type { SetupReport } from "@intentic/api-contract";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { type EffectScope, effectScope, nextTick, ref } from "vue";
import type { DesktopSetupReport } from "../../../app/environments/desktop";
import type { desktopInstaller } from "../../../app/environments/desktopDownloads";
import { useCommandWait } from "./useCommandWait";

// Pins the wait on the wall clock the command arms: the correction comes forty seconds after a command to paste and
// three minutes where the command is not the path, never once a machine claimed the code or while the app reports
// progress; a download re-dates it; and a claimed code with no word from the machine turns slow after six minutes.

const scopes: EffectScope[] = [];

const stage = (over: { mobile?: boolean; installer?: ReturnType<typeof desktopInstaller> } = {}) => {
    const command = { commandReady: ref(false), copied: ref(false), launched: ref(false) };
    const row = { claimedAt: ref<string | null>(null), report: ref<SetupReport | null>(null), resuming: ref(false) };
    const step = {
        commandVisible: ref(over.installer === undefined && over.mobile !== true),
        composeShown: ref(false),
        installing: ref(over.installer !== undefined),
        runTab: ref<`unix` | `windows` | `compose`>(`unix`),
        syncEnabled: ref(true),
    };
    const reader = { mobile: ref(over.mobile ?? false), inApp: ref(false), installer: ref(over.installer) };
    const desktopReport = ref<DesktopSetupReport | undefined>(undefined);
    const scope = effectScope();
    scopes.push(scope);
    const wait = scope.run(() => useCommandWait({ command, row, step, reader, desktopReport }))!;
    // The code lands and the command becomes runnable, which is what arms the clock.
    const arm = async (): Promise<void> => {
        command.commandReady.value = true;
        await nextTick();
    };
    return { command, row, step, desktopReport, wait, arm };
};

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(`2026-09-23T10:00:00Z`));
});

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    jest.useRealTimers();
});

describe(`how far the command has got`, () => {
    it(`is the reader's once runnable, handed once copied, and claimed on the machine's word`, async () => {
        const { command, row, wait, arm } = stage();
        expect(wait.handoff.value).toBe(`locked`);
        await arm();
        expect(wait.handoff.value).toBe(`yours`);
        wait.onCopied();
        expect({ copied: command.copied.value, handoff: wait.handoff.value }).toEqual({ copied: true, handoff: `handed` });
        row.claimedAt.value = `2026-09-23T10:01:00Z`;
        expect(wait.handoff.value).toBe(`claimed`);
    });

    it(`reads the machine's own account of the run`, () => {
        const { row, wait } = stage();
        row.report.value = {
            stage: `pulling-image`,
            failed: [{ check: `docker`, problem: `not running`, remedy: `start it` }],
            at: `2026-09-23T10:01:00Z`,
        };
        expect(wait.reportFailures.value).toEqual([{ check: `docker`, problem: `not running`, remedy: `start it` }]);
    });
});

describe(`a quiet wait`, () => {
    it(`earns a correction forty seconds after a command to paste, and turns stalled at three minutes`, async () => {
        const { wait, arm } = stage();
        await arm();
        await advanceTimersByTimeAsync(40_000);
        expect(wait.nudging.value).toBe(false);
        await advanceTimersByTimeAsync(1_000);
        expect({ nudging: wait.nudging.value, stalled: wait.stalled.value, variant: wait.nudgeVariant.value }).toEqual({
            nudging: true,
            stalled: false,
            variant: `terminal`,
        });
        await advanceTimersByTimeAsync(140_000);
        expect(wait.stalled.value).toBe(true);
    });

    it(`waits three minutes where an installer is the path, and dates itself from the download`, async () => {
        const { wait, arm } = stage({ installer: { platform: `windows`, label: `Windows`, href: `https://intentic.dev/download/windows` } });
        await arm();
        await advanceTimersByTimeAsync(170_000);
        wait.onDownload();
        await advanceTimersByTimeAsync(170_000);
        expect(wait.nudging.value).toBe(false);
        await advanceTimersByTimeAsync(11_000);
        expect({ nudging: wait.nudging.value, variant: wait.nudgeVariant.value }).toEqual({ nudging: true, variant: `downloaded` });
    });

    it(`says nothing over a machine that claimed the code, or over the app's own progress`, async () => {
        const { row, desktopReport, wait, arm } = stage();
        await arm();
        desktopReport.value = { state: `running`, percent: 40, position: `Step 4 of 10` };
        await advanceTimersByTimeAsync(60_000);
        expect(wait.nudging.value).toBe(false);
        desktopReport.value = undefined;
        row.claimedAt.value = `2026-09-23T10:00:30Z`;
        expect(wait.nudging.value).toBe(false);
    });

    it(`calls a claimed code slow once six minutes pass with no word from the machine`, async () => {
        const { row, wait, arm } = stage();
        await arm();
        row.claimedAt.value = new Date(Date.now()).toISOString();
        await advanceTimersByTimeAsync(360_000);
        expect(wait.slowBuild.value).toBe(false);
        await advanceTimersByTimeAsync(1_000);
        expect(wait.slowBuild.value).toBe(true);
        row.report.value = { stage: `pulling-image`, failed: [], at: `2026-09-23T10:06:00Z` };
        expect(wait.slowBuild.value).toBe(false);
    });

    it(`offers the command to copy again only where it is on screen, and never to a phone that mailed itself the link`, () => {
        const desk = stage();
        expect(desk.wait.nudgeCopyable.value).toBe(true);
        desk.step.runTab.value = `compose`;
        expect(desk.wait.nudgeCopyable.value).toBe(false);
        const phone = stage({ mobile: true });
        phone.step.commandVisible.value = true;
        phone.wait.onEmailed();
        expect({ copyable: phone.wait.nudgeCopyable.value, variant: phone.wait.nudgeVariant.value }).toEqual({ copyable: false, variant: `emailed` });
    });
});
