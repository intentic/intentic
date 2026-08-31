import { definePreference } from "@intentic/ui/preference";
import { computed, type Ref } from "vue";
import { otherBoxes, silentBoxes } from "../sandbox/fleetAcross";
import { connectedSandboxes } from "../sandbox/roster";
import { landOnAfterSwitch } from "../sandbox/sandboxScreen";
import { useSandbox } from "../sandbox/useSandbox";
import { turnInFlight } from "./agentStatus";
import type { FleetAgent } from "./useAgents";

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
 * The parts a FleetAgent carries that only a local conversation can answer are FALSE here rather than guessed:
 * `open` and `unsent` are facts about a tab in THIS browser pointed at THIS daemon, and a summary read from
 * another box has no tab and no composer. Saying so plainly is what keeps the card honest, it will not claim
 * unsent words that live in a window nobody has open, and the actions that depend on a conversation (reply,
 * steer) read the same absence and offer the crossing instead (AgentCard).
 *
 * `unread` is derived exactly as the local fleet derives it: the read marker lives on the daemon entry
 * (seenAt), not in this browser, so it means the same thing at a distance as it does up close. */
export const otherFleet = computed<readonly FleetAgent[]>(() =>
    otherBoxes.value.flatMap((box) =>
        box.agents.map(
            (agent): FleetAgent => ({
                ...agent,
                sandboxId: box.sandbox.id,
                open: false,
                unsent: false,
                unread: !turnInFlight(agent) && agent.updatedAt > (agent.seenAt ?? 0),
            }),
        ),
    ),
);

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
    const listed = names.length <= 3 ? names.join(`, `) : `${names.slice(0, 3).join(`, `)} and ${names.length - 3} more`;
    return `${listed} ${names.length === 1 ? `isn't` : `aren't`} answering, so what's on this board leaves ${names.length === 1 ? `it` : `them`} out.`;
});

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
