import { definePreference } from "@intentic/ui/preference";
import { computed, type Ref, watch } from "vue";
import { boxAttention, markSeenAcross, otherBoxes, silentBoxes } from "../sandbox/fleetAcross";
import { onScreen } from "../onScreen";
import { connectedSandboxes } from "../sandbox/roster";
import { landOnAfterSwitch } from "../sandbox/sandboxScreen";
import { useSandbox } from "../sandbox/useSandbox";
import { turnInFlight } from "./agentStatus";
import type { FleetAgent } from "./useAgents";
import { useChat } from "../chat/useChat";

/* HOW MUCH OF THE ACCOUNT THE FLEET BOARD IS ABOUT: the sandbox you are standing in, or all of them.
 *
 * The board is the one surface in this app whose subject is the WORK rather than the machine, and the work is
 * spread over as many sandboxes as the user keeps. Until this, reaching an agent in another box meant switching
 * to it, and a switch tears down the chat, the editor, the tree, the fleet, the presence roster and every
 * extension activation (sandboxScope.ts) to answer a question that is usually "is it done yet".
 *
 * A SCOPE ON THE EXISTING BOARD RATHER THAN A SECOND BOARD. The rail seats about nine tiles above the fold on a
 * laptop (core-views/registry.ts), so a second Agents tile would cost a badged one its seat to say the same
 * noun twice; and the cards, the lanes, the drag-to-act drops and the review panel are the same in both scopes
 * because they are about the same thing. What widens is where the cards come from.
 *
 * AN ACCOUNT PREFERENCE, like the terminal panel's own switches: which fleet you want in front of you is a
 * property of how a person works, not of the box they happen to be pointed at, and storing it per sandbox would
 * mean the scope flipped back every time you crossed to a card you had just found through it. */

export type FleetScope = "box" | "all";

const STORAGE_KEY = `ui-fleet-scope`;

export const fleetScope: Ref<FleetScope> = definePreference<FleetScope>({
    key: STORAGE_KEY,
    // Default to this box. The wider board costs a request per sandbox while it is open, and, more to the
    // point, an account with one sandbox must never be shown a control that could only ever have one answer.
    read: (raw) => (raw === `all` ? `all` : `box`),
    write: (value) => value,
});

const { sandboxes, activeSandboxId } = useSandbox();

/* WHETHER THE CONTROL IS DRAWN AT ALL. One connected sandbox is not a fleet, and a scope switch on a board that
 * has nowhere else to look is a control whose two settings produce the same screen. It is also the honest read
 * of the rail's own rule about tiles: a thing that can never say anything does not earn the space. */
export const scopeOffered = computed(() => connectedSandboxes(sandboxes.value).length > 1);

// Is the board actually reading across sandboxes right now? The preference AND somewhere to read: an account
// that drops to one sandbox keeps its stored `all` (they will likely add another) and the board quietly
// behaves as `box` until there is a second one, rather than drawing a scope that resolves to nothing.
export const readingAcross = computed(() => fleetScope.value === `all` && scopeOffered.value);

/* EVERY OTHER BOX'S AGENTS AS BOARD CARDS.
 *
 * The parts a FleetAgent carries that only a conversation can answer are read from THIS BROWSER's tabs or they
 * are false, never guessed: `open` and `unsent` are facts about a window, and a summary read from another
 * daemon knows nothing about windows. The actions that depend on a conversation (reply, steer) read the same
 * two fields and offer the crossing where there is no tab (AgentCard).
 *
 * `unread` is derived exactly as the local fleet derives it: the read marker lives on the daemon entry
 * (seenAt), not in this browser, so it means the same thing at a distance as it does up close. */
// (id, sandbox) as one string, because that pair IS an agent's identity across boxes and a Map wants one key.
const cardKey = (sandboxId: string, agentId: string): string => `${sandboxId}/${agentId}`;

export const otherFleet = computed<readonly FleetAgent[]>(() => {
    /* …EXCEPT WHEN THIS BROWSER IS THE ONE HOLDING THE TAB. A conversation can now be STARTED in another box
     * from the composer (Conversation.box), so "an agent over there" and "a chat open here" stopped being
     * mutually exclusive: the tab is in this window and the turn runs on that daemon. The card has to know,
     * because `open` is what the board reads to offer Reply rather than the crossing, and a card that claimed
     * no tab would send its reader on a sandbox switch to reach a conversation already on their screen.
     *
     * Matched on (id, box), never on the id alone: two sandboxes can hold one conversation id, and a tab open
     * on THIS box's copy must not mark the other box's card as open. */
    const local = useChat().conversations.value;
    const tabOf = new Map(local.flatMap((tab) => (tab.box.value === undefined ? [] : [[cardKey(tab.box.value, tab.conversationId), tab] as const])));
    return otherBoxes.value.flatMap((box) =>
        box.agents.map((agent): FleetAgent => {
            const tab = tabOf.get(cardKey(box.sandbox.id, agent.id));
            return {
                ...agent,
                sandboxId: box.sandbox.id,
                open: tab !== undefined,
                // Unsent words exist in exactly one place, the composer in front of the user, so this is read
                // from the tab or it is false: a summary from another daemon has no way to know.
                unsent: tab?.unsent.value ?? false,
                unread: !turnInFlight(agent) && agent.updatedAt > (agent.seenAt ?? 0),
            };
        }),
    );
});

