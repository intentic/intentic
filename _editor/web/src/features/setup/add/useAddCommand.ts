import type { SetupCode } from "@intentic/api-contract";
import { useOsPreference } from "@intentic/ui";
import { computed, ref, type Ref } from "vue";
import { useCommandWait } from "../flow/useCommandWait";
import { useRunStep } from "../flow/useRunStep";
import type { SetupRow } from "../flow/useSetupRow";

// THE COMMAND TO RUN ON A SERVER, as Home's new sandbox draws it once its code is minted (AddSandboxCommand.vue): the
// shell's command or the compose file, the reader's own Cloudflare zone riding it when they choose one, and the wait for
// the machine that runs it (a redeemed code, its own account of the run, the check-in that hands the row over). The
// flows are the ones /setup ran (flow/useRunStep.ts, flow/useCommandWait.ts), held by the run so leaving its page loses
// nothing. Nothing here is handed to the desktop app: a server is somewhere else, so the command is always on screen.

export interface AddCommandHost {
    readonly setup: Readonly<Ref<SetupCode | null>>;
    readonly started: Readonly<Ref<{ readonly kind: string } | undefined>>;
    readonly row: SetupRow;
    readonly mobile: Readonly<Ref<boolean>>;
}

export const useAddCommand = ({ setup, started, row, mobile }: AddCommandHost) => {
    // The shell the reader last chose, wherever they chose it.
    const { cmdOs } = useOsPreference();
    // Reachable at the address the platform mints, or under the reader's own Cloudflare zone, whose token rides the command.
    const mode = ref<`intentic` | `own`>(`intentic`);
    const cfToken = ref(``);
    const commandReady = computed(() => started.value?.kind === `command` && setup.value !== null);
    const copied = ref(false);
    // Never handed to the app: a command run on a server is not this computer's to run.
    const launched = ref(false);
    const reader = { mobile, inApp: ref(false), installer: ref(undefined) };
    const step = useRunStep({
        command: { setup, commandReady, launched },
        row,
        reader,
        cmdOs,
        mode,
        cfToken,
        project: undefined,
        openDesktopLink: () => undefined,
    });
    // On screen from the start, a phone included (whose command says it is for a computer), and syncing no folder: the
    // server it runs on has none of the reader's to keep.
    step.showCommand.value = true;
    step.syncEnabled.value = false;
    const wait = useCommandWait({
        command: { commandReady, copied, launched },
        row,
        step,
        reader,
        desktopReport: ref(undefined),
        desktopHeardAt: ref(undefined),
        desktopPcSetup: ref(false),
    });
    return { mode, cfToken, commandReady, step, wait };
};

