import { computed } from "vue";
import PushQuestionBody from "../shell/PushQuestionBody.vue";
import UploadProgressBody from "../pages/workspace/UploadProgressBody.vue";
import { useAppUpdate } from "./appUpdate";
import { hold, type NotificationTone } from "./notifications";
import { sandboxRequiresGate } from "./sandbox/availability";
import { useLocalShortcut } from "./sandbox/localShortcut";
import { useEndpoint } from "./sandbox/useEndpoint";
import { useSandbox } from "./sandbox/useSandbox";
import { useSandboxAvailability } from "./sandbox/useSandboxAvailability";
import { useAuth } from "./useAuth";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { useSandboxSession } from "./sandbox/sandboxSession";
import { usePushFlow } from "./workspace/usePushFlow";
import { useUploadQueue } from "./workspace/useUploadQueue";
import { useWorkspaceTree } from "./workspace/useWorkspaceTree";

/* EVERY STANDING FACT AND OPEN QUESTION THIS APP FLOATS, DECLARED IN ONE PLACE.
 *
 * Each of these used to be a component of its own, mounted somewhere in the tree, choosing its own corner of the
 * viewport and its own z-tier. That is what made them impossible to keep consistent: a card cannot stack against
 * one it has never heard of, and nothing in the app was in a position to know about all six at once.
 *
 * So the CARDS are gone and only the conditions remain, as pure functions of state handed to the store
 * (`hold`). The lane draws them. Which one is on screen is now unfalsifiably the same question as which one is
 * true, and their order in the stack is this file's registration order — deliberate, top to bottom, rather than
 * whatever the component tree happened to mount first.
 *
 * REGISTERED FROM THE ROOT, once, ABOVE THE ROUTER AND OUTSIDE ANY SESSION. Two of these have to survive not
 * having a workspace at all: being on a stale build is as true of the login screen as of the workspace, and the
 * loopback offer is raised by a probe that runs on /setup and behind an invite link exactly as it does here.
 * The rest read module-scoped state that answers `undefined` until there is something to say, so registering
 * them early costs nothing and removes the whole class of bug where a report is raised for a surface that
 * happens not to be mounted. */

/* WHICH OF THE IMPORT'S SIX STATES IS ON, AND WHAT IT SAYS — pulled out of the `hold` above as two plain
 * functions over a plain snapshot, so the phase table can be read (and corrected) without also reading the
 * notification's shape. `undefined` is the seventh state: no import is happening and there is no card. */
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
        // A re-drop where every file was already byte-identical on the sandbox: nothing to send, and saying so
        // is the difference between "it worked" and "did that do anything?".
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

/* THE ORDER OF THESE CALLS IS THE ORDER OF THE STACK, within the tier each one belongs to. Read it as a column
 * growing up from the corner: the last thing registered sits nearest the bottom.
 *
 * Conditions run from the most transient to the most permanent, so the card that changes most often is the one
 * furthest from the anchor and the least able to shove anything. An upload finishes in seconds; a degraded
 * transport lasts as long as the network is bad; a new build is true until it is taken. */
