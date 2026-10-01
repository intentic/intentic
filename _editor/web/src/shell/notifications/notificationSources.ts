import { computed, ref } from "vue";
import { plural } from "@intentic/base/format";
import { useNow } from "@intentic/ui/async";
import PushQuestionBody from "./PushQuestionBody.vue";
import SandboxRecovery from "../../features/sandbox/gates/SandboxRecovery.vue";
import { useDiagnosisNotice, useRecoveryDue, useVisibleOutage } from "../../features/sandbox/gates/useRecovery";
import type { DiagnosisNotice } from "../../features/sandbox/diagnosis/presentation";
import UploadProgressBody from "../../features/workspace/files/upload/UploadProgressBody.vue";
import { useAppUpdate, type AppUpdate } from "../../app/appUpdate";
import { hold, type NotificationInput, type NotificationTone } from "./notifications";
import { type SandboxAvailability, sandboxRequiresGate } from "../../features/sandbox/overview/availability";
import { RESTART_PATIENCE_MS, restartExpected, type RestartWork } from "../../features/sandbox/live/sandboxRestart";
import { useLocalShortcut } from "../../features/sandbox/devices/loopback/localShortcut";
import { useEndpoint } from "../../features/sandbox/secrets/useEndpoint";
import { useSandbox } from "../../features/sandbox/client/useSandbox";
import { useSandboxAvailability } from "../../features/sandbox/overview/useSandboxAvailability";
import { useAuth } from "../../features/auth/useAuth";
import { useGoogleIdentity } from "../../features/auth/useGoogleIdentity";
import { useSandboxSession } from "../../features/sandbox/session/sandboxSession";
import { usePushFlow } from "../../features/workspace/push/usePushFlow";
import { useUploadQueue } from "../../features/workspace/files/upload/useUploadQueue";
import { useSandboxEstablished } from "../../features/sandbox/gates/established";
import { t } from "@intentic/ui/i18n";
import { useRouter } from "vue-router";
import { useDeviceDirectory } from "../../features/sandbox/recovery/deviceDirectory";
import { directMode } from "../../features/sandbox/recovery/directState";

// Every standing fact and open question this app floats, declared in one place as pure conditions fed to `hold`;
// the lane draws them, in this file's registration order. Registered once from the root, above the router and
// outside any session, since some of these must work with no workspace at all.

// Snapshot backing `uploadPhase`/`uploadHeadline`, kept separate from the notification shape so the phase table
// can be read on its own. `undefined` upload state means no import is happening.
interface UploadState {
    readonly count: number;
    readonly done: number;
    readonly failed: number;
    readonly finished: boolean;
    readonly scanning: boolean;
    readonly scanned: number;
    readonly skipped: number | undefined;
    readonly unchanged: number;
}

const uploadState = (upload: ReturnType<typeof useUploadQueue>): UploadState => ({
    count: upload.files.value.length,
    done: upload.doneCount.value,
    failed: upload.failedCount.value,
    finished: upload.finished.value,
    scanning: upload.scanning.value,
    scanned: upload.scannedCount.value,
    skipped: upload.skippedNotice.value,
    unchanged: upload.skippedUnchanged.value,
});

type UploadPhase = "nothing" | "unchanged" | "scanning" | "uploading" | "uploaded" | "partial";

const uploadPhase = (state: UploadState): UploadPhase | undefined => {
    if (state.count === 0) {
        // Only symlinks and special items (which Chrome will not expose), or an empty folder.
        if (state.skipped !== undefined) {
            return `nothing`;
        }
        // Every file already matched the sandbox copy; says so, or a silent no-op reads as broken.
        if (state.unchanged > 0) {
            return `unchanged`;
        }
        return state.scanning ? `scanning` : undefined;
    }
    if (!state.finished) {
        return `uploading`;
    }
    return state.failed === 0 ? `uploaded` : `partial`;
};

interface UploadHeadline {
    readonly title: string;
    readonly detail?: string;
    readonly tone: NotificationTone;
    readonly spin: boolean;
}

const uploadHeadline = (phase: UploadPhase, state: UploadState): UploadHeadline => {
    switch (phase) {
        case `nothing`:
            return {
                title: t(`shell.notificationSources.nothingToUpload`),
                detail:
                    (state.skipped ?? 0) > 0
                        ? `Skipped ${plural(state.skipped ?? 0, `item`, `items`)} that couldn't be read (symlink or special file).`
                        : undefined,
                tone: `info`,
                spin: false,
            };
        case `unchanged`:
            return {
                title: t(`shell.notificationSources.alreadyUpToDate`),
                detail: `Skipped ${plural(state.unchanged, `unchanged file`, `unchanged files`)}.`,
                tone: `done`,
                spin: false,
            };
        case `scanning`:
            return {
                title: t(`shell.notificationSources.scanningDroppedFolder`),
                detail: `${plural(state.scanned, `file`, `files`)} so far.`,
                tone: `info`,
                spin: true,
            };
        case `uploading`:
            return { title: t(`shell.notificationSources.uploading`, { done: state.done, count: state.count }), tone: `info`, spin: true };
        case `uploaded`:
            return { title: `Uploaded ${plural(state.count, `file`, `files`)}`, tone: `done`, spin: false };
        case `partial`:
            return {
                title: t(`shell.notificationSources.uploadedFailed`, { done: state.done, count: state.count, failed: state.failed }),
                tone: `problem`,
                spin: false,
            };
    }
};

