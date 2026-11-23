import type { SetupCode } from "@intentic/api-contract";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom, useNow } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref, type Ref, watch } from "vue";

// A SETUP CODE THAT RAN OUT, renewed before its command can be copied again. The platform lets a code live 30 minutes
// (SETUP_CODE_TTL_MS) and refuses its claim after that, but the command on screen kept the code it was minted with: a
// reader back from a long install or an unattended tab copied a command that could only fail, under a nudge saying it
// was safe to run again (2026-10-23). So the moment the code is past its `expiresAt` the command is taken off the page
// (`live` is null) and a fresh code minted in its place; a mint that fails says so, with a retry.
// A code a run is still using is never rotated: a fresh code clears the claim stamp and the run's report on the
// platform, so the machine running the old one would stop reporting into this wait. Whether a run uses it is the
// registry watch's word (a claim, or a report that is not a failure); a run that failed uses nothing any more.

export interface CodeRenewalHost {
    readonly setup: Ref<SetupCode | null>;
    // A command is on the page to be copied: the one place a code is shown rather than handed to a run.
    readonly shown: () => boolean;
    // A run already holds the code (useRegistryWatch.ts): it was claimed, or a run is reporting and has not failed.
    readonly inUse: () => boolean;
    readonly mint: () => Promise<SetupCode>;
}

// Past its expiry: an `expiresAt` that does not parse is never read as run out.
const codeExpired = (code: SetupCode | null, now: number): boolean => code !== null && Date.parse(code.expiresAt) <= now;

export const useCodeRenewal = ({ setup, shown, inUse, mint }: CodeRenewalHost) => {
    const now = useNow(() => shown() && setup.value !== null);
    const renewing = ref(false);
    const renewError = ref<NoticeModel | null>(null);
    // Run out, and nobody's run is holding it: this code is no use to anyone who copies it now. The ticking clock makes it
    // reactive; the wall clock confirms it, since a clock nobody followed for a while reads the instant it last ticked.
    const stale = computed(() => codeExpired(setup.value, now.value) && codeExpired(setup.value, Date.now()) && !inUse());
    // The code the command is drawn with: none while a run-out one waits for its replacement.
    const live = computed(() => (stale.value ? null : setup.value));

    const renew = async (): Promise<void> => {
        if (renewing.value || !shown() || !stale.value) {
            return;
        }
        renewing.value = true;
        renewError.value = null;
        try {
            setup.value = await mint();
        } catch (error) {
            renewError.value = noticeFrom(error, t(`setup.addSandbox.codeRenewFailed`), { tone: `warning` });
        } finally {
            renewing.value = false;
        }
    };

    watch(
        () => stale.value && shown(),
        (due) => {
            if (due) {
                void renew();
            }
        },
        { immediate: true },
    );

    return { live, stale, renewing, renewError, renew };
};