export const startNotificationSources = (): void => {
    /* The session facts several of these read, resolved once. `useSandboxAvailability` in particular registers
     * its clock with the CALLER'S Vue scope, so it has to be called from a component's setup — which is exactly
     * what this function is invoked from (App.vue) and the reason it is a function rather than module-level
     * side effects. */
    const { user } = useAuth();
    const { reachable, connection } = useSandbox();
    const { presentedEmail, invalidateSession, getSessionToken } = useSandboxSession();
    const { clearCredential } = useGoogleIdentity();
    const { hasSnapshot } = useWorkspaceTree();
    const availability = useSandboxAvailability(hasSnapshot);
    const gated = computed(() => sandboxRequiresGate(reachable.value, hasSnapshot.value, availability.value));

    /* Drop the Google credential and mint a fresh session token. Two cards offer this and they are asking for
     * the same thing: one because the presented identity is the wrong person, one because it has expired.
     * Awaited, not fired and forgotten — the promise is what holds the button while the token is fetched. */
    const signInAgain = async (): Promise<void> => {
        clearCredential();
        invalidateSession();
        await getSessionToken();
    };

    /* AN IMPORT IN PROGRESS, narrated from the first interaction: scanning the dropped folder → uploading →
     * done. It was the third component to claim the bottom-right corner, drawn underneath the other two by
     * nothing more principled than its z-index, and it kept a fourth copy of the "retire yourself" timer that
     * every other transient thing in this app also had. */
    const upload = useUploadQueue();
    hold(`upload`, () => {
        const state = uploadState(upload);
        const phase = uploadPhase(state);
        if (phase === undefined) {
            return undefined;
        }
        // The card's own line is the HEADLINE of whichever phase the import is in; everything the phase needs to
        // show underneath it — the bar, the per-folder breakdown, the failures, the dependency offer — is the
        // body's, because none of it is expressible as two strings.
        const headline = uploadHeadline(phase, state);
        return {
            kind: `condition`,
            tone: headline.tone,
            spin: headline.spin,
            icon: headline.spin ? `spinner` : undefined,
            title: headline.title,
            detail: headline.detail,
            body: UploadProgressBody,
            // Cancel while it runs, dismiss once it has stopped: the same press, and the queue already knows
            // which of the two it is doing.
            dismiss: upload.dismiss,
        };
    });

    /* THE ONE TRANSPORT STATE WORTH SAYING OUT LOUD, because it is the only one the user can act on and the only
     * one that changes what the app can do.
     *
     * Three addresses can reach a daemon and two of them multiplex: the certified loopback speaks h2, the
     * tunnel's edge speaks h2 and advertises h3, and either carries every stream this app wants on one
     * connection. The third is plain http on 127.0.0.1, which is HTTP/1.1 and cannot be otherwise, because no
     * browser speaks cleartext h2. There a browser allows SIX connections per origin, shared across every window
     * of this app, against something that holds one for each window's live feed and one for every streaming
     * agent.
     *
     * WHY IT NEEDS SAYING AT ALL. The symptom of running out is not an error. Requests queue in the browser and
     * never reach the daemon, so the daemon's log stays healthy and silent, nothing times out on the wire, and
     * the workspace simply stops moving. It was reported as "the sandbox froze" for as long as it existed, and
     * the true cause — a DNS record, three layers away — was not visible from any screen in the product.
     *
     * WHY IT READS AS INFORMATION RATHER THAN AN ALARM. Being here means every multiplexed address was tried and
     * none answered (endpoint.ts ranks this one last), which is very nearly a synonym for "this machine is
     * offline". Offline is not a failure of ours, the workspace still works, and the app re-probes every minute
     * and moves itself back the moment anything better answers. So: no buttons, and it leaves on its own. There
     * is nothing here to dismiss and nothing to click, because the fix is not in this app. */
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

    /* THE WRONG GOOGLE ACCOUNT, CAUGHT BEFORE IT BECOMES THE OWNER.
     *
     * The browser holds two identities at once: the platform account this app is signed in with, and the Google
     * identity it presents to the daemon. Before the daemon binds — the pre-bind window, not yet reachable and
     * not yet refused — nothing has decided which of them owns the sandbox, and if they differ the answer is
     * about to be the wrong one silently. Suppressed once denied (the "no access" screen names both) and once
     * reachable (a reachable mismatch is a legitimate member on a second Google identity, which is allowed).
     *
     * It was an absolutely-positioned bar inside the readiness gate, which made it the one thing in that file
     * that was not a gate: the view behind it was fine, and it was hanging over the top of it anyway. */
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

    /* A PREVIOUSLY-PAINTED WORKSPACE WHOSE DAEMON HAS STAYED QUIET LONG ENOUGH TO DESERVE WORDS. It floats over
     * the live DOM instead of replacing it: reading, drafting and navigation stay useful, and automatic recovery
     * should not look like a page-level failure. Short stalls never raise it at all (availability.ts), and a
     * workspace that has never painted gets a GATE instead — a gate is for a view that is unusable, which is a
     * different thing from a view that is merely behind.
     *
     * It sat at the top centre of the workspace body until now, which is how the app came to say "the sandbox is
     * busy" in two places at once: here, and again as a bare line of text above the chat composer. One sentence,
     * one place; what the composer owes its reader is why SEND is dark, and that is on the button. */
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
            // A stall the app is healing offers nothing to press: a button there invites the user to fix
            // something that isn't broken. An expired session is the one cause waiting cannot repair.
            actions: needsSignin ? [{ label: `Sign in again`, severity: `secondary` as const, run: signInAgain }] : undefined,
        };
    });

    /* THERE IS A NEWER INTENTIC — the whole of what this app says about its own version, in one line.
     *
     * TWO CAUSES, ONE SENTENCE. In a browser it means the deploy moved under this tab and a reload will catch it
     * up. In the desktop app it means a newer build has been released, downloaded and verified onto this
     * machine, and a restart is all that is left. The reader does not care which: both are "you are behind, one
     * click fixes it", and drawing them as two different things would eventually mean drawing them at the same
     * time.
     *
     * WHY IT EXISTS AT ALL. This app is not a page people reload. It is a workspace left open across days, and
     * inside the desktop app it is never reloaded even in principle: that window is HIDDEN on close rather than
     * destroyed, on purpose, so it keeps the session it signed in with. A build shipped on Monday was still on
     * screen on Friday with nothing anywhere saying so.
     *
     * IT NEVER ACTS BY ITSELF. No reload on a timer, no restart while somebody is mid-sentence. The only update
     * that happens without being asked is the desktop app's, on QUIT, where there is nothing to interrupt.
     *
     * "Not now" lasts as long as this offer does and no longer: the next build re-asks, because what was
     * dismissed is not what is now on the table (appUpdate.ts). Registered last among the conditions, so it
     * takes the calmest position in the stack: it is the one standing fact here that will still be true in an
     * hour. */
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
            // What the click COSTS, said before it is pressed. A restart closes the window; a reload throws away
            // whatever this page is holding that it has not sent. Neither is a surprise anybody should meet
            // after the fact.
            detail: update.kind === `app` ? `It is downloaded. Restarting takes a few seconds.` : `Reload to pick it up.`,
            actions: [{ label: update.kind === `app` ? `Restart` : `Reload`, run: take, severity: `secondary` }],
            dismiss: dismissUpdate,
        };
    });

    /* THE ONE SENTENCE THAT HAS TO COME BEFORE THE BROWSER'S OWN DIALOG.
     *
     * The reasoning for asking at all is in sandbox/localShortcut.ts. What is decided HERE is how it reads, and
     * the whole design is that it must not look like the thing it is about to cause. It NAMES THE BENEFIT AND
     * THE COST IN THAT ORDER: why anyone would want this, then what is about to appear on screen if they say
     * yes. The second line exists solely so that the browser's dialog — which will talk about devices on their
     * local network, and will not mention sandboxes, speed, or us — is recognisable as the answer to this card
     * rather than an interruption from nowhere.
     *
     * IT DOES NOT EXPIRE. A receipt retires because nothing depends on being read; this is a question, and a
     * question that times out is a decision nobody made. Both answers are remembered, so it is asked at most
     * once, and No costs the user nothing, because the address it declines is an optimisation on top of one that
     * already works. */
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
                    /* Yes, and probe immediately rather than leaving it to the next reconnect, for two reasons.
                     * This is the one moment the user is thinking about the question, so the browser's own
                     * dialog lands while the card that explains it is still on screen. And the fetch happens
                     * inside their click, which is the friendliest moment there is to ask a browser for
                     * anything. */
                    run: async (): Promise<void> => {
                        allow();
                        await resolve().catch(() => undefined);
                    },
                },
            ],
        };
    });

    /* THE ONE THING A PUSH INTERRUPTS YOU FOR: a check that said no, or a push the remote refused.
     *
     * WHY IT IS RAISED ABOVE ANY VIEW. The question comes minutes after the click that caused it, and by then the
     * user is somewhere else — that is not a failure mode, it is the design: the check runs in a terminal and the
     * app tells them to get on with something. A notice that lived in the Changes panel could only be seen by
     * someone who had stayed put, which is precisely the person who least needs telling.
     *
     * RED ONLY. A pass sends the push and says so in the panel, quietly, where the click was: being interrupted
     * to be told that nothing is wrong is how a notice teaches people to dismiss it unread. What is here is a
     * decision the user still owes: push it anyway, hand it to an agent, or let it go.
     *
     * NOTHING UNDERNEATH IT STOPS WORKING — including the terminal the suite ran in, which a modal would dim and
     * freeze at the exact moment its output became the interesting thing on screen. It holds no output for the
     * same reason: the whole of it is one click away in the terminal, in colour.
     *
     * Registered last of everything, so it takes the corner: it is the only item in this app that is BOTH
     * unresolved and the user's to resolve, and the corner is the position in this lane that never moves. */
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
            // Wider only when it is carrying a whole proposed turn: a composed session squeezed into the lane's
            // ordinary width is a model picker with no room for a model.
            wide: pushFlow.proposedFix.value !== undefined,
            body: PushQuestionBody,
            // NO LANE ACTION, deliberately: "Push anyway" lives in the body, on the same row as "Show
            // terminal" (shell/PushQuestionBody.vue). As an action here the lane gave it a strip of its own
            // under the body, so the two answers to this question — go and look, or override — sat on two
            // rows of chrome instead of reading as the pair they are.
            actions: [],
            // It waits. Nothing retires it but the user: a question that timed out would be a decision nobody
            // made.
            dismiss: pushFlow.dismiss,
        };
    });
};
