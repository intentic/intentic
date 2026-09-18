<script setup lang="ts">
// The marks people leave on one conversation: a chip per emoji, everyone who left it named on hover, and a picker
// holding the rest.
// Shared by the board card and the session's own page, so a mark left in one is the same fact read in the other.
//
// NOTHING HERE MAY CHANGE THE SIZE OF WHAT HOSTS IT. On a card (`dense`) this draws marks and nothing else: a card
// nobody has marked renders no box at all, not an empty one, since an empty flex child still takes the row's gap, and
// a control reserving its seat in that row pushed the line below it onto a second row for good. The press that ADDS a
// mark is the host's to place, in whatever row it already reveals actions in — `open` is what it calls.
import { computed, ref } from "vue";
import type { AgentReaction } from "@intentic/sandbox-contract";
import { ResponsiveOverlay, ui } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { reactToAgent } from "../fleet/agentActions";
import { refreshAcross } from "../../sandbox/live/fleetAcross";
import { useAgents } from "../fleet/useAgents";
import { useSandboxSession } from "../../sandbox/client/sandboxSession";
import { PICKER_EMOJI, QUICK_EMOJI, reactionChips } from "./reactions";

const t = useT();

const {
    agentId,
    reactions,
    sandboxId,
    dense = false,
} = defineProps<{
    agentId: string;
    /** The marks the card carries now; absent means nobody has left one. */
    reactions?: readonly AgentReaction[] | undefined;
    /** Which sandbox owns the card (AgentReach): absent is the active one, a value is another box on the wider board. */
    sandboxId?: string | undefined;
    /**
     * The board's card: marks are drawn as counted stats among the row's other counted stats rather than as pills, and
     * the presses that add one are left to the host (`open`). A page with room passes nothing and gets both.
     */
    dense?: boolean;
}>();

const { presentedEmail } = useSandboxSession();
const { refresh: refreshAgents, notice } = useAgents();

const chips = computed(() => reactionChips(reactions, { me: presentedEmail.value, you: t(`agents.agentReactions.you`) }));

// The emoji whose press is in flight; one at a time, since each answer replaces the whole card.
const pending = ref<string | undefined>(undefined);
const picker = ref(false);
const trigger = ref<HTMLElement | null>(null);
// Whatever the picker hangs off: this component's own button, or the element a host opened it from.
const anchor = ref<HTMLElement | null>(null);

// Whether this reader already wears this mark, which is what decides the press: the daemon is told the intent, not
// asked to flip whatever it holds.
const worn = (emoji: string): boolean => chips.value.some((chip) => chip.emoji === emoji && chip.mine);

const press = async (emoji: string, on: boolean): Promise<void> => {
    if (pending.value !== undefined) {
        return;
    }
    pending.value = emoji;
    try {
        await reactToAgent(agentId, emoji, on, sandboxId);
        await (sandboxId === undefined ? refreshAgents() : Promise.resolve(refreshAcross()));
    } catch (caught) {
        notice.value = errorMessage(caught, t(`agents.agentReactions.couldNotReact`));
    } finally {
        pending.value = undefined;
    }
};

// Closes the picker before the request, not after: the answer repaints the row underneath, and a panel still open over
// it hides the very chip the press just made.
const pick = async (emoji: string): Promise<void> => {
    picker.value = false;
    await press(emoji, !worn(emoji));
};

// The host's own press, hanging the picker off whatever button it drew. The only thing a host needs from here, which
// is what keeps the chips and the press that makes one from having to live in the same row.
const open = (from: HTMLElement): void => {
    anchor.value = from;
    picker.value = !picker.value;
};
defineExpose({ open });

// On a page (not a card) the two quick answers stand beside the chips; one already worn is a chip, and drawing it
// twice would offer the same press in two places.
const quick = computed(() => QUICK_EMOJI.filter((emoji) => !chips.value.some((chip) => chip.emoji === emoji)));
</script>

<template>
    <!-- No box at all for an unmarked card: an empty one would still take the row's gap. -->
    <div v-if="!dense || chips.length > 0" class="inline-flex min-w-0 shrink-0 items-center" :class="dense ? `gap-2.5` : `gap-1`">
        <button
            v-for="chip in chips"
            :key="chip.emoji"
            type="button"
            :class="[
                dense ? `touch-target inline-flex cursor-pointer items-center gap-1 rounded transition-colors` : `ui-chip gap-1 px-2`,
                /* On the card the mark is a stat among stats, so its own tint says it is yours; on a page with room the chip wears the kit's lit plate. */
                chip.mine ? (dense ? `font-medium text-link` : `ui-chip-on`) : dense ? `hover:text-content` : ``,
            ]"
            :aria-pressed="chip.mine"
            :aria-label="t(`agents.agentReactions.markedBy`, { emoji: chip.emoji, who: chip.who })"
            v-tooltip.top="chip.who"
            :disabled="pending !== undefined"
            @click.stop="press(chip.emoji, !chip.mine)"
        >
            <span aria-hidden="true">{{ chip.emoji }}</span>
            <span class="tabular-nums">{{ chip.count }}</span>
        </button>

        <template v-if="!dense">
            <button
                v-for="emoji in quick"
                :key="emoji"
                type="button"
                class="ui-chip px-2 opacity-70 hover:opacity-100"
                :aria-label="t(`agents.agentReactions.markWith`, { emoji })"
                v-tooltip.top="t(`agents.agentReactions.markWith`, { emoji })"
                :disabled="pending !== undefined"
                @click.stop="press(emoji, true)"
            >
                <span aria-hidden="true">{{ emoji }}</span>
            </button>
            <button
                ref="trigger"
                type="button"
                :class="ui.iconButton(`h-6 w-6`)"
                :aria-label="t(`agents.agentReactions.addReaction`)"
                v-tooltip.top="t(`agents.agentReactions.addReaction`)"
                :disabled="pending !== undefined"
                @click.stop="open(trigger!)"
            >
                <Icon name="plus" class="text-2xs" />
            </button>
        </template>
    </div>

    <!-- Outside the box above, since a dense card may draw no box and still has to be able to open this. -->
    <ResponsiveOverlay
        v-model="picker"
        :anchor="anchor ?? trigger ?? undefined"
        :header="t(`agents.agentReactions.pickAMark`)"
        side="bottom"
        panel-class="w-72 p-2"
    >
        <!-- The stop is on this element, not on the overlay: the desktop panel teleports to the body, but the phone's sheet does not, and a tap inside it would otherwise open the card underneath. -->
        <div class="grid grid-cols-8 gap-0.5" @click.stop>
            <button
                v-for="emoji in PICKER_EMOJI"
                :key="emoji"
                type="button"
                class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-base transition-colors hover:bg-overlay"
                :class="worn(emoji) ? `bg-overlay` : ``"
                :aria-label="emoji"
                :aria-pressed="worn(emoji)"
                @click="pick(emoji)"
            >
                {{ emoji }}
            </button>
        </div>
    </ResponsiveOverlay>
</template>
