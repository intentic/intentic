<script setup lang="ts">
// A board card's presses, floated over its top edge while the pointer is on the card (Discord's message bar is the
// model): the card's tools (changes, code review, test), a 👍 and the picker for
// the rest, then its filing press and the ⋯.
//
// WHY IT FLOATS. The header used to reserve a seat per press beside the title, hidden or not, so on a 300px card the name
// kept what four glyphs and their gaps left of it, and the press that leaves a reaction was a bare plus among them. Laid
// over the card instead, the bar takes no width at rest: the title has the whole row, and revealing the bar resizes
// nothing. It is for a fine pointer only; a touch screen has no hover to reveal it on, and keeps the header's ⋯ (AgentCard).
import { type ActionItem, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { reactions, tools = [], filing = [], menu = false } = defineProps<{
    // The quick reactions and whether the reader already wears each; absent where nobody can react (another box's card).
    reactions?: { readonly quick: readonly string[]; readonly worn: ReadonlySet<string>; readonly busy: boolean } | undefined;
    // What the card leads somewhere with: its changes, its drill-in, a code review and a test pass of its work.
    tools?: readonly ActionItem[];
    // Rename where there is no menu to hold it, then archive, close or restore.
    filing?: readonly ActionItem[];
    // Whether the board offers its menu, which this bar's ⋯ opens.
    menu?: boolean;
}>();

const emit = defineEmits<{ react: [emoji: string]; pick: [from: HTMLElement]; menu: [event: MouseEvent] }>();

// One shape for every press in the bar: a 28px square on a 24px glyph box, its fill an ink tint, since the bar is a
// floating surface and a surface-named fill would vanish on it in the light look.
const PRESS = `flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-40`;
</script>

<template>
    <!-- Hidden at rest, and taking no pointer then, so a press on the card's corner never lands on an invisible button. Shown
         while the card is hovered or anything in it has focus, so a keyboard reaches every press too. -->
    <div
        role="toolbar"
        :aria-label="t(`ui.action.moreActions`)"
        data-card-bar
        class="pointer-events-none absolute -top-3.5 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-line bg-card p-0.5 opacity-0 shadow-md transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
        @click.stop
        @dblclick.stop
        @pointerdown.stop
    >
        <!-- Work first (what a card is opened for: its changes, a review, a test), then the verdict marks, then filing and the
             menu at the far edge, so the destructive presses sit apart from the ones pressed most. -->
        <button
            v-for="action in tools"
            :key="action.id"
            type="button"
            :class="[PRESS, action.danger === true ? 'hover:text-danger' : '']"
            :aria-label="action.label"
            :disabled="action.disabled"
            v-tooltip.top="action.hint ?? action.label"
            @click="action.run($event.currentTarget as HTMLElement)"
        >
            <Icon :name="action.icon" class="text-sm" />
        </button>
        <span v-if="tools.length > 0 && reactions !== undefined" aria-hidden="true" class="mx-0.5 h-4 w-px bg-line" />
        <template v-if="reactions !== undefined">
            <button
                v-for="emoji in reactions.quick"
                :key="emoji"
                type="button"
                :class="[PRESS, 'text-sm', reactions.worn.has(emoji) ? 'bg-primary-600/20' : '']"
                :aria-label="t(`agents.agentReactions.markWith`, { emoji })"
                :aria-pressed="reactions.worn.has(emoji)"
                :disabled="reactions.busy"
                v-tooltip.top="t(`agents.agentReactions.react`)"
                @click="emit(`react`, emoji)"
            >
                <span aria-hidden="true">{{ emoji }}</span>
            </button>
            <button
                type="button"
                :class="PRESS"
                :aria-label="t(`agents.agentReactions.addReaction`)"
                :disabled="reactions.busy"
                v-tooltip.top="t(`agents.agentReactions.addReaction`)"
                @click="emit(`pick`, $event.currentTarget as HTMLElement)"
            >
                <Icon name="face-smile" class="text-sm" />
            </button>
        </template>
        <span v-if="(tools.length > 0 || reactions !== undefined) && (filing.length > 0 || menu)" aria-hidden="true" class="mx-0.5 h-4 w-px bg-line" />
        <button
            v-for="action in filing"
            :key="action.id"
            type="button"
            :class="[PRESS, action.danger === true ? 'hover:text-danger' : '']"
            :aria-label="action.label"
            :disabled="action.disabled"
            v-tooltip.top="action.hint ?? action.label"
            @click="action.run($event.currentTarget as HTMLElement)"
        >
            <Icon :name="action.icon" class="text-sm" />
        </button>
        <button
            v-if="menu"
            type="button"
            :class="PRESS"
            :aria-label="t(`ui.action.moreActions`)"
            aria-haspopup="menu"
            v-tooltip.top="t(`ui.action.moreActions`)"
            @click="emit(`menu`, $event)"
        >
            <Icon name="ellipsis" class="text-sm" />
        </button>
    </div>
</template>
