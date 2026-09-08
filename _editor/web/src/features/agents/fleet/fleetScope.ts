import { definePreference } from "@intentic/ui/preference";
import { computed, type Ref, watch } from "vue";
import { boxAttention, markSeenAcross, otherBoxes, silentBoxes } from "../../sandbox/live/fleetAcross";
import { onScreen } from "../../../shell/window/onScreen";
import { connectedSandboxes } from "../../sandbox/live/roster";
import { landOnAfterSwitch } from "../../sandbox/client/sandboxScreen";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { turnInFlight } from "./agentStatus";
import type { FleetAgent } from "./useAgents-fleet";
import { useChat } from "../../chat/run/useChat";
import { chatStrip } from "../../chat/panel/useChat-strip";

// How much of the account the fleet board covers: the sandbox you're in, or all of them. A scope on the existing board
// rather than a second one, since the cards, lanes, drops and review panel are the same regardless of source. An
// account-level preference, like the terminal panel's switches, since which fleet you want is a property of how you
// work, not of the box you're standing in.

export type FleetScope = "box" | "all";

const STORAGE_KEY = `ui-fleet-scope`;

export const fleetScope: Ref<FleetScope> = definePreference<FleetScope>({
    key: STORAGE_KEY,
    // Defaults to this box: the wider board costs a request per sandbox while open, and a single-sandbox account must
    // never see a control with only one answer.
    read: (raw) => (raw === `all` ? `all` : `box`),
    write: (value) => value,
});

const { sandboxes, activeSandboxId } = useSandbox();

// Whether the control is drawn at all: one connected sandbox is not a fleet, and a switch with nowhere else to look
// would offer two settings that produce the same screen.
export const scopeOffered = computed(() => connectedSandboxes(sandboxes.value).length > 1);

// Is the board actually reading across sandboxes now: the preference and somewhere to read it, so an account that drops
// to one sandbox keeps its stored `all` but behaves as `box` until there's a second again.
export const readingAcross = computed(() => fleetScope.value === `all` && scopeOffered.value);

// Every other box's agents as board cards: the parts only a conversation can answer (`open`, `unsent`) are read from
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
        box.agents.map((agent): FleetAgent => {
            const tab = tabOf.get(cardKey(box.sandbox.id, agent.id));
            return {
                ...agent,
                sandboxId: box.sandbox.id,
                open: tab !== undefined,
                // Unsent words exist in exactly one place, the composer in front of the user, so this is read from the
                // tab or is false.
                unsent: tab?.unsent ?? false,
                unread: !turnInFlight(agent) && agent.updatedAt > (agent.seenAt ?? 0),
            };
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

// The line the board owes when its answer is partial: an empty Attention lane built on a request that never came back
// would read as "nothing there", so this names which boxes, by name, rather than a count.
export const partialAnswer = computed<{ readonly title: string; readonly detail: string } | undefined>(() => {
    if (!readingAcross.value) {
        return undefined;
    }
    const silent = silentBoxes.value;
    if (silent.length === 0) {
        return undefined;
    }
    const names = silent.map((box) => box.sandbox.name);
    const one = names.length === 1;
    return {
        title: `${listNames(names)} ${one ? `isn't` : `aren't`} answering`,
        detail: `This board leaves ${one ? `it` : `them`} out until ${one ? `it does` : `they do`}.`,
    };
});

// Names for a reader, not a count: three is where a list stops being read and starts being skimmed.
export const listNames = (names: readonly string[]): string =>
    names.length <= 3 ? names.join(`, `) : `${names.slice(0, 3).join(`, `)} and ${names.length - 3} more`;

// The sum of what every other box says it needs, the half of the rail badge that only exists while the scope is wide; a
// box that hasn't answered contributes nothing rather than blocking the sum.
export const acrossAttention = computed<number>(() => otherBoxes.value.reduce((total, box) => total + (boxAttention(box) ?? 0), 0));

// Is this card's agent in a sandbox this browser isn't pointed at? `undefined` and the active sandbox must never be
// told apart by accident.
export const isRemote = (agent: Pick<FleetAgent, "sandboxId">): boolean =>
    agent.sandboxId !== undefined && agent.sandboxId !== activeSandboxId.value;

// Go to the agent in its own box, the one action on a distant card that costs a switch: reading and settling are calls
// addressed by id, but talking to one needs the chat singleton, which exists for one sandbox at a time.
export const openInSandbox = (sandboxId: string, agentId: string): void => {
    landOnAfterSwitch(sandboxId, `/agents/${encodeURIComponent(agentId)}`);
    useSandbox().select(sandboxId);
};
