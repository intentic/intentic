<!-- Everything the Browsers view can open, in one list: a web tab first, then the live apps the workspace serves, then
     the sandbox's desktop and each window on it. The + opens it as a menu; a view with nothing open shows it under the
     search box as its start page, the way a new browser tab offers the places one goes. What is already on the strip
     reads as open, and picking it brings it to front rather than opening it twice. -->
<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

export interface LaunchItem {
    // The tab key it opens (browsersPaths.ts), or `web` for a new web tab.
    readonly key: string;
    readonly label: string;
    readonly detail?: string | undefined;
    readonly icon: IconName;
    readonly tint?: string | undefined;
    // Already on the strip: picking it brings it to front.
    readonly open?: boolean;
}

export interface LaunchGroup {
    readonly label: string;
    readonly items: readonly LaunchItem[];
    // Said in the group's place when it has nothing to offer, so an empty group explains itself.
    readonly empty?: string | undefined;
}

const { groups, variant } = defineProps<{ groups: readonly LaunchGroup[]; variant: `menu` | `page` }>();
const emit = defineEmits<{ pick: [key: string] }>();

const t = useT();

// The page leaves out what is empty (its search box is already the way to the web); the menu keeps every heading so
// the reader learns where things will appear.
const shown = computed(() => (variant === `page` ? groups.filter((group) => group.items.length > 0) : groups));
</script>

<template>
    <div v-if="variant === `menu`" class="flex w-72 flex-col gap-0.5 p-1" role="menu">
        <template v-for="(group, index) in shown" :key="group.label">
            <div v-if="index > 0" class="mx-2 my-0.5 h-px bg-line" />
            <div v-if="group.label !== ``" class="px-2 pb-0.5 pt-1 text-3xs font-medium uppercase tracking-wide text-subtle">{{ group.label }}</div>
            <button
                v-for="item in group.items"
                :key="item.key"
                type="button"
                role="menuitem"
                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                @click="emit(`pick`, item.key)"
            >
                <Icon :name="item.icon" class="shrink-0 text-2xs" :class="item.tint ?? `text-muted`" />
                <span class="min-w-0 flex-1">
                    <span class="block truncate">{{ item.label }}</span>
                    <span v-if="item.detail" class="block truncate text-3xs text-muted">{{ item.detail }}</span>
                </span>
                <span v-if="item.open" class="shrink-0 text-3xs text-subtle">{{ t(`browsers.launcher.open`) }}</span>
            </button>
            <p v-if="group.items.length === 0 && group.empty" class="px-2 py-1 text-2xs text-muted">{{ group.empty }}</p>
        </template>
    </div>

    <div v-else class="flex w-full flex-col gap-4">
        <section v-for="group in shown" :key="group.label" class="flex flex-col gap-1.5">
            <h3 class="px-1 text-3xs font-medium uppercase tracking-wide text-subtle">{{ group.label }}</h3>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
                <button
                    v-for="item in group.items"
                    :key="item.key"
                    type="button"
                    class="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2 text-left transition-colors hover:border-line-strong hover:bg-overlay"
                    @click="emit(`pick`, item.key)"
                >
                    <Icon :name="item.icon" class="shrink-0 text-sm" :class="item.tint ?? `text-muted`" />
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-xs text-content">{{ item.label }}</span>
                        <span v-if="item.detail" class="block truncate text-3xs text-muted">{{ item.detail }}</span>
                    </span>
                </button>
            </div>
        </section>
    </div>
</template>
