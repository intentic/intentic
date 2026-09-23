import type { SetupReport } from "@intentic/api-contract";
import { useNow } from "@intentic/ui/async";
import { computed, ref, type Ref, watch } from "vue";
import { track } from "../../../app/analytics";
import type { DesktopSetupReport } from "../../../app/environments/desktop";
import { setupReportView } from "../setupReport";
import { handoffOf, nudgeAfterMs, nudgeVariantOf, SLOW_BUILD_MS, STALLED_MS, waitedFrom } from "./commandHandoff";
import type { SetupReader } from "./useRunStep";

// The wait for the reader's machine to run the command: how far the command has got, the machine's own account of its
// run, and the correction a quiet wait earns, timed from the command becoming runnable or from the reader's last act.

export interface CommandWaitHost {
    readonly command: {
        readonly commandReady: Readonly<Ref<boolean>>;
        // Set by the copy that hands the command to the reader.
        readonly copied: Ref<boolean>;
        readonly launched: Readonly<Ref<boolean>>;
    };
    readonly row: {
        readonly claimedAt: Readonly<Ref<string | null>>;
        readonly report: Readonly<Ref<SetupReport | null>>;
        readonly resuming: Readonly<Ref<boolean>>;
    };
    readonly step: {
        readonly commandVisible: Readonly<Ref<boolean>>;
        readonly composeShown: Readonly<Ref<boolean>>;
        readonly installing: Readonly<Ref<boolean>>;
        readonly runTab: Readonly<Ref<`unix` | `windows` | `compose`>>;
        readonly syncEnabled: Readonly<Ref<boolean>>;
    };
    readonly reader: SetupReader;
    // The app's own account of the setup it was handed; undefined outside the app.
    readonly desktopReport: Readonly<Ref<DesktopSetupReport | undefined>>;
}

export const useCommandWait = ({ command, row, step, reader, desktopReport }: CommandWaitHost) => {
    // A link back to this screen went to the reader's inbox. Not a step of the handoff, which follows the command to a
    // machine: it changes only what a stuck wait's correction says.
    const emailed = ref(false);
    // The installer was fetched: intent, not proof of install; it moves both when the correction comes and what it says.
    const downloaded = ref(false);
    // When the command became runnable (ms), re-armed with each new code: only elapsed time reveals a silent failure.
    const armedAt = ref<number | undefined>(undefined);
    // The reader's last visible act (a download), the right clock once `armedAt` has gone stale.
    const actedAt = ref<number | undefined>(undefined);
    // Armed only while a command is on screen, so a step 2 with none costs no tick.
    const now = useNow(() => armedAt.value !== undefined);
    watch(command.commandReady, (ready) => {
        armedAt.value = ready ? Date.now() : undefined;
    });

    const handoff = computed(() =>
        handoffOf({
            commandReady: command.commandReady.value,
            claimedAt: row.claimedAt.value,
            report: row.report.value,
            copied: command.copied.value,
            launched: command.launched.value,
        }),
    );
    // The verbatim what-broke list, and a healthy run's live footer line (setupReport.ts).
    const reportFailures = computed(() => setupReportView(row.report.value).failures);
    const buildStage = computed(() => setupReportView(row.report.value).stage);
    const waitedMs = computed(() => {
        const from = waitedFrom(armedAt.value, actedAt.value);
        return from === undefined ? 0 : now.value - from;
    });
    // Never over a live report from the app: "still nothing" beside a bar that is visibly moving would contradict the
    // app the page handed the work to.
    const nudging = computed(
        () =>
            handoff.value !== `claimed` &&
            waitedMs.value > nudgeAfterMs(step.composeShown.value || reader.mobile.value || step.installing.value) &&
            desktopReport.value === undefined,
    );
    const stalled = computed(() => handoff.value !== `claimed` && waitedMs.value > STALLED_MS);
    const nudgeVariant = computed(() =>
        nudgeVariantOf({
            mobile: reader.mobile.value,
            emailed: emailed.value,
            commandVisible: step.commandVisible.value,
            installing: step.installing.value,
            downloaded: downloaded.value,
            launched: command.launched.value,
        }),
    );
    // Copying again helps a reader with a command not yet run, never a phone: its clipboard was never the blocker.
    const nudgeCopyable = computed(() => step.commandVisible.value && step.runTab.value !== `compose` && !(reader.mobile.value && emailed.value));
    // Claimed but silent differs from never run: the command ran, so its terminal has the answer.
    const slowBuild = computed(() => {
        const claimed = row.claimedAt.value;
        return (
            row.report.value === null && claimed !== null && handoff.value === `claimed` && now.value - new Date(claimed).getTime() > SLOW_BUILD_MS
        );
    });

    // The last observable step before the reader leaves for a terminal; a phone's copy means something else, since no
    // terminal reads it.
    const onCopied = (): void => {
        command.copied.value = true;
        track(`sandbox_command_copied`, { tab: step.runTab.value, sync: step.syncEnabled.value, mobile: reader.mobile.value });
    };
    // The phone's handoff landed: its own milestone, the first observable phone act that leads anywhere.
    const onEmailed = (): void => {
        emailed.value = true;
        track(`sandbox_setup_link_emailed`, { resuming: row.resuming.value });
    };
    const onDownload = (): void => {
        downloaded.value = true;
        actedAt.value = Date.now();
        track(`desktop_installer_downloaded`, { platform: reader.installer.value?.platform ?? `unknown` });
    };

    return {
        emailed,
        handoff,
        reportFailures,
        buildStage,
        nudging,
        stalled,
        nudgeVariant,
        nudgeCopyable,
        slowBuild,
        onCopied,
        onEmailed,
        onDownload,
    };
};
