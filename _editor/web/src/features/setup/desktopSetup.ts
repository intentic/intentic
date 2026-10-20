import { readonly, ref, type Ref } from "vue";
import { track } from "../../app/analytics";
import { DESKTOP_SETUP_EVENT, readDesktopSetupReport, type DesktopSetupReport } from "../../app/environments/desktopSetupReport";
import { downloadMb, type DownloadMb } from "./desktopRun";

/** A session Windows has to end before Docker can run, which outlasts the app's card being put away. */
export type DesktopSetupParked = `restart` | `signOut`;

/* The setup page remains available while setup runs in the background. */
// allow(module-state): the desktop app's own setup report
const report = ref<DesktopSetupReport | undefined>(undefined);
// allow(module-state): when that report was last heard
const heardAt = ref<number | undefined>(undefined);
// allow(module-state): whether the app's last run was said to have failed or been stopped, kept when its card is put away
const ended = ref(false);
// allow(module-state): the restart or sign-out the app's last run stopped on, kept when its card is put away
const parked = ref<DesktopSetupParked | undefined>(undefined);
// allow(module-state): whether the app's last run was parked behind this PC's own setup, kept when its card is put away
const pcSetup = ref(false);
// allow(module-state): when the step the app last reported was first heard, which is how long a download has run
const stepSince = ref<number | undefined>(undefined);
// The step `stepSince` dates.
let lastStep: string | undefined;
let listening = false;
// What this page last told the funnel, so a bar ticking every second, or a heartbeat re-sending what it already said, is
// one event per change of state, not sixty.
let lastTold = ``;
// Whether the slow download's way out was told to the funnel: once a visit, however often it comes and goes.
let slowOfferTold = false;

// The app's reports on this page's own record, so the replay's timeline holds what the app's window was saying: the
// app's own events go out under its install id, beside this session rather than in it (desktop-app analytics.ts).
const tell = (heard: DesktopSetupReport): void => {
    const told = `${heard.state}|${heard.waitingFor ?? ``}|${heard.requirements?.join(`,`) ?? ``}`;
    if (told === lastTold) {
        return;
    }
    lastTold = told;
    track(`desktop_setup_report`, {
        state: heard.state,
        percent: heard.percent,
        ...(heard.step === undefined ? {} : { step: heard.step }),
        ...(heard.waitingFor === undefined ? {} : { waitingFor: heard.waitingFor }),
        ...(heard.requirements === undefined ? {} : { requirements: heard.requirements }),
        ...downloadMb(heard),
    });
};

const parkedBy = (heard: DesktopSetupReport): DesktopSetupParked | undefined =>
    heard.state === `waiting` && (heard.waitingFor === `restart` || heard.waitingFor === `signOut`) ? heard.waitingFor : undefined;

export const useDesktopSetup = (): {
    readonly report: Readonly<Ref<DesktopSetupReport | undefined>>;
    readonly heardAt: Readonly<Ref<number | undefined>>;
    readonly ended: Readonly<Ref<boolean>>;
    readonly parked: Readonly<Ref<DesktopSetupParked | undefined>>;
    readonly pcSetup: Readonly<Ref<boolean>>;
    readonly stepSince: Readonly<Ref<number | undefined>>;
} => {
    if (!listening) {
        listening = true;
        window.addEventListener(DESKTOP_SETUP_EVENT, (event) => {
            const next = readDesktopSetupReport((event as CustomEvent<unknown>).detail);
            if (next === undefined) {
                return;
            }
            const now = Date.now();
            heardAt.value = now;
            tell(next);
            // A card put away is not a PC that stopped waiting: a restart it stopped on is still the next thing to do.
            if (next.state !== `closed`) {
                ended.value = next.state === `failed` || next.state === `stopped`;
                parked.value = parkedBy(next);
                pcSetup.value = next.waitingFor === `pcSetup` && (next.state === `running` || next.state === `waiting`);
                // Dated by the step's first report, not by its card: a run whose card was put away is still in it.
                if (next.step !== lastStep || stepSince.value === undefined) {
                    lastStep = next.step;
                    stepSince.value = now;
                }
            }
            // The card was put away: nothing left to draw, and nothing to be stale about.
            report.value = next.state === `closed` ? undefined : next;
        });
    }
    return {
        report: readonly(report),
        heardAt: readonly(heardAt),
        ended: readonly(ended),
        parked: readonly(parked),
        pcSetup: readonly(pcSetup),
        stepSince: readonly(stepSince),
    };
};

// How far a slow download had got: in whole MB, and how long it still had to go where the app said.
const slowFigures = (slow: DesktopSetupReport | undefined): { remainingSeconds: number | null } & DownloadMb => ({
    remainingSeconds: slow?.remainingSeconds ?? null,
    ...downloadMb(slow),
});

// The slow download's way out went up (desktopRun.ts `slowDownload`): told once a visit, however often it comes and goes.
export const tellSlowDownloadOffered = (offered: DesktopSetupReport): void => {
    if (slowOfferTold) {
        return;
    }
    slowOfferTold = true;
    track(`setup_slow_download_offered`, slowFigures(offered));
};

// The reader took it: told on each press, with the same figures, so the offer's take-up reads off the two events.
export const tellSlowDownloadHosted = (offered: DesktopSetupReport | undefined): void => {
    track(`setup_slow_download_hosted`, slowFigures(offered));
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
