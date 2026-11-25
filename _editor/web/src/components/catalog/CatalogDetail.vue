<script setup lang="ts">
import { BrandMark, ui } from "@intentic/ui";

// One catalog entry, opened where the list it was picked from stood: a capability's tile, an installed extension, a
// published listing. Every one reads the same way. First the way back, named after the list it leaves. Then the entry's
// mark, name and state as the heading, with any verb that acts on the whole entry at its end. Then the entry's own
// content. Above @3xl a docked column sits beside that content and holds what a reader checks while deciding. Below
// that width the caller draws the same content inline, at the point in the sequence where it should be read, because a
// column that falls under the actions would be read after the decision.

const { idle = false } = defineProps<{
    /** The list this came from ("Installed", "Browse", a capability slice). */
    back: string;
    name: string;
    /** Drawn before the name in a quieter tone, as the list drew it. */
    prefix?: string | undefined;
    description?: string | undefined;
    logo?: string | undefined;
    icon?: string | undefined;
    art?: string | undefined;
    idle?: boolean;
}>();

const emit = defineEmits<{ back: [] }>();
</script>

<template>
    <div class="@container">
        <div class="mx-auto flex max-w-xl flex-col @3xl:max-w-none @3xl:flex-row @3xl:items-start @3xl:justify-center @3xl:gap-6">
            <!-- Capped below the reading measure: this column holds fields and short facts, not prose. -->
            <div class="flex min-w-0 flex-1 flex-col @3xl:max-w-lg">
                <button type="button" :class="ui.textButton({ tone: `quiet` }, `mb-4 self-start`)" @click="emit(`back`)">
                    <Icon name="arrow-left" class="text-2xs" /> {{ back }}
                </button>

                <!-- Whatever frames this visit before the heading: a guided walk's strip, for one. -->
                <slot name="lead" />

                <div class="mb-4 flex items-center gap-3">
                    <BrandMark :size="32" :name="name" :art="art" :logo="logo" :icon="icon" :idle="idle" />
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="min-w-0 break-words font-medium" :class="idle ? `text-muted` : `text-content`"
                                ><span v-if="prefix" class="font-normal text-subtle">{{ prefix }}.</span>{{ name }}</span
                            >
                            <!-- The entry's state, which describes the whole page rather than one part of it. -->
                            <slot name="badge" />
                        </div>
                        <div v-if="description || $slots[`description`]" class="text-xs text-muted">
                            <slot name="description">{{ description }}</slot>
                        </div>
                    </div>
                    <slot name="actions" />
                </div>

                <slot />
            </div>

            <aside v-if="$slots[`aside`]" class="hidden @3xl:block @3xl:w-80 @3xl:shrink-0 @4xl:w-96">
                <slot name="aside" />
            </aside>
        </div>
    </div>
</template>
