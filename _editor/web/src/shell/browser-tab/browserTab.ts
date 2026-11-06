import { useTheme } from "@intentic/ui/theme";
import { computed, onScopeDispose, ref, watch } from "vue";
import { laneOf } from "../../models/agent-status/agentStatus-lanes";
import { callsFor, heardBy, type Reader } from "../../models/agent-status/notifyAudience";
import { useAuth } from "../../client/auth/useAuth";
import { useRole } from "../../client/sandbox/useRole";
import { type AgentStanding, turnWorking } from "../../models/agent-status/agentStatus-standing";
import { agentsAttention } from "../../models/fleet/board/agentsTile";
import { parentOf } from "../../models/agent-status/ownership";
import { type FleetAgent, fleet } from "../../models/fleet/useAgents-fleet";
import { heldHeard, heldWakes, rosterHeard } from "../../models/fleet/useAgents-registry";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useSandboxAvailability } from "../../features/sandbox/overview/useSandboxAvailability";
import { floatingWindowPanel } from "../../workbench/window/floating";
import { type Chime, ringOnce } from "../../workbench/browser-tab/chimes";
import { showDesktopBadge } from "./desktopBadge";
import { readerBack, settleDesktop, tellDesktop } from "./desktopSignal";
import { readerHere } from "../../workbench/browser-tab/readerHere";
import { setTabLogo, setTabMark } from "./tabTitle";
import { chimeAsks, chimeFinished, tabStatus } from "../../workbench/browser-tab/tabPreferences";
import { newsItemsBetween, type TabFrame, tabMark, tabOffline } from "./tabSignal";
import { justSetUp } from "../../models/sandbox/live/justSetUp";
import { useSkin } from "../../skins/useSkin";
import { countPlate } from "./tabIcon";

// The browser tab as a surface of the app (tabSignal.ts has the rules): what the fleet says the tab should show, and
// when it should ring. The page's own name comes from the router, and tabTitle.ts writes both. Inside the desktop app,
// whose window has no tab, the same mark goes on the app's icon (desktopBadge.ts) and the same news, for the same
// reader, becomes the system's notifications (desktopSignal.ts); each does nothing in a browser.

// A Stop the reader pressed files its card in Attention, which is no news to them.
const endedByHand = (agent: AgentStanding): boolean => agent.status === `stopping` || agent.status === `stopped`;

// Only the calls that wait on the reader (notifyAudience.ts): a card in somebody else's conversation is theirs to hear.
const askKeys = (agents: readonly FleetAgent[], reader: Reader): ReadonlySet<string> => {
    const byId = new Map(agents.map((agent) => [agent.id, agent] as const));
    return new Set(
        callsFor(agents, reader)
            .filter((call) => {
                const agent = byId.get(call.id);
                return agent !== undefined && !endedByHand(agent);
            })
            .map((call) => call.id),
    );
};

// A turn the reader is waiting on: one a person started, not an automation's or a workflow step's, not a subagent whose
// parent is on the board to hear how it went, and one they took part in or follow (notifyAudience.ts).
const awaited = (agent: FleetAgent, ids: ReadonlySet<string>, reader: Reader): boolean => {
    const parent = parentOf(agent.startedBy);
    return agent.origin === undefined && agent.workflow === undefined && (parent === undefined || !ids.has(parent)) && heardBy(agent, reader, `finished`);
};

// The turns awaited in this sandbox, split into those running and those settled in Finished.
const turnsOf = (sandbox: string, agents: readonly FleetAgent[], reader: Reader): Pick<TabFrame, `working` | `settled`> => {
    const ids = new Set(agents.map((agent) => agent.id));
    const awaitedHere = agents.filter((agent) => awaited(agent, ids, reader));
    return {
        working: new Set(awaitedHere.filter(turnWorking).map((agent) => `${sandbox}/${agent.id}`)),
        settled: new Set(awaitedHere.filter((agent) => !turnWorking(agent) && laneOf(agent) === `finished`).map((agent) => `${sandbox}/${agent.id}`)),
    };
};

// Only the sandbox in front of the reader rings: what other sandboxes need is Home's to show.
const frameOf = (reader: Reader): TabFrame => {
    const sandbox = activeSandboxId.value;
    const asks = new Map<string, ReadonlySet<string>>();
    if (sandbox === undefined) {
        return { asks, working: new Set(), settled: new Set() };
    }
    if (heldHeard.value) {
        asks.set(`${sandbox}#held`, new Set(heldWakes.value.map((wake) => wake.id)));
    }
    if (!rosterHeard.value) {
        return { asks, working: new Set(), settled: new Set() };
    }
    asks.set(sandbox, askKeys(fleet.value, reader));
    return { asks, ...turnsOf(sandbox, fleet.value, reader) };
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
    const { active, connection } = useSandbox();
    // Answered before, here or anywhere: a sandbox still being set up has never announced, and is not "Offline".
    // One /setup opened moments ago counts as still being set up until it answers here (justSetUp.ts).
    const seen = computed(
        () => connection.value.everOnline || ((active.value?.lastSeenAt ?? null) !== null && !justSetUp(active.value?.id)),
    );
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

    const { user } = useAuth();
    const { canShip } = useRole();
    const frame = computed(() => frameOf({ email: user.value?.email, operates: canShip.value }));
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

    // The rail's count chip in the look on screen, read again whenever the look changes: the scheme, the skin and the
    // accent all repaint it, and each is on <html> before this runs (they apply synchronously).
    const { scheme, accent } = useTheme();
    const { skin } = useSkin();
    const plate = ref(countPlate());
    watch([scheme, skin, accent], () => {
        plate.value = countPlate();
    });
    const shown = computed(() => {
        if (!tabStatus.value) {
            return undefined;
        }
        const mark = tabMark({
            asks: agentsAttention.value,
            offline: tabOffline(availability.value, seen.value),
            doneAway: doneAway.value,
            working: fleet.value.some(turnWorking),
        });
        // The same count as the Agents tile, so the same colour: the tab's disc and the taskbar's overlay wear its plate.
        return mark?.kind === `asks` && plate.value !== undefined ? { ...mark, plate: plate.value } : mark;
    });
    watch(shown, (mark) => setTabMark(mark), { immediate: true });
    // The open sandbox's logo stands in for the lotus whether or not the tab shows the fleet's marks, on the tab and on
    // the desktop app's icon alike.
    const logo = computed(() => active.value?.image ?? undefined);
    watch(logo, (image) => setTabLogo(image), { immediate: true });
    watch([shown, logo], ([mark, image]) => showDesktopBadge(mark, image), { immediate: true });
    onScopeDispose(() => {
        setTabLogo(undefined);
        setTabMark(undefined);
        showDesktopBadge(undefined);
    });
};
