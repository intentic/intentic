import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Tip } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatWhen } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { sandboxNow } from "../../../../models/agent-status/sandboxClock";
import { turnInFlight, watching } from "../../../../models/agent-status/agentStatus-standing";
import { promptLine, type SelfStart, selfStart, selfStartTicks, watchLine } from "../../../../models/agent-status/agentStatus-clock";
import { answeredAt } from "../../../../models/agent-status/answeredAt";
import { cacheCooling, cacheWarm, warmMark } from "../../../../models/fleet/promptCache";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

// AN AGENT CARD'S "WHEN", decided once for the two seats that draw it: the header's corner (AgentCardWhen: the running
// elapsed, or the settled age) and the closing row (AgentCardClock: a watch, when it goes again by itself, a cache
// countdown). One decision, since each reading takes the slot from the others: a corner date beside a watch's countdown
// would be two answers to "when" on one card.
//
// The card builds this and hands it down, and only the two seats read what moves with the clock, so a tick redraws
// them and never the card around them. The card itself reads `row` alone, a boolean that only flips when a reading
// comes or goes (a computed notifies only when its value changes).

// Its hover from the facts the card holds (whose limit, when it reopens, when a message goes) rather than the provider's
// refusal sentence; the slot says the wait, the hover the instant. Whatever goes by itself says so, so nothing needs
// pressing (and the card offers no press: AgentCard's `resendable`); a limit nothing is booked for says when it is back.
const goesTipOf = (corner: SelfStart | undefined, now: number, provider: string, t: ReturnType<typeof useT>): Tip | undefined => {
    if (corner === undefined) {
        return undefined;
    }
    const noPress = t(`agents.agentCard.noPressNeeded`);
    if (corner.kind === `room`) {
        return { title: t(`agents.agentStatus.heldMemory`), tone: `info`, note: noPress };
    }
    if (corner.kind === `send`) {
        const when = corner.after !== undefined ? t(`chat.sendLater.afterLands`, { title: corner.after }) : corner.clock === undefined ? corner.text : formatWhen(corner.clock.at, now);
        const many = corner.count > 1 ? [{ label: t(`agents.agentCard.scheduledMessages`), value: corner.count }] : [];
        return { title: t(`chat.chatHeld.scheduled`), tone: `info`, rows: [{ label: t(`chat.composerIntent.sendsAt`), value: when }, ...many], note: noPress };
    }
    const providerRow = { label: t(`agents.words.provider`), value: providerLabel(provider) };
    if (corner.kind === `back`) {
        return {
            title: t(`agents.agentStatus.usageLimit`),
            tone: `warning`,
            rows: [providerRow, { label: t(`agents.agentCard.reopens`), value: formatWhen(corner.clock.at, now) }],
        };
    }
    const at = corner.kind === `resend` && corner.clock !== undefined ? [{ label: t(`agents.agentCard.resendsAt`), value: formatWhen(corner.clock.at, now) }] : [];
    return {
        title: corner.kind === `moving` ? t(`agents.agentStatus.movingTo`, { account: corner.account }) : t(`agents.agentCard.resendBooked`),
        tone: `info`,
        rows: [providerRow, ...at],
        note: noPress,
    };
};

