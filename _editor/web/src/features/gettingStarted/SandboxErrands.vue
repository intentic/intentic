<!-- WHAT IS LEFT TO DO, under the getting-started checklist on the rail's ring: what the sandbox in use needs from its
     owner, setups on this account that were never finished, and what is merely worth knowing. These used to hang under
     the sandbox switcher, where three headed sections turned a menu for picking a place into a to-do list; here they sit
     with the other errands of a first run, and the ring stays on the rail for them once the checklist is put away. -->
<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import { browserOwnsClick, SectionHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { nextTick } from "vue";
import { RouterLink, useRouter } from "vue-router";
import type { SandboxAttentionItem } from "../sandbox/overview/sandboxAttention";
import { useSandboxErrands } from "./useSandboxErrands";
import { finishOnHome } from "../../models/sandbox/finishOnHome";

const t = useT();
const router = useRouter();
const { needs, notes, unfinished } = useSandboxErrands();

// `remove` hands the question up: the dialog must outlive this panel, which closes as the question is asked.
const emit = defineEmits<{ done: []; remove: [option: SandboxSummary] }>();

const ROW_TONE = {
    info: `text-link`,
    warning: `text-warning`,
} satisfies Record<SandboxAttentionItem["tone"], string>;

// Every row is a real link, so Ctrl/⌘-click opens a tab instead of hijacking this one; a plain click closes the panel.
const dismiss = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        emit(`done`);
    }
};

// A row that points at a control rather than a page (`/sandbox#sandbox-update-action`, the update's own button) is an
// action: its link alone does nothing while that page is already open. So once the page is there, the control is
// scrolled to and focused. Ctrl/⌘-click still just opens the tab.
const followRow = async (event: MouseEvent, to: string): Promise<void> => {
    dismiss(event);
    const anchor = to.split(`#`)[1];
    if (anchor === undefined || browserOwnsClick(event)) {
        return;
    }
    await router.push(to);
    await nextTick();
    const target = document.getElementById(anchor);
    target?.scrollIntoView({ block: `center`, behavior: `smooth` });
    target?.querySelector<HTMLElement>(`button:not([disabled])`)?.focus({ preventScroll: true });
};

// Finishes that row's setup on Home, in its tile and page, rather than offering a blank create form.
const resumeSetup = (option: SandboxSummary) => finishOnHome(option.id);

</script>

<template>
    <div class="flex flex-col gap-0.5">
        <!-- What would bite if left: the badge on the ring is the head of this list. -->
        <template v-if="needs.length > 0 || unfinished.length > 0">
            <SectionHeader :label="t(`shared.needs`)" density="dense" class="px-2 py-1.5" />
            <RouterLink
                v-for="item in needs"
                :key="item.message"
                :to="item.to"
                data-menu-row
                class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center" :class="ROW_TONE[item.tone]">
                    <Icon :name="item.icon" class="text-xs" />
                </span>
                <span class="min-w-0 flex-1 text-content">{{ item.message }}</span>
                <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
            </RouterLink>
            <RouterLink
                v-for="option in unfinished"
                :key="option.id"
                :to="resumeSetup(option)"
                data-menu-row
                class="group flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                    <Icon name="wrench" class="text-xs" />
                </span>
                <span class="min-w-0 flex-1 truncate text-muted">{{ t(`sandbox.words.finishSettingUp`, { name: option.name }) }}</span>
                <!-- In flow, not overlaid, so hovering never shifts the text; `.prevent` stops the anchor firing too. -->
                <Icon
                    name="trash"
                    @click.prevent.stop="emit(`remove`, option)"
                    v-tooltip.top="t(`ui.action.remove`)"
                    class="shrink-0 text-xs opacity-0 transition hover:text-danger group-hover:opacity-60"
                />
                <!-- Last, after the verb, so it stays in the same column as every other row's chevron in this menu. -->
                <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
            </RouterLink>
        </template>

        <!-- Things simply true (a contended port, a newer image): quieter ink, since none of them is why the ring is flagged. -->
        <template v-if="notes.length > 0">
            <SectionHeader :label="t(`shared.worthKnowing`)" density="dense" class="px-2 py-1.5" />
            <RouterLink
                v-for="item in notes"
                :key="item.message"
                :to="item.to"
                data-menu-row
                class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                @click="(event: MouseEvent) => followRow(event, item.to)"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                    <Icon :name="item.icon" class="text-xs" />
                </span>
                <span class="min-w-0 flex-1 text-muted">{{ item.message }}</span>
                <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
            </RouterLink>
        </template>
    </div>
</template>
