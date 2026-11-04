import { computed, watch } from "vue";
import { markSeenAcross, otherBoxes } from "../sandbox/live/fleetAcross";
import { onScreen } from "../../workbench/window/onScreen";
import { connectedSandboxes } from "../sandbox/live/roster";
import { landOnAfterSwitch } from "../sandbox/sandboxScreen";
import { page, toInside } from "../../lib/routes/links";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { turnInFlight } from "../agent-status/agentStatus-standing";
import { answeredAt } from "../agent-status/answeredAt";
import type { FleetAgent } from "./useAgents-fleet";
import { endedHere, overlaid } from "./useAgents-provisional";
import { useChat } from "../conversations/run/useChat";
import { chatStrip } from "../conversations/panel/useChat-strip";

// Other sandboxes' conversations as this sandbox's editor knows them: the ones a chat placed elsewhere (the composer's
// placement menu) runs, read from their own box's roster. The board covers this sandbox alone; the account-wide view
// of every sandbox is Home's.

const { sandboxes, activeSandboxId } = useSandbox();

// Whether there is another sandbox to place a conversation in: one connected sandbox is not a fleet.
export const sandboxesElsewhere = computed(() => connectedSandboxes(sandboxes.value).length > 1);

// Every other box's agents in card shape, for a conversation placed there (its detail page, a drag, a parent's mark): the parts only a conversation can answer (`open`, `unsent`) are read from
// this browser's tabs or are false, never guessed. `unread` is derived the same way the local fleet derives it.
// (id, sandbox) as one string, since that pair is an agent's identity across boxes and a Map wants one key.
const cardKey = (sandboxId: string, agentId: string): string => `${sandboxId}/${agentId}`;

export const otherFleet = computed<readonly FleetAgent[]>(() => {
    // Except when this browser holds the tab: a conversation can now start in another box from the composer, so the
    // card must know whether it's open here, matched on (id, box) never id alone.
    // The strip as the app sees it, whichever window draws the chat, so a card here and a card there can't disagree
    // about one conversation.
    const tabOf = new Map(chatStrip.value.tabs.flatMap((tab) => (tab.box === undefined ? [] : [[cardKey(tab.box, tab.id), tab] as const])));
    return otherBoxes.value.flatMap((box) =>
        box.agents.flatMap((agent): FleetAgent[] => {
            const tab = tabOf.get(cardKey(box.sandbox.id, agent.id));
            const card: FleetAgent = {
                ...agent,
                sandboxId: box.sandbox.id,
                open: tab !== undefined,
                // Unsent words exist in exactly one place, the composer in front of the user, so this is read from the
                // tab or is false.
                unsent: tab?.unsent ?? false,
                unread: !turnInFlight(agent) && answeredAt(agent) > (agent.seenAt ?? 0),
            };
            // A press on this card from here draws at once; this box is polled, so its roster is the slow half.
            const shown = overlaid(card, agent, box.sandbox.id);
            return shown === undefined ? [] : [endedHere(shown, tab)];
        }),
    );
});

// A conversation you're watching is not news, whichever box it runs in: `useAgents` holds this rule for the streamed
// sandbox, but a conversation homed elsewhere fell outside it and would keep its unread mark for as long as that box
// existed.
export const watchRemoteSeen = (): void => {
    watch(
        () => {
            const active = useChat().active.value;
            const at = active.box.value;
            if (!onScreen.value || at === undefined) {
                return undefined;
            }
            const card = otherFleet.value.find((agent) => agent.id === active.conversationId && agent.sandboxId === at);
            // The key rather than a pair, so an unchanged answer is an unchanged value and doesn't re-fire the watch on
            // every poll tick.
            return card?.unread === true ? cardKey(at, active.conversationId) : undefined;
        },
        (seen) => {
            // Split at the first separator: a sandbox id never holds one, and cutting at the last would hand the box
            // half of an agent's own id.
            const cut = seen?.indexOf(`/`) ?? -1;
            if (seen !== undefined && cut > 0) {
                markSeenAcross(seen.slice(0, cut), seen.slice(cut + 1));
            }
        },
    );
};

// The name for a card's chip, by sandbox id: a lookup rather than a copied field, so a rename reaches every card at
// once.
export const boxNameOf = computed<ReadonlyMap<string, string>>(
    () => new Map(sandboxes.value.map((sandbox) => [sandbox.id, sandbox.name])),
);

// The sandbox image, or nothing for the monogram fallback; same lookup, same reason.
export const boxImageOf = computed<ReadonlyMap<string, string>>(
    () => new Map(sandboxes.value.flatMap((sandbox) => (sandbox.image === null ? [] : [[sandbox.id, sandbox.image] as const]))),
);

// Is this card's agent in a sandbox this browser isn't pointed at? `undefined` and the active sandbox must never be
// told apart by accident.
export const isRemote = (agent: Pick<FleetAgent, "sandboxId">): boolean =>
    agent.sandboxId !== undefined && agent.sandboxId !== activeSandboxId.value;

// Go to the agent in its own box, the one action on a distant card that costs a switch: reading and settling are calls
// addressed by id, but talking to one needs the chat singleton, which exists for one sandbox at a time.
export const openInSandbox = (sandboxId: string, agentId: string): void => {
    landOnAfterSwitch(sandboxId, toInside(sandboxId, page.agent(agentId)));
    useSandbox().select(sandboxId);
};
