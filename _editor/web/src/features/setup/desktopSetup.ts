import { readonly, ref, type Ref } from "vue";
import { DESKTOP_SETUP_EVENT, readDesktopSetupReport, type DesktopSetupReport } from "../../app/environments/desktop";

/* The setup page remains available while setup runs in the background. */
// allow(module-state): the desktop app's own setup report
const report = ref<DesktopSetupReport | undefined>(undefined);
// allow(module-state): when that report was last heard
const heardAt = ref<number | undefined>(undefined);
// allow(module-state): whether the app's last run was said to have failed or been stopped, kept when its card is put away
const ended = ref(false);
let listening = false;

export const useDesktopSetup = (): {
    readonly report: Readonly<Ref<DesktopSetupReport | undefined>>;
    readonly heardAt: Readonly<Ref<number | undefined>>;
    readonly ended: Readonly<Ref<boolean>>;
} => {
    if (!listening) {
        listening = true;
        window.addEventListener(DESKTOP_SETUP_EVENT, (event) => {
            const next = readDesktopSetupReport((event as CustomEvent<unknown>).detail);
            if (next === undefined) {
                return;
            }
            heardAt.value = Date.now();
            if (next.state !== `closed`) {
                ended.value = next.state === `failed` || next.state === `stopped`;
            }
            // The card was put away: nothing left to draw, and nothing to be stale about.
            report.value = next.state === `closed` ? undefined : next;
        });
    }
    return { report: readonly(report), heardAt: readonly(heardAt), ended: readonly(ended) };
};

// How long a claim with no word from the app counts as an install under way: past a slow install's four minutes with
// room to spare, and short of locking the button for good on a page reloaded after a run that ended unheard.
export const CLAIM_PATIENCE_MS = 15 * 60_000;

// Whether the app's install is under way, which is when "Set it up now" must not be pressable: a second press starts a
// second install over the first, and it stayed pressable through a four-minute one. Its own report says so, or a
// machine claimed the code recently (`claimedFor`, ms ago; undefined when not known) and nothing has said the run ended;
// a failure or a stop hands the button back, for the retry the page then asks for, even once its card was put away.
export const setupUnderWay = (input: {
    readonly report: DesktopSetupReport | undefined;
    readonly claimed: boolean;
    readonly failed: boolean;
    readonly ended?: boolean;
    readonly claimedFor?: number | undefined;
}): boolean => {
    const state = input.report?.state;
    if (input.failed || state === `failed` || state === `stopped`) {
        return false;
    }
    if (state === `running` || state === `waiting`) {
        return true;
    }
    return input.claimed && input.ended !== true && (input.claimedFor === undefined || input.claimedFor < CLAIM_PATIENCE_MS);
};
