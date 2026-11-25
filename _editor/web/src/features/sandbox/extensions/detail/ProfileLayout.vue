<script setup lang="ts">
import { BrandMark, Card, type IconName, toneInk, ui } from "@intentic/ui";

// One extension's page, installed or listed, opened where the list it was picked from stood. It reads as a profile: the
// way back, then one card that says who it is and answers the questions a reader opens it with at a glance (is it
// working, what may it reach, is it safe, which build), each figure a press that lands on the card holding the rest.
// What is wrong or waiting runs the full width under it. Below, two columns: what the reader changes on one side, what it
// is on the other, stacked on a narrow pane with whichever the caller says leads.

export interface ProfileStat {
    /** Its key, and the id of the card a press lands on when `target` is set. */
    readonly id: string;
    readonly icon?: IconName | undefined;
    readonly value: string;
    readonly label: string;
    readonly tone?: `success` | `warning` | `danger` | `info` | undefined;
    /** The label is an identifier (a commit), drawn in the code face. */
    readonly mono?: boolean | undefined;
    /** Passed out of total, drawn as a row of segments beside the value. */
    readonly meter?: { readonly passed: number; readonly total: number } | undefined;
    /** The id of the element a press brings into view. */
    readonly target?: string | undefined;
}

const {
    stats = [],
    idle = false,
    asideLeads = false,
} = defineProps<{
    /** The list this came from ("Installed", "Browse"). */
    back: string;
    name: string;
    /** Drawn before the name in a quieter tone, as the list drew it. */
    prefix?: string | undefined;
    description?: string | undefined;
    logo?: string | undefined;
    icon?: string | undefined;
    art?: string | undefined;
    idle?: boolean;
    stats?: readonly ProfileStat[];
    /** On a narrow pane, the side column comes before the main one. */
    asideLeads?: boolean;
}>();

const emit = defineEmits<{ back: [] }>();

const reveal = (target: string | undefined): void => {
    if (target !== undefined) {
        document.getElementById(target)?.scrollIntoView({ block: `start` });
    }
};
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <div>
            <button type="button" :class="ui.textButton({ tone: `quiet` }, `mb-3 self-start`)" @click="emit(`back`)">
                <Icon name="arrow-left" class="text-2xs" /> {{ back }}
            </button>

            <Card class="overflow-hidden p-0">
                <div class="flex flex-wrap items-start gap-x-3.5 gap-y-3 p-4">
                    <BrandMark :size="44" :name="name" :art="art" :logo="logo" :icon="icon" :idle="idle" />
                    <div class="min-w-0 flex-1 basis-56">
                        <div class="flex flex-wrap items-center gap-2">
                            <h2 class="min-w-0 break-words text-base font-medium" :class="idle ? `text-muted` : `text-content`">
                                <span v-if="prefix" class="font-normal text-subtle">{{ prefix }}.</span>{{ name }}
                            </h2>
                            <!-- The entry's state, which describes the whole page rather than one part of it. -->
                            <slot name="badge" />
                        </div>
                        <p v-if="description" class="mt-0.5 max-w-prose text-sm leading-relaxed text-muted">{{ description }}</p>
                    </div>
                    <!-- The verb for the whole entry: its switch, or the install. -->
                    <div v-if="$slots[`actions`]" class="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <slot name="actions" />
                    </div>
                </div>

                <!-- Whatever the verb above waits on (a yes to an unaudited install, the install's own progress). -->
                <div v-if="$slots[`hero`]" class="px-4 pb-4"><slot name="hero" /></div>

                <!-- Every cell draws its own top and left hairline and the row is pulled a pixel left, so the card clips
                     the left one at the start of each line however the cells wrap. -->
                <div v-if="stats.length > 0" class="-ml-px flex flex-wrap">
                    <component
                        :is="stat.target === undefined ? `div` : `button`"
                        v-for="stat in stats"
                        :key="stat.id"
                        :type="stat.target === undefined ? undefined : `button`"
                        class="flex min-w-28 flex-1 flex-col gap-0.5 border-l border-t border-line px-4 py-2.5 text-left"
                        :class="stat.target === undefined ? `` : `transition-colors hover:bg-content/5`"
                        @click="reveal(stat.target)"
                    >
                        <span
                            class="flex items-center gap-1.5 text-sm font-medium"
                            :class="stat.tone === undefined ? `text-content` : toneInk(stat.tone)"
                        >
                            <Icon v-if="stat.icon" :name="stat.icon" class="shrink-0" />
                            <span class="truncate">{{ stat.value }}</span>
                            <span v-if="stat.meter" class="ml-0.5 flex gap-0.5" aria-hidden="true">
                                <span
                                    v-for="segment in stat.meter.total"
                                    :key="segment"
                                    class="h-1.5 w-2 rounded-sm"
                                    :class="segment <= stat.meter.passed ? `bg-success` : `bg-warning`"
                                />
                            </span>
                        </span>
                        <span class="truncate text-2xs text-subtle" :class="stat.mono ? `font-mono` : ``">{{ stat.label }}</span>
                    </component>
                </div>
            </Card>
        </div>

        <!-- Each line here is the whole page's business, so it spans both columns. Empty when nothing is wrong. -->
        <div v-if="$slots[`alerts`]" class="flex flex-col gap-2.5 empty:hidden"><slot name="alerts" /></div>

        <div class="flex flex-col gap-6 @3xl:flex-row @3xl:items-start">
            <div class="flex min-w-0 flex-col gap-6 @3xl:flex-1"><slot /></div>
            <aside
                v-if="$slots[`aside`]"
                class="flex min-w-0 flex-col gap-6 @3xl:order-last @3xl:w-1/3 @3xl:shrink-0"
                :class="asideLeads ? `order-first` : ``"
            >
                <slot name="aside" />
            </aside>
        </div>
    </div>
</template>
