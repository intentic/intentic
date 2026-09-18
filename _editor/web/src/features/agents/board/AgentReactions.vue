<script setup lang="ts">
// The marks people leave on one conversation: a chip per emoji, everyone who left it named on hover, and a picker
// that leads with the two answers a board is usually asked for before offering the rest.
// Shared by the board card and the session's own page, so a mark left in one is the same fact read in the other.
import { computed, ref } from "vue";
import { type AgentReaction, EMOJI_MAX_LENGTH, isSingleEmoji } from "@intentic/sandbox-contract";
import { Button, ResponsiveOverlay, ui, useDevice } from "@intentic/ui";
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
    tuck = false,
} = defineProps<{
    agentId: string;
    /** The marks the card carries now; absent means nobody has left one. */
    reactions?: readonly AgentReaction[] | undefined;
    /** Which sandbox owns the card (AgentReach): absent is the active one, a value is another box on the wider board. */
    sandboxId?: string | undefined;
    /**
     * Keep the presses that ADD a mark out of sight until the card is under the pointer. For the board's dense card,
     * where they belong to a reader who has already stopped on one; a page with room passes nothing.
     */
    tuck?: boolean;
}>();

const { presentedEmail } = useSandboxSession();
const { refresh: refreshAgents, notice } = useAgents();
const { mobile } = useDevice();

const chips = computed(() => reactionChips(reactions, { me: presentedEmail.value, you: t(`agents.agentReactions.you`) }));
// A phone has no pointer to reveal anything with, so there the presses simply stay.
const tucked = computed(() => tuck && !mobile.value);
// With nothing to show, the tucked row takes no height at all rather than opening an empty strip on every card.
const rowClass = computed(() => (tucked.value && chips.value.length === 0 ? `hidden group-focus-within:flex group-hover:flex` : `flex`));
const addClass = computed(() => (tucked.value ? `opacity-0 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100` : ``));

// The emoji whose press is in flight; one at a time, since each answer replaces the whole card.
const pending = ref<string | undefined>(undefined);
const picker = ref(false);
const trigger = ref<HTMLElement | null>(null);
const typed = ref(``);
const typedEmoji = computed(() => typed.value.trim());
const typedIsEmoji = computed(() => isSingleEmoji(typedEmoji.value));

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
    typed.value = ``;
    await press(emoji, !worn(emoji));
};

// Quick picks are drawn only for marks the card does not already carry; one that is there is a chip, and drawing both
// would put the same emoji on the row twice.
const quick = computed(() => QUICK_EMOJI.filter((emoji) => !chips.value.some((chip) => chip.emoji === emoji)));
</script>

<template>
    <div class="min-w-0 flex-wrap items-center gap-1" :class="rowClass">
        <button
            v-for="chip in chips"
            :key="chip.emoji"
            type="button"
            class="ui-chip gap-1 px-2"
            :class="chip.mine ? `ui-chip-on` : ``"
            :aria-pressed="chip.mine"
            :aria-label="t(`agents.agentReactions.markedBy`, { emoji: chip.emoji, who: chip.who })"
            v-tooltip.top="chip.who"
            :disabled="pending !== undefined"
            @click.stop="press(chip.emoji, !chip.mine)"
        >
            <span aria-hidden="true">{{ chip.emoji }}</span>
            <span class="tabular-nums">{{ chip.count }}</span>
        </button>

        <span class="inline-flex items-center gap-1" :class="addClass">
            <!-- The two quick answers, at the chip's own size so the row reads as one strip rather than as chips plus controls. -->
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
                :aria-label="t(`agents.agentReactions.anotherMark`)"
                v-tooltip.top="t(`agents.agentReactions.anotherMark`)"
                :disabled="pending !== undefined"
                @click.stop="picker = !picker"
            >
                <Icon name="plus" class="text-2xs" />
            </button>
        </span>

        <ResponsiveOverlay
            v-model="picker"
            :anchor="trigger ?? undefined"
            :header="t(`agents.agentReactions.pickAMark`)"
            panel-class="w-64 p-2"
        >
            <!-- The stop is on this element, not on the overlay: the desktop panel teleports to the body, but the phone's sheet does not, and a tap inside it would otherwise open the card underneath. -->
            <div class="flex flex-col gap-2" @click.stop>
                <div class="grid grid-cols-8 gap-0.5">
                    <button
                        v-for="emoji in PICKER_EMOJI"
                        :key="emoji"
                        type="button"
                        class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-sm transition-colors hover:bg-overlay"
                        :class="worn(emoji) ? `bg-overlay` : ``"
                        :aria-label="emoji"
                        :aria-pressed="worn(emoji)"
                        @click="pick(emoji)"
                    >
                        {{ emoji }}
                    </button>
                </div>
                <!-- Anything at all, for the mark this grid was never going to guess: one emoji, typed or pasted. -->
                <div class="flex items-center gap-1.5">
                    <input
                        v-model="typed"
                        type="text"
                        :maxlength="EMOJI_MAX_LENGTH"
                        :class="ui.inputSm(`min-w-0 flex-1`)"
                        :placeholder="t(`agents.agentReactions.anyEmoji`)"
                        :aria-label="t(`agents.agentReactions.anyEmoji`)"
                        @keydown.enter.prevent="typedIsEmoji ? pick(typedEmoji) : undefined"
                    />
                    <Button size="small" :disabled="!typedIsEmoji" @click="pick(typedEmoji)">{{ t(`ui.action.add`) }}</Button>
                </div>
            </div>
        </ResponsiveOverlay>
    </div>
</template>
