import { computed, onScopeDispose, ref, watch } from "vue";
import { type AgentStanding, attentionCalls, type CallerStanding, laneOf, turnWorking } from "../../features/agents/fleet/agentStatus";
import { agentsAttention } from "../../features/agents/board/agentsTile";
import { parentOf } from "../../features/agents/board/ownership";
import { readingAcross } from "../../features/agents/fleet/fleetScope";
import { type FleetAgent, fleet } from "../../features/agents/fleet/useAgents-fleet";
import { heldHeard, heldWakes, rosterHeard } from "../../features/agents/fleet/useAgents-registry";
import { activeSandboxId } from "../../features/sandbox/overview/activeSandbox";
import type { SandboxAvailability } from "../../features/sandbox/overview/availability";
import { useSandboxAvailability } from "../../features/sandbox/overview/useSandboxAvailability";
import { otherBoxes } from "../../features/sandbox/live/fleetAcross";
import { floatingWindowPanel } from "../window/floating";
import { type Chime, ringOnce } from "./chimes";
import { showDesktopBadge } from "./desktopBadge";
import { readerBack, settleDesktop, tellDesktop } from "./desktopSignal";
import { readerHere } from "./readerHere";
import { setTabMark } from "./tabTitle";
import { chimeAsks, chimeFinished, tabStatus } from "./tabPreferences";
import { newsItemsBetween, type TabFrame, tabMark } from "./tabSignal";

// The browser tab as a surface of the app (tabSignal.ts has the rules): what the fleet says the tab should show, and
// when it should ring. The page's own name comes from the router, and tabTitle.ts writes both. Inside the desktop app,
// whose window has no tab, the same mark goes on the app's icon (desktopBadge.ts) and the same news, for the same
// reader, becomes the system's notifications (desktopSignal.ts); each does nothing in a browser.

// Past the half minute a reconnect is given in silence (availability.ts), and every ending that waiting will not mend.
// Not `busy`: a sandbox the diagnosis saw alive is catching up, and a tab that said "Offline" over it was the loudest
// false alarm the app had.
const OFFLINE: ReadonlySet<SandboxAvailability> = new Set([`unreachable`, `detached`, `removed`, `blocked`]);

// A Stop the reader pressed files its card in Attention, which is no news to them.
const endedByHand = (agent: AgentStanding): boolean => agent.status === `stopping` || agent.status === `stopped`;

const askKeys = (agents: readonly CallerStanding[]): ReadonlySet<string> => {
    const byId = new Map(agents.map((agent) => [agent.id, agent] as const));
    return new Set(
        attentionCalls(agents)
            .filter((call) => {
                const agent = byId.get(call.id);
                return agent !== undefined && !endedByHand(agent);
            })
            .map((call) => call.id),
    );
};

// A turn somebody is waiting on: one a person started, not an automation's or a workflow step's, and not a subagent
// whose parent is on the board to hear how it went.
const awaited = (agent: FleetAgent, ids: ReadonlySet<string>): boolean => {
    const parent = parentOf(agent.startedBy);
    return agent.origin === undefined && agent.workflow === undefined && (parent === undefined || !ids.has(parent));
};

// The turns awaited in this sandbox, split into those running and those settled in Finished.
const turnsOf = (sandbox: string, agents: readonly FleetAgent[]): Pick<TabFrame, `working` | `settled`> => {
    const ids = new Set(agents.map((agent) => agent.id));
    const awaitedHere = agents.filter((agent) => awaited(agent, ids));
    return {
        working: new Set(awaitedHere.filter(turnWorking).map((agent) => `${sandbox}/${agent.id}`)),
        settled: new Set(awaitedHere.filter((agent) => !turnWorking(agent) && laneOf(agent) === `finished`).map((agent) => `${sandbox}/${agent.id}`)),
    };
};

// The other sandboxes count only while the Agents tile counts them, so a chime never rings for a number not shown.
const askedAcross = (): readonly (readonly [string, ReadonlySet<string>])[] =>
    readingAcross.value
        ? otherBoxes.value.flatMap((box) =>
              box.readAt === undefined
                  ? []
                  : [[box.sandbox.id, askKeys(box.agents)] as const, [`${box.sandbox.id}#held`, new Set(box.held.map((wake) => wake.id))] as const],
          )
        : [];

const frameOf = (): TabFrame => {
    const sandbox = activeSandboxId.value;
    const asks = new Map<string, ReadonlySet<string>>(askedAcross());
    if (sandbox === undefined) {
        return { asks, working: new Set(), settled: new Set() };
    }
    if (heldHeard.value) {
        asks.set(`${sandbox}#held`, new Set(heldWakes.value.map((wake) => wake.id)));
    }
    if (!rosterHeard.value) {
        return { asks, working: new Set(), settled: new Set() };
    }
    asks.set(sandbox, askKeys(fleet.value));
    return { asks, ...turnsOf(sandbox, fleet.value) };
};

/**
 * Keeps the browser tab telling the fleet's news for as long as the caller's scope lives. Called once from the
 * workspace runtime; a popped-out panel's window names itself (FloatingSection.vue) and is left alone.
 */
export const startBrowserTab = (): void => {
    if (floatingWindowPanel.value !== undefined) {
        return;
    }
    const availability = useSandboxAvailability();
    // A turn finished while the reader was elsewhere; over the moment they are back in any window of the app.
    const doneAway = ref(false);
    watch(
        readerHere,
        (here) => {
            if (here) {
                doneAway.value = false;
                readerBack();
            }
        },
        { immediate: true },
    );

    const frame = computed(frameOf);
    watch(frame, (after, before) => {
        // An ask answered from the phone takes its notification down wherever the reader is.
        settleDesktop(after);
        const news = newsItemsBetween(before, after);
        if (readerHere.value || (news.asked.length === 0 && news.finished.length === 0)) {
            return;
        }
        if (news.finished.length > 0) {
            doneAway.value = true;
        }
        // One sound for one reading: an ask outranks a finish that arrived with it.
        let chime: Chime | undefined;
        if (news.asked.length > 0 && chimeAsks.value) {
            chime = `asks`;
        } else if (news.finished.length > 0 && chimeFinished.value) {
            chime = `finished`;
        }
        if (chime !== undefined) {
            void ringOnce(chime);
        }
        tellDesktop(news, chime !== undefined);
    });

    const shown = computed(() =>
        tabStatus.value
            ? tabMark({
                  asks: agentsAttention.value,
                  offline: OFFLINE.has(availability.value),
                  doneAway: doneAway.value,
                  working: fleet.value.some(turnWorking),
              })
            : undefined,
    );
    watch(
        shown,
        (mark) => {
            setTabMark(mark);
            showDesktopBadge(mark);
        },
        { immediate: true },
    );
    onScopeDispose(() => {
        setTabMark(undefined);
        showDesktopBadge(undefined);
    });
};