// Every way a sandbox mid-swap looks from here, which is all three of them: the first half minute nobody bothers a
// reader about, the outage past it, and the edge's own verdict that no tunnel is dialled in — true of a container
// being replaced, and the one that used to make this card vanish twenty seconds into a restart.
const QUIET: ReadonlySet<SandboxAvailability> = new Set([`stale`, `busy`, `unreachable`, `detached`]);

// THE SILENCE THIS BROWSER ASKED FOR, said as soon as it starts rather than after the busy threshold. `stale` is
// invisible by design — a reconnect shorter than 30s isn't worth a card — but that rule is about silence nobody can
// account for. This is its opposite: the workspace is being interrupted by something the reader pressed, possibly
// minutes ago, on a screen they have since left. No action, because there is nothing to press: the swap is already
// under way and the page reconnects itself. Past the patience window it says nothing rather than keep promising half
// a minute, and the causes that were always here speak again.
export const restartCard = (restart: RestartWork | undefined, availability: SandboxAvailability, outageMs: number): NotificationInput | undefined =>
    restart !== undefined && QUIET.has(availability) && outageMs < RESTART_PATIENCE_MS
        ? { kind: `condition`, tone: `info`, icon: `refresh`, spin: true, title: restart.quiet.title, detail: restart.quiet.detail }
        : undefined;

// How long a sandbox the diagnosis saw ALIVE stays quiet in the lane: it is catching up, the switcher's dot already says
// so, and a card over a workspace that is merely slow was the alarm readers learned to ignore.
export const BUSY_CARD_AFTER_MS = 90_000;

// THE OUTAGE, over a workspace that stays on screen, in the diagnosis's own words (diagnosis/presentation.ts): a wait
// with a spinner while something is still expected to happen by itself, a warning with the recovery panel once the
// diagnosis found a cause with a way back (`due`). Put away for this outage alone; a way back found after that raises it
// again.
export const diagnosisCard = (notice: DiagnosisNotice, due: boolean, dismiss: () => void): NotificationInput => {
    const calm = notice.waiting && !due;
    const card: NotificationInput = { kind: `condition`, tone: calm ? `info` : `warning`, title: notice.title, detail: notice.body, dismiss };
    const spinning: NotificationInput = calm ? { ...card, icon: `spinner`, spin: true } : card;
    return due || notice.otherActions.length > 0 ? { ...spinning, body: SandboxRecovery, wide: true } : spinning;
};