export const useCardClock = (agentOf: () => FleetAgent, workingOf: () => boolean, titleOf?: (conversationId: string) => string | undefined) => {
    const t = useT();
    // Second-rate ticks only for live clocks (turn, watch, a self-start's countdown, warm cache); dates use AgentCardDate.
    // On the sandbox's clock: every instant these count to or from is one the sandbox stamped (sandboxClock.ts).
    const tick = useNow(() => {
        const agent = agentOf();
        return turnInFlight(agent) || watching(agent) || selfStartTicks(agent) || cacheWarm(agent);
    });
    const now = computed(() => sandboxNow(tick.value));
    // An archived card's corner dates it by when it left the board, and nothing but a watch (whose Stop is the one press
    // an archived card keeps) borrows the row: every other reading is a promise about a card that is filed away.
    const archived = computed(() => agentOf().archivedAt !== undefined);
    // When the card goes again by itself, read off the card's own `next` (agentStatus.selfStart): a spent allowance's resend
    // or move, or when it is back when nothing carries it on; a message held for memory sent once memory frees; messages
    // booked for a time or another agent's land. The chip says why it waits, this says what goes and when, which is also why
    // a card resting in Active is there.
    const goes = computed(() => selfStart(agentOf(), now.value, titleOf));
    // A held turn or held message takes the slot from the watch, the cache and the date: a watch firing into a shut window
    // or a full sandbox runs nothing (turn-admission holds its words back), so the hold's end is the next moment the card
    // can move. A message booked for later does not: a watch's wake would run before it, and a live turn's readout speaks
    // for the card while it runs, so either takes the slot and the booking has it back once they are done.
    const holding = computed(() => goes.value !== undefined && goes.value.kind !== `send`);
    // Suppressed while a turn is in flight: the running corner already answers "doing what, for how long", and reclaims it
    // the moment the turn ends. The watch's countdown comes back with its Stop press once a hold has had its say.
    const watch = computed(() => (workingOf() || holding.value ? undefined : watchLine(agentOf(), now.value)));
    const shown = computed(() =>
        archived.value || (goes.value?.kind === `send` && (workingOf() || watch.value !== undefined)) ? undefined : goes.value,
    );
    // Takes the watch's place when what the watch waits on is a command at a prompt: its countdown promised a wake that the
    // command's exit would bring, and that exit will not come by itself.
    const prompt = computed(() => (watch.value === undefined ? undefined : promptLine(agentOf(), now.value)));
    // The watch's own Stop ends the commands its watches wait on (useAgentDrag's `unwatch`), so it says so when there are any.
    const stopsCommand = computed(() => {
        const agent = agentOf();
        const armed = new Set((agent.watches ?? []).map((entry) => entry.id));
        return (agent.jobs ?? []).some((job) => job.endedAt === undefined && job.watch !== undefined && armed.has(job.watch));
    });
    const goesTip = computed(() => goesTipOf(shown.value, now.value, agentOf().provider, t));
    // Shares that slot, and yields it: a reset clock and a watch are each a firmer promise about the card than a cache that
    // only makes answering cheaper, so this speaks when the slot is otherwise free.
    const cooling = computed(() => (archived.value || watch.value !== undefined || holding.value ? undefined : cacheCooling(agentOf(), now.value)));
    // A hold outranks the cooling clock in that slot: it is the answer to the question the cooling chip asks.
    const warm = computed(() => (archived.value || watch.value !== undefined || holding.value || workingOf() ? undefined : warmMark(agentOf())));
    // Either cache mark's hover, closed by what pressing it does, since the press is this slot's own.
    const warmTip = computed((): Tip | undefined =>
        warm.value === undefined ? undefined : { ...warm.value.hint, note: t(`agents.promptCache.clickToChange`) },
    );
    const coolingTip = computed((): Tip | undefined =>
        cooling.value === undefined ? undefined : { ...cooling.value.hint, note: t(`agents.promptCache.clickToKeepWarm`) },
    );
    // The settled date: when the model last answered, never when a land or a failure last touched the card, so the reader
    // can tell how cold its cache has gone. The hover says which instant it is, since "Updated" would read as anything.
    const answered = computed(() => answeredAt(agentOf()));
    const answeredTip = computed(
        (): Tip => ({
            title: t(`agents.agentCard.lastAnswered`, { when: formatWhen(answered.value, now.value) }),
            note: t(`agents.agentCard.lastAnsweredNote`),
        }),
    );
    // Whether the closing row has a reading to draw. The corner's date is the default, so any of these takes its place.
    const row = computed(() => shown.value !== undefined || warm.value !== undefined || cooling.value !== undefined || watch.value !== undefined);
    // What the corner draws: the running elapsed, the archived age, the settled age, or nothing while the row's reading
    // speaks for the card (a card is only ever one of those at a time).
    const corner = computed((): `working` | `archived` | `answered` | undefined => {
        const agent = agentOf();
        if (workingOf()) {
            return `working`;
        }
        if (agent.archivedAt !== undefined) {
            return `archived`;
        }
        return row.value || agent.updatedAt <= 0 ? undefined : `answered`;
    });
    return { now, shown, goesTip, warm, warmTip, cooling, coolingTip, watch, prompt, stopsCommand, answered, answeredTip, row, corner };
};

export type CardClock = ReturnType<typeof useCardClock>;
