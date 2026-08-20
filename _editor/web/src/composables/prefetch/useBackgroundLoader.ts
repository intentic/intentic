import { toValue } from "vue";
import { useChat } from "../chat/useChat";
import { onScreen } from "../onScreen";
import { queryClient } from "../queryPersistence";
import { useSandbox } from "../sandbox/useSandbox";
import { browserPace, runBackgroundLoader, type LoaderGates } from "./backgroundLoader";
import { agentsWarmSource } from "./sources/agentsWarm";
import { changesWarmSource } from "./sources/changesWarm";
import { extensionsWarmSource } from "./sources/extensionsWarm";
import { railWarmSource } from "./sources/railWarm";
import { terminalsWarmSource } from "./sources/terminalsWarm";
import { registerWarmSource, warmPlan } from "./warmPlan";

/* THE LOADER, PLUGGED INTO THE REAL APP, the one place that says what "paused", "busy" and "the plan" mean
 * here. The loop itself (backgroundLoader.ts) knows none of it, which is what makes it testable against a fake
 * clock; this file is the wiring, and it is deliberately the only thing in the engine that reaches for the app's
 * singletons.
 *
 * Started by the signed-in session (shell/WorkspaceRuntime.vue), for the same reason the daemon stream is: the
 * shell is not the app. A user on /setup or following an invite link is still a user whose board is worth having
 * warm by the time they arrive at it. */

const { reachable } = useSandbox();
const { conversations } = useChat();

/* REGISTRATION ORDER IS THE TIE-BREAK WITHIN A BAND (warmPlan), so it is the app's own answer to "which of two
 * equally-near things first".
 *
 * THE WORKSPACE REVIEW LEADS, ahead of the board. It is the surface every agent's work ends up on, a clean turn
 * lands as uncommitted changes in the user's own tree, and it is the one the user commits from, so it is where
 * the app has to be instant. It is also the only one whose whole contents are thrown away on a schedule the user
 * does not control: a turn ending invalidates the review and every diff under it at once, so the reads that
 * refill it are needed most at the exact moment a busy board has the most to say for itself. Behind the board's
 * cards those reads came last, and the panel was reliably cold when it was opened.
 *
 * Then the board's cards: opening an agent is the most repeated gesture in the product, and the two reads behind
 * it are what the click waits on. It gives up first place because a card opens onto a conversation, the pane
 * fills as it streams, so a round trip there is absorbed, where the review opens onto ± numbers that are wrong
 * until they are read.
 *
 * Then the rail, the shell's own furniture before the extensions', because two of the shell's reads (the
 * panels, the capability manifest) are what the rail DETECTS its extension tiles from, so a tile whose data
 * arrived before the tile itself would have gained nothing by going first.
 *
 * The terminals go FIRST of all, and only because of where their band comes from: theirs is the one wish that
 * can be `now`, and it is `now` exactly when the panel is open, a surface already on screen with nothing in it
 * until this list lands. Anything else at `now` is a place the user has gone, not one they are looking at. */
const SOURCES = [terminalsWarmSource, changesWarmSource, agentsWarmSource, railWarmSource, extensionsWarmSource];

const gates: LoaderGates = {
    /* NOBODY LOOKING, OR NOTHING TO LOOK AT. `onScreen` is asked of every window this tab renders into rather
     * than of the tab itself, a popped-out chat is a window the user is reading while `document` here says
     * hidden (see onScreen.ts). `reachable` is the daemon liveness probe's verdict: with the stream down every
     * read would fail anyway, and a loader walking its plan into a dead tunnel is the failure streak this
     * avoids paying for. */
    paused: () => !onScreen.value || !toValue(reachable),
    /* STAND ASIDE FOR THE USER, AND FOR THE AGENTS.
     *
     * Any query fetching right now is, at this instant, something a screen is waiting on, the loader holds
     * nothing of its own open when this is asked, because it asks between its own reads. So a non-zero count
     * means the app is busy on somebody's behalf and the polite thing is to not add a request beside it. This
     * is what makes "on screen and still loading" first without the loader having to know what is on screen.
     *
     * A STREAMING TURN counts too, and for a different reason: the daemon is doing real work for an agent, the
     * frames are landing in this tab, and both the tunnel and the main thread have better uses than a read
     * ahead. It is also the moment the review list deliberately stops refreshing, so there is little to warm
     * that would still be true a second later. */
    busy: () => queryClient.isFetching() > 0 || conversations.value.some((conversation) => conversation.streaming.value),
};

let running = false;
let disposers: (() => void)[] = [];

export const startBackgroundLoader = (): void => {
    if (running) {
        return;
    }
    running = true;
    disposers = SOURCES.map((source) => registerWarmSource(source));
    void runBackgroundLoader(warmPlan, gates, browserPace, () => !running);
};

export const stopBackgroundLoader = (): void => {
    running = false;
    for (const dispose of disposers) {
        dispose();
    }
    disposers = [];
};
