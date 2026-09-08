import { computed } from "vue";
import PushQuestionBody from "./PushQuestionBody.vue";
import UploadProgressBody from "../../features/workspace/files/UploadProgressBody.vue";
import { useAppUpdate } from "../../app/appUpdate";
import { hold, type NotificationTone } from "./notifications";
import { sandboxRequiresGate } from "../../features/sandbox/overview/availability";
import { useLocalShortcut } from "../../features/sandbox/devices/localShortcut";
import { useEndpoint } from "../../features/sandbox/secrets/useEndpoint";
import { useSandbox } from "../../features/sandbox/client/useSandbox";
import { useSandboxAvailability } from "../../features/sandbox/overview/useSandboxAvailability";
import { useAuth } from "../../features/auth/useAuth";
import { useGoogleIdentity } from "../../features/auth/useGoogleIdentity";
import { useSandboxSession } from "../../features/sandbox/client/sandboxSession";
import { usePushFlow } from "../../features/workspace/push/usePushFlow";
import { useUploadQueue } from "../../features/workspace/files/useUploadQueue";
import { useWorkspaceTree } from "../../features/workspace/explorer/useWorkspaceTree";

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

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const uploadHeadline = (phase: UploadPhase, state: UploadState): UploadHeadline => {
    switch (phase) {
        case `nothing`:
            return {
                title: `Nothing to upload`,
                detail:
                    (state.skipped ?? 0) > 0
                        ? `Skipped ${plural(state.skipped ?? 0, `item`, `items`)} that couldn't be read (symlink or special file).`
                        : undefined,
                tone: `info`,
                spin: false,
            };
        case `unchanged`:
            return {
                title: `Already up to date`,
                detail: `Skipped ${plural(state.unchanged, `unchanged file`, `unchanged files`)}.`,
                tone: `done`,
                spin: false,
            };
        case `scanning`:
            return { title: `Scanning dropped folder…`, detail: `${plural(state.scanned, `file`, `files`)} so far.`, tone: `info`, spin: true };
        case `uploading`:
            return { title: `Uploading ${state.done} of ${state.count}`, tone: `info`, spin: true };
        case `uploaded`:
            return { title: `Uploaded ${plural(state.count, `file`, `files`)}`, tone: `done`, spin: false };
        case `partial`:
            return { title: `Uploaded ${state.done} of ${state.count} · ${state.failed} failed`, tone: `problem`, spin: false };
    }
};

// Call order is stack order, growing up from the corner: most transient first (upload, seconds) to most permanent
// last (a new build), so frequent changes never shove a fixed one.
export const startNotificationSources = (): void => {
    // useSandboxAvailability binds to the caller's Vue scope, so this must run from a component's setup.
    const { user } = useAuth();
    const { reachable, connection } = useSandbox();
    const { presentedEmail, invalidateSession, getSessionToken } = useSandboxSession();
    const { clearCredential } = useGoogleIdentity();
    const { hasSnapshot } = useWorkspaceTree();
    const availability = useSandboxAvailability(hasSnapshot);
    const gated = computed(() => sandboxRequiresGate(reachable.value, hasSnapshot.value, availability.value));

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
                  title: `Limited connection to this sandbox`,
                  detail: `Live agent output may lag. It clears when you are back online.`,
                  hint:
                      `Nothing but your own machine can be reached right now, so the browser is talking to the sandbox over plain HTTP on ` +
                      `127.0.0.1. That is HTTP/1.1, which a browser allows only six of at a time across every window of this app, and each ` +
                      `streaming agent holds one. Everything still works; some of it waits its turn. The faster addresses are re-checked ` +
                      `every minute, and this goes away on its own once one of them answers.`,
              }
            : undefined,
    );

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
            title: `Signed into Google as ${presented}`,
            detail: `Your intentic account is ${account}. Switch before this sandbox binds, or the wrong one becomes its owner.`,
            actions: [{ label: `Switch account`, severity: `secondary` as const, run: signInAgain }],
        };
    });

    // Floats over the live DOM rather than replacing it; a never-painted workspace gets a gate instead.
    hold(`sandbox-busy`, () => {
        if (gated.value || availability.value !== `busy`) {
            return undefined;
        }
        const needsSignin = connection.value.failure?.kind === `unauthenticated`;
        return {
            kind: `condition`,
            tone: `info`,
            icon: `spinner`,
            spin: true,
            title: needsSignin ? `This browser's sandbox session needs attention` : `The sandbox is busy`,
            detail: needsSignin ? `Your workspace is still here.` : `Your workspace stays open while it catches up automatically.`,
            // No button for a stall the app is already healing; only an expired session needs the user to act.
            actions: needsSignin ? [{ label: `Sign in again`, severity: `secondary` as const, run: signInAgain }] : undefined,
        };
    });

    // Never acts on its own, no auto-reload or restart, except the desktop build's update-on-quit.
    const { offer, take, dismiss: dismissUpdate } = useAppUpdate();
    hold(`app-update`, () => {
        const update = offer.value;
        if (update === undefined) {
            return undefined;
        }
        return {
            kind: `condition`,
            tone: `info`,
            icon: `refresh`,
            title: update.kind === `app` ? `Intentic ${update.version} is ready` : `A new version of Intentic is out`,
            // States the click's cost up front: a restart closes the window, a reload drops anything unsent.
            detail: update.kind === `app` ? `It is downloaded. Restarting takes a few seconds.` : `Reload to pick it up.`,
            actions: [{ label: update.kind === `app` ? `Restart` : `Reload`, run: take, severity: `secondary` }],
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
            title: `Faster if this sandbox runs on this device`,
            detail: `Your browser will ask to allow it.`,
            actions: [
                { label: `No`, severity: `secondary` as const, run: (): void => decline(sandboxId) },
                {
                    label: `Allow`,
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
            // Wider only when carrying a proposed turn; a composed session needs more than the lane's default width.
            wide: pushFlow.proposedFix.value !== undefined,
            body: PushQuestionBody,
            // Empty on purpose: "Push anyway" lives in the body next to "Show terminal", not as a separate lane action.
            actions: [],
            // Only the user retires it; a timed-out question would be a decision nobody made.
            dismiss: pushFlow.dismiss,
        };
    });
};