/* A CONVERSATION YOU ARE SITTING IN FRONT OF IS NOT NEWS, WHICHEVER BOX IT RUNS IN.
 *
 * `useAgents` holds this rule for the streamed sandbox: a turn that finishes while its chat is focused and the
 * window is on screen is already read, so the card must not flip to "New" under the cursor and the rail must
 * not badge it. That watch reads the local fleet, so a conversation homed elsewhere (Conversation.box) fell
 * outside it entirely and would have kept its unread mark for as long as the account had that box, with the
 * scoped badge counting it the whole time.
 *
 * Same three conditions as the original, and the same tolerance: it needs the cross-box store to be live to
 * see the unread mark at all, which it is exactly while the badge is counting those boxes (agentsTile). With
 * the scope narrow there is nothing on screen to be wrong, and switching it on re-reads and fires this then. */
export const watchRemoteSeen = (): void => {
    watch(
        () => {
            const active = useChat().active.value;
            const at = active.box.value;
            if (!onScreen.value || at === undefined) {
                return undefined;
            }
            const card = otherFleet.value.find((agent) => agent.id === active.conversationId && agent.sandboxId === at);
            // The KEY rather than a pair, so an unchanged answer is an unchanged value: a fresh object every
            // evaluation would re-fire this watch on every poll tick that left the same chat unread.
            return card?.unread === true ? cardKey(at, active.conversationId) : undefined;
        },
        (seen) => {
            // Split at the FIRST separator: a sandbox id never holds one, a conversation id has no promise to
            // keep about it, and cutting at the last would hand the box half of somebody's agent name.
            const cut = seen?.indexOf(`/`) ?? -1;
            if (seen !== undefined && cut > 0) {
                markSeenAcross(seen.slice(0, cut), seen.slice(cut + 1));
            }
        },
    );
};

// The name to put on a card's chip, by sandbox id. A lookup rather than a field on the card, because the name
// is the sandbox's to change and a card holding a copy of it would go stale the moment somebody renamed a box.
export const boxNameOf = computed<ReadonlyMap<string, string>>(
    () => new Map(sandboxes.value.map((sandbox) => [sandbox.id, sandbox.name])),
);

// The sandbox image (or nothing, for the monogram fallback the switcher uses), same lookup, same reason. The
// chip wears whatever the rail chip wears for that box, so a card is recognizable without being read.
export const boxImageOf = computed<ReadonlyMap<string, string>>(
    () => new Map(sandboxes.value.flatMap((sandbox) => (sandbox.image === null ? [] : [[sandbox.id, sandbox.image] as const]))),
);

/* THE LINE THE BOARD OWES ITS READER WHEN ITS ANSWER IS PARTIAL.
 *
 * This is the first surface in the app whose failure mode is not binary. Everywhere else the daemon is
 * reachable or it is not, and the shell draws a gate over the whole screen. Here three boxes can answer and two
 * can be asleep, and the board must not let the silence read as "nothing there": an empty Attention lane is a
 * claim, and a claim made on the strength of a request that never came back is the one this design refuses.
 *
 * So it says which boxes, by name, rather than a count. Two names is the common case, and a name is what tells
 * the reader whether the missing box is the one they care about. Undefined when everything answered. */
export const partialAnswer = computed<string | undefined>(() => {
    if (!readingAcross.value) {
        return undefined;
    }
    const silent = silentBoxes.value;
    if (silent.length === 0) {
        return undefined;
    }
    const names = silent.map((box) => box.sandbox.name);
    return `${listNames(names)} ${names.length === 1 ? `isn't` : `aren't`} answering, so what's on this board leaves ${names.length === 1 ? `it` : `them`} out.`;
});

// Names of sandboxes, for a reader rather than for a count: three is where a list stops being read and starts
// being skimmed. Shared by the board's line above and the rail tile's note (agentsTile.ts), which say the same
// thing at two lengths and must not disagree about which boxes are missing.
export const listNames = (names: readonly string[]): string =>
    names.length <= 3 ? names.join(`, `) : `${names.slice(0, 3).join(`, `)} and ${names.length - 3} more`;

/* HOW MANY AGENTS WANT THE USER IN THE BOXES THIS BROWSER IS NOT POINTED AT: the sum of the per-box readings
 * the switcher's rows already draw, and the half of the rail badge that only exists while the scope is wide.
 *
 * A BOX THAT HAS NOT ANSWERED CONTRIBUTES NOTHING rather than blocking the sum. The switcher can draw a dash on
 * one row because it has a row per box; a single badge has one number and no way to be partly unknown, so the
 * unknown is told beside it in words (`agentsTile.scopeNote`) instead of being smuggled into the digit. */
export const acrossAttention = computed<number>(() => otherBoxes.value.reduce((total, box) => total + (boxAttention(box) ?? 0), 0));

// Is this card's agent in a sandbox this browser is not pointed at? The one question every action on the board
// has to ask before it addresses the daemon, and the reason it is a function rather than a field read inline:
// `undefined` and "the active one" mean the same thing and must never be told apart by accident.
export const isRemote = (agent: Pick<FleetAgent, "sandboxId">): boolean =>
    agent.sandboxId !== undefined && agent.sandboxId !== activeSandboxId.value;

/* GO TO THE AGENT, IN ITS OWN BOX. The one action on a distant card that costs a switch, and the whole reason
 * the others do not have to.
 *
 * Reading an agent's work and settling it are calls addressed by id, so the board does them where you stand.
 * TALKING to one is not: a turn streams into a Conversation held by the chat singleton, and that singleton is
 * torn down and rebuilt on every switch (sandboxScope), which is the same as saying there is exactly one
 * sandbox you can hold a conversation in. So a reply is a crossing, and this is it, made deliberately and
 * labelled with the name of where it goes rather than happening behind a Reply box.
 *
 * The destination is recorded before the selection moves, because the switch's own landing rule would
 * otherwise take the reader to whatever that box was last showing (sandboxScreen owns both halves of this). */
export const openInSandbox = (sandboxId: string, agentId: string): void => {
    landOnAfterSwitch(sandboxId, `/agents/${encodeURIComponent(agentId)}`);
    useSandbox().select(sandboxId);
};