// Call order is stack order, growing up from the corner: most transient first (upload, seconds) to most permanent
// last (a new build), so frequent changes never shove a fixed one.
export const startNotificationSources = (): void => {
    // useSandboxAvailability binds to the caller's Vue scope, so this must run from a component's setup.
    const { user } = useAuth();
    const { active, activeSandboxId, reachable, connection } = useSandbox();
    const { presentedEmail, invalidateSession, getSessionToken } = useSandboxSession();
    const { clearCredential } = useGoogleIdentity();
    // The gate's own reading (established.ts): a screen the gate took is its to explain, and every other screen is this
    // lane's.
    const established = useSandboxEstablished();
    const availability = useSandboxAvailability(established);
    const gated = computed(() => sandboxRequiresGate(reachable.value, established.value, availability.value));
    // How long this outage has run, on a clock that only ticks while one is running and a restart is what it might
    // be: the restart card is the only thing here that stops being true with time rather than with state.
    const timing = computed(() => !reachable.value && restartExpected(activeSandboxId.value) !== undefined);
    const now = useNow(timing);
    const outageMs = computed(() => {
        const since = connection.value.unavailableSince;
        return since === undefined ? 0 : now.value - since;
    });

    // Drops the Google credential and mints a fresh session token; two cards share this for two different reasons
    // (wrong identity, expired session). Awaited so the button stays busy until the token arrives.
    const signInAgain = async (): Promise<void> => {
        clearCredential();
        invalidateSession();
        await getSessionToken();
    };

    // Import progress, narrated scanning to uploading to done.
    const upload = useUploadQueue();
    hold(`upload`, () => {
        const state = uploadState(upload);
        const phase = uploadPhase(state);
        if (phase === undefined) {
            return undefined;
        }
        // The card's line is just the phase headline; the bar, breakdown and failures live in the body instead.
        const headline = uploadHeadline(phase, state);
        return {
            kind: `condition`,
            tone: headline.tone,
            spin: headline.spin,
            icon: headline.spin ? `spinner` : undefined,
            title: headline.title,
            detail: headline.detail,
            body: UploadProgressBody,
            // Same press cancels while running or dismisses once stopped; the queue already knows which.
            dismiss: upload.dismiss,
        };
    });

    // Shown only when every faster address fails: HTTP/1.1 hits the browser's 6-connection cap.
    const { degradedTransport } = useEndpoint();
    hold(`transport`, () =>
        degradedTransport.value
            ? {
                  kind: `condition`,
                  tone: `info`,
                  icon: `wifi`,
                  title: t(`shell.notificationSources.limitedConnectionToSandbox`),
                  detail: t(`shell.notificationSources.liveAgentOutputMay`),
                  // Plain HTTP on 127.0.0.1 is HTTP/1.1, which a browser caps at six connections across every window, one per streaming agent.
                  hint: t(`shell.notificationSources.transportHint`),
              }
            : undefined,
    );

    // Open on a sandbox without the platform (features/sandbox/recovery/directMode.ts): what still works and what waits,
    // until the next session check the platform answers takes the window back.
    const { refresh: checkSession } = useAuth();
    hold(`direct-mode`, () =>
        directMode.value
            ? {
                  kind: `condition`,
                  tone: `info`,
                  icon: `cloud`,
                  title: t(`shell.notificationSources.connectedDirectly`),
                  detail: t(`shell.notificationSources.connectedDirectlyDetail`),
                  actions: [
                      {
                          label: t(`ui.action.tryAgain`),
                          severity: `secondary` as const,
                          run: async () => {
                              // allow(silent-catch): still down is this card staying up, which says so already.
                              await checkSession().catch(() => undefined);
                          },
                      },
                  ],
              }
            : undefined,
    );

    // Sandboxes of this account's own the platform answered it has no record of while they are missing from its list:
    // a registry that forgot them, not a deletion (that answer drops them, rememberSandboxes.ts). Put away for the page's
    // life once dismissed.
    const router = useRouter();
    const { directory } = useDeviceDirectory();
    const lostDismissed = ref(false);
    const lost = computed(() => {
        const email = user.value?.email.toLowerCase();
        const account = email === undefined ? undefined : directory.value.accounts[email];
        return (account?.sandboxes ?? []).filter((entry) => entry.missingSince !== undefined && entry.standing === `unknown` && entry.role === `owner`).length;
    });
    hold(`lost-sandboxes`, () => {
        if (lost.value === 0 || lostDismissed.value || directMode.value || router.currentRoute.value.name === `recover`) {
            return undefined;
        }
        return {
            kind: `condition`,
            tone: `warning`,
            title: t(`shell.notificationSources.lostSandboxes`, { count: lost.value }, lost.value),
            detail: t(`shell.notificationSources.lostSandboxesDetail`),
            actions: [
                {
                    label: t(`shell.notificationSources.reconnect`),
                    severity: `secondary` as const,
                    run: async () => {
                        await router.push(`/recover`);
                    },
                },
            ],
            dismiss: () => {
                lostDismissed.value = true;
            },
        };
    });

    // Catches a Google identity mismatch before the daemon binds; suppressed once denied or already allowed.
    hold(`account-mismatch`, () => {
        const account = user.value?.email;
        const presented = presentedEmail.value;
        const mismatched = account !== undefined && presented !== undefined && account.toLowerCase() !== presented.toLowerCase();
        if (!mismatched || reachable.value || connection.value.failure?.kind === `forbidden`) {
            return undefined;
        }
        return {
            kind: `condition`,
            tone: `warning`,
            title: t(`shell.notificationSources.signedIntoGoogle`, { presented }),
            detail: t(`shell.notificationSources.intenticAccountSwitchBefore`, { account }),
            actions: [{ label: t(`shell.words.switchAccount`), severity: `secondary` as const, run: signInAgain }],
        };
    });

    // Floats over the live DOM rather than replacing it; a never-painted workspace gets a gate instead. One visible-outage
    // clock for the diagnosis, the recovery panel's due-ness and the busy card's patience.
    const outageClock = useVisibleOutage();
    const diagnosis = useDiagnosisNotice(outageClock);
    const recovering = useRecoveryDue(outageClock, diagnosis);
    // The outage the card was put away for, by when it began and whether it had a way back then.
    const dismissed = ref<string | undefined>(undefined);
    hold(`sandbox-busy`, () => {
        if (gated.value) {
            return undefined;
        }
        // An expired session outranks a restart: it is the one cause here that waiting cannot repair, and it stays on
        // the threshold it has always had rather than borrowing the restart's earlier one.
        const needsSignin = connection.value.failure?.kind === `unauthenticated`;
        if (needsSignin) {
            return availability.value === `busy` || availability.value === `unreachable`
                ? {
                      kind: `condition`,
                      tone: `info`,
                      title: t(`shell.notificationSources.sessionNeedsAttention`),
                      detail: t(`shell.notificationSources.workspaceStillHere`),
                      actions: [{ label: t(`shell.notificationSources.signInAgain`), severity: `secondary` as const, run: signInAgain }],
                  }
                : undefined;
        }
        const restart = restartCard(restartExpected(activeSandboxId.value), availability.value, outageMs.value);
        if (restart !== undefined) {
            return restart;
        }
        const notice = diagnosis.value;
        if (notice === undefined) {
            return undefined;
        }
        const due = recovering.value;
        const key = `${connection.value.unavailableSince ?? ``}:${due}`;
        if (dismissed.value === key) {
            return undefined;
        }
        // Alive: quiet for a minute and a half. Not alive: past the half minute every surface gives a reconnect.
        const shown =
            due ||
            (availability.value === `busy` ? outageClock.elapsed.value >= BUSY_CARD_AFTER_MS : availability.value === `unreachable` || availability.value === `detached`);
        return shown ? diagnosisCard(notice, due, () => (dismissed.value = key)) : undefined;
    });

    // Never acts on its own, no auto-reload or restart, except the desktop build's update-on-quit.
    const { offer, take, dismiss: dismissUpdate } = useAppUpdate();
    // One card, three causes, and each says which it is: an unfetchable chunk is a repair, and calling it a new
    // version would send the reader looking for a changelog. Each states the click's cost up front, since a restart
    // closes the window and a reload drops anything unsent.
    const updateWords = (update: AppUpdate): { title: string; detail: string; action: string } => {
        if (update.kind === `app`) {
            return {
                title: t(`shell.notificationSources.intenticReady`, { version: update.version }),
                detail: t(`shell.notificationSources.downloadedRestartingTakesFew`),
                action: `Restart`,
            };
        }
        if (update.kind === `web`) {
            return {
                title: t(`shell.notificationSources.newVersionIntenticOut`),
                detail: t(`shell.notificationSources.reloadToPickUp`),
                action: `Reload`,
            };
        }
        return {
            title: t(`shell.notificationSources.partIntenticDidNot`),
            detail: t(`shell.notificationSources.somethingFetchesGoesNever`),
            action: `Reload`,
        };
    };
    hold(`app-update`, () => {
        const update = offer.value;
        if (update === undefined) {
            return undefined;
        }
        const said = updateWords(update);
        return {
            kind: `condition`,
            tone: `info`,
            icon: `refresh`,
            title: said.title,
            detail: said.detail,
            actions: [{ label: said.action, run: take, severity: `secondary` }],
            dismiss: dismissUpdate,
        };
    });

    // Names the benefit, then the cost, so the browser's own device dialog reads as this card's consequence.
    const { question: shortcutQuestion, allow, decline } = useLocalShortcut();
    const { resolve } = useEndpoint();
    hold(`local-shortcut`, () => {
        const sandboxId = shortcutQuestion.value;
        if (sandboxId === undefined) {
            return undefined;
        }
        return {
            kind: `question`,
            tone: `info`,
            icon: `bolt`,
            title: t(`shell.notificationSources.fasterSandboxRunsOn`),
            detail: t(`shell.notificationSources.browserAskToAllow`),
            actions: [
                { label: t(`ui.action.no`), severity: `secondary` as const, run: (): void => decline(sandboxId) },
                {
                    label: t(`shell.notificationSources.allow`),
                    // Probes immediately, inside the click: the friendliest moment to ask a browser for a device
                    // permission.
                    run: async (): Promise<void> => {
                        allow();
                        await resolve().catch(() => undefined);
                    },
                },
            ],
        };
    });

    // Never blocks the page: a modal would dim the very terminal output the user needs to read.
    const pushFlow = usePushFlow();
    hold(`push`, () => {
        const question = pushFlow.question.value;
        if (question === undefined) {
            return undefined;
        }
        return {
            kind: `question`,
            tone: `danger`,
            title: question.title,
            body: PushQuestionBody,
            // Empty on purpose: "Try again" lives in the body next to "Show terminal", not as a separate lane action.
            actions: [],
            // Only the user retires it; a timed-out question would be a decision nobody made.
            dismiss: pushFlow.dismiss,
        };
    });
};
