import type { SandboxSummary, SetupReport } from "@intentic/api-contract";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { ref, watch } from "vue";
import { track } from "../../../app/analytics";
import type { useSandbox } from "../../sandbox/client/useSandbox";
import { autoSandboxName } from "../setupName";

// The sandbox row this visit sets up, and what the registry has said about it since: its code redeemed, the machine's
// account of its run, the daemon's own check-ins. Created unasked on arrival, a row minted here is a draft the page
// discards on leaving until some act commits it.

type SandboxStore = ReturnType<typeof useSandbox>;

export interface SetupRowHost {
    readonly sandbox: Pick<SandboxStore, `sandboxes` | `create` | `select` | `remove`>;
    // Opens the workspace once the row is selected.
    readonly enter: () => Promise<void>;
}

export const useSetupRow = ({ sandbox, enter }: SetupRowHost) => {
    // Null while the arrival's create is in flight, or after it failed.
    const created = ref<SandboxSummary | null>(null);
    // Arrived on an existing sandbox (named in the URL, or the one unfinished) rather than one created now.
    const resuming = ref(false);
    // Minted by this visit, so a discardable draft; a resumed row is someone's unfinished errand.
    const createdHere = ref(false);
    // Setup ran to the end; set explicitly, since `created.lastSeenAt` may still be stale on exit.
    const finished = ref(false);
    const creating = ref(false);
    const error = ref<NoticeModel | null>(null);
    // `lastSeenAt` marks the daemon's last boot, not a heartbeat: a check-in counts once it moves past this.
    const baseline = ref<string | null>(null);
    // Server-side proof the command ran; cleared each mint, so a value always describes the command on screen.
    const claimedAt = ref<string | null>(null);
    // The machine's account of its run, staged with fixes on failure.
    const report = ref<SetupReport | null>(null);
    const bootReport = ref<SandboxSummary[`bootReport`]>(null);
    const announceRefusal = ref<SandboxSummary[`announceRefusal`]>(null);
    // Whether the daemon has ever checked in, read off the poll rather than off `created` for the same reason.
    const announced = ref(false);

    watch(
        () => created.value?.id,
        () => {
            baseline.value = created.value?.lastSeenAt ?? null;
        },
        { immediate: true },
    );

    // Creates the sandbox (minting its token) under the next free name.
    const autoCreate = async (): Promise<void> => {
        if (creating.value) {
            return;
        }
        creating.value = true;
        error.value = null;
        try {
            created.value = await sandbox.create(autoSandboxName(sandbox.sandboxes.value.map((entry) => entry.name)));
            // Minted here, agreed to by nobody: from this instant it is a draft the discard rule owns.
            createdHere.value = true;
        } catch (err) {
            error.value = noticeFrom(err, `Could not create your sandbox.`);
        } finally {
            creating.value = false;
        }
    };

    // Onboarding's make-or-break milestone, polled or attached. Selects the row explicitly: `reconcileActive` may have
    // moved the selection away while this page waited.
    const connected = async (id: string, detail: { readonly attached?: true } = {}): Promise<void> => {
        track(`sandbox_connected`, { resuming: resuming.value, ...detail });
        finished.value = true;
        sandbox.select(id);
        await enter();
    };

    // Deletes the draft this visit minted, and its tunnel, unless an act committed it; fire-and-forget, since every
    // caller is already leaving. A row outliving a failed delete is what the switcher's unfinished section catches.
    const discardDraft = (committed: boolean): void => {
        const draft = created.value;
        if (draft === null || !createdHere.value || committed) {
            return;
        }
        createdHere.value = false;
        created.value = null;
        void sandbox.remove(draft.id).catch(() => undefined);
    };

    // A new machine is expected on the row: what the old one said about itself no longer describes it.
    const forgetBoot = (): void => {
        bootReport.value = null;
        announceRefusal.value = null;
        announced.value = false;
    };

    // Walks away from this row for another; a draft goes through `discardDraft` first.
    const forget = (): void => {
        resuming.value = false;
        created.value = null;
        error.value = null;
        claimedAt.value = null;
    };

    return {
        created,
        resuming,
        createdHere,
        finished,
        creating,
        error,
        baseline,
        claimedAt,
        report,
        bootReport,
        announceRefusal,
        announced,
        autoCreate,
        connected,
        discardDraft,
        forgetBoot,
        forget,
    };
};

export type SetupRow = ReturnType<typeof useSetupRow>;
