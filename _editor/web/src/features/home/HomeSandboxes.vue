<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { SandboxLogo, ui } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { orderedSandboxes, tileAction } from "../../models/home/homeFacts";
import { useHomeAttention } from "../../models/home/useHomeAttention";
import ViewBadgeChip from "../../workbench/views/ViewBadgeChip.vue";
import type { ViewBadge } from "@intentic/extension-api";

const { phone = false } = defineProps<{ phone?: boolean }>();
const t = useT();
const router = useRouter();
const sandbox = useSandbox();
const boxes = computed(() => orderedSandboxes(sandbox.sandboxes.value));
const readings = useHomeAttention();
const badgeOf = (id: string): ViewBadge | undefined => {
    const count = readings.value.get(id)?.needsYou ?? 0;
    return count > 0 ? { count, tooltip: t(`home.sandboxAttention`, { name: boxes.value.find((box) => box.id === id)?.name ?? ``, count }) } : undefined;
};
// The tile of the sandbox whose chat the page shows; on a page of the person's own (settings), none is.
const route = useRoute();
const selected = (id: string): boolean => route.name === `home` && sandbox.activeSandboxId.value === id;
const labelOf = (id: string, name: string): string => t(`home.sandboxAttention`, { name, count: readings.value.get(id)?.needsYou ?? `—` });
let last: { id: string; at: number } | undefined;
const choose = (id: string, input: `click` | `enter`): void => {
    const now = Date.now();
    const action = tileAction(input, last?.id === id, last === undefined ? Infinity : now - last.at);
    last = { id, at: now };
    sandbox.select(id);
    if (action === `enter`) {
        void router.push(`/`);
    } else if (phone) {
        void router.push(`/home/${encodeURIComponent(id)}`);
    } else {
        void router.replace(`/home`);
    }
};
</script>

<template>
    <!-- On a phone, the master view IS this list: a page of its own. -->
    <nav v-if="phone" :aria-label="t(`home.sandboxes`)" class="flex h-full flex-col gap-3 overflow-y-auto bg-card p-3">
        <h1 class="px-2 py-3 text-lg font-semibold">{{ t(`home.title`) }}</h1>
        <button
            v-for="box in boxes"
            :key="box.id"
            type="button"
            class="relative flex w-full shrink-0 items-center gap-3 rounded-xl p-2 text-left hover:bg-content/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-link"
            :class="{ 'opacity-40': readings.get(box.id)?.unreachable, 'ring-2 ring-link': selected(box.id) }"
            :aria-label="labelOf(box.id, box.name)"
            :aria-current="selected(box.id) ? 'true' : undefined"
            @click="choose(box.id, 'click')"
            @keydown.enter.prevent="choose(box.id, 'enter')"
        >
            <SandboxLogo :size="36" :image="box.image ?? null" :name="box.name" />
            <span class="min-w-0 flex-1 truncate">{{ box.name }}</span>
            <ViewBadgeChip :badge="badgeOf(box.id)" class="text-[0.625rem]" />
        </button>
        <RouterLink to="/setup" class="flex min-h-11 items-center justify-center rounded-xl px-3 text-muted hover:bg-content/5" :aria-label="t(`sandbox.words.addSandbox`)">
            <Icon name="plus" aria-hidden="true" />
        </RouterLink>
    </nav>
    <!-- On a desktop, the tiles of the shell's own rail (ShellDesktop.vue draws the rail around them, account included),
         worn like every other tile: the same size, selection and corner chip. Only what needs you is counted; a quiet box
         wears nothing, and one that has not answered is dimmed rather than counted. -->
    <div v-else :aria-label="t(`home.sandboxes`)" role="group" class="icon-rail-nav scrollbar-none flex flex-col items-center overflow-y-auto overscroll-contain">
        <button
            v-for="box in boxes"
            :key="box.id"
            type="button"
            class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg"
            :class="{ 'opacity-40': readings.get(box.id)?.unreachable, 'ui-row-select-on': selected(box.id) }"
            :aria-label="labelOf(box.id, box.name)"
            :aria-current="selected(box.id) ? 'true' : undefined"
            v-tooltip.right="{ title: box.name, note: t(`home.doubleClickToEnter`) }"
            @click="choose(box.id, 'click')"
            @keydown.enter.prevent="choose(box.id, 'enter')"
        >
            <SandboxLogo :size="28" :image="box.image ?? null" :name="box.name" />
            <ViewBadgeChip :badge="badgeOf(box.id)" class="icon-rail-mark absolute right-0.5 top-0.5" />
        </button>
        <RouterLink
            to="/setup"
            :class="ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`)"
            :aria-label="t(`sandbox.words.addSandbox`)"
            v-tooltip.right="t(`sandbox.words.addSandbox`)"
        >
            <Icon name="plus" class="icon-rail-glyph" aria-hidden="true" />
        </RouterLink>
    </div>
</template>
