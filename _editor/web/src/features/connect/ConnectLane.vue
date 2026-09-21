<script setup lang="ts">
import { Icon, type IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// One way in, as a card that opens in place. Closed it is a headline and a price; open it is the whole of that choice.
// Only one lane is open at a time, and the others stay on screen as one-line rows: a reader who picked the wrong door
// must be able to see the others without going back anywhere.

const t = useT();

const { title, subtitle, icon, open, done } = defineProps<{
    title: string;
    subtitle: string;
    icon: IconName;
    open: boolean;
    // Something in this lane can already run a turn. The lane stays offerable (a second account, a bigger model); it
    // just stops being the thing to do next.
    done: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
    <!-- No padding of its own: the header carries it, so its hover wash reaches every edge instead of drawing a
         rectangle inset by the card's own gutter. -->
    <section class="ui-card overflow-hidden p-0" :class="open ? `border-primary-500/40` : ``">
        <!-- The header is the control whether the lane is open or shut, so a reader never has to find a second target. -->
        <button
            type="button"
            class="ui-row-select flex w-full items-center gap-3 p-5 text-left"
            :aria-expanded="open"
            @click="emit(`toggle`)"
        >
            <span
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                :class="done ? `border-success/40 bg-success/10 text-success` : `border-line bg-canvas text-muted`"
            >
                <Icon :name="done ? `check` : icon" class="text-base" />
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate font-medium leading-tight">{{ title }}</span>
                <span class="truncate text-xs text-muted">{{ subtitle }}</span>
            </span>
            <slot name="badge" />
            <Icon
                :name="open ? `chevron-up` : `chevron-down`"
                class="shrink-0 text-2xs text-subtle"
                :aria-label="open ? t(`connect.connectLane.collapse`) : t(`connect.connectLane.expand`)"
            />
        </button>
        <div v-if="open" class="border-t border-line px-5 pb-5 pt-4">
            <slot />
        </div>
    </section>
</template>
