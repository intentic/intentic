<!-- A phone's menu of presses in a <BottomSheet>, the touch twin of <ContextMenu>: a thumb-high row each, its icon, words and note. -->
<script setup lang="ts">
import BottomSheet from "../layout/BottomSheet.vue";
import Icon from "../primitives/Icon.vue";
import type { ActionItem } from "./actionItem.js";

const { actions, from } = defineProps<{
    actions: readonly ActionItem[];
    header?: string;
    /** The element that opened the sheet, handed to the chosen press in place of the sheet's own row, which is gone by then. */
    from?: HTMLElement | undefined;
}>();

const open = defineModel<boolean>({ required: true });

// THE PRESS RUNS ONCE THE SHEET HAS GONE, not as it starts to close. Closing spends the history entry the sheet held
// (useBackDismiss), and a press that opens a sheet of its own (a picker, a confirm) would otherwise claim its entry
// before that back had landed and be closed by it the moment it opened.
let chosen: ActionItem | undefined;
const choose = (action: ActionItem): void => {
    chosen = action;
    open.value = false;
};
const afterHide = (): void => {
    const action = chosen;
    chosen = undefined;
    if (action !== undefined && from !== undefined) {
        action.run(from);
    }
};
</script>

<template>
    <BottomSheet v-model="open" :header="header" @after-hide="afterHide">
        <!-- The stop is on this element: the sheet is drawn inside whatever opened it, and a tap here must not also press that (a card opens its agent). -->
        <div class="flex flex-col gap-0.5" role="menu" @click.stop>
            <button
                v-for="action in actions"
                :key="action.id"
                type="button"
                role="menuitem"
                :disabled="action.disabled"
                class="flex min-h-12 items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors active:bg-overlay disabled:opacity-40"
                :class="action.danger === true ? `text-danger` : `text-content`"
                @click="choose(action)"
            >
                <Icon :name="action.icon" class="w-5 shrink-0 text-base" :class="action.danger === true ? `` : `text-muted`" />
                <span class="min-w-0 flex-1">
                    <span class="block">{{ action.label }}</span>
                    <span v-if="action.note !== undefined" class="mt-0.5 block text-xs text-muted">{{ action.note }}</span>
                </span>
            </button>
        </div>
    </BottomSheet>
</template>
