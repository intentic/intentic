<!-- WHERE A NEW SANDBOX RUNS, as one list of rows (AddSandboxWay.vue), each saying what the place is: the form's "Runs on"
     (AddSandboxForm.vue) and the desktop app's page (local/newSandbox/LocalNewSandbox.vue). `more` is "More ways", listed
     under its own quiet heading in the same list, so the pick is one choice whichever row it lands on; while it is folded
     the `#fold` slot stands in its place. One tab stop, the pick; the arrows move it along every row shown. Two to a line
     wherever the list is wide enough (the dialog is `md` for it), so opening "More ways" or picking an address grows the
     dialog by a line rather than past the screen into a scroll; one to a line on a phone's sheet. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import AddSandboxWay from "./AddSandboxWay.vue";
import type { AddOption } from "./useAddSandbox";

const { options, more = undefined } = defineProps<{
    options: readonly AddOption[];
    /** "More ways", shown under the one-press rows; undefined while folded. */
    more?: readonly AddOption[] | undefined;
    /** The id of the label naming the list. */
    labelledBy: string;
}>();
const pick = defineModel<string | undefined>({ required: true });

const t = useT();
const shown = computed(() => [...options, ...(more ?? [])]);
const group = ref<HTMLElement>();
const STEPS = new Map([
    [`ArrowDown`, 1],
    [`ArrowRight`, 1],
    [`ArrowUp`, -1],
    [`ArrowLeft`, -1],
]);
const step = (event: KeyboardEvent): void => {
    const by = STEPS.get(event.key);
    const rows = shown.value;
    if (by === undefined || rows.length === 0) {
        return;
    }
    event.preventDefault();
    const at = rows.findIndex((option) => option.value === pick.value);
    const next = (at + by + rows.length) % rows.length;
    pick.value = rows[next]?.value;
    group.value?.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)[next]?.focus();
};
</script>

<template>
    <!-- Out to the dialog's edge by the rows' own padding, so their marks line up with the label above. The container is
         the list's own width, not the window's: a phone's sheet and the desktop app's page are as narrow as they are. -->
    <div class="@container">
        <div ref="group" role="radiogroup" :aria-labelledby="labelledBy" class="-mx-2.5 grid grid-cols-1 gap-0.5 @lg:grid-cols-2 @lg:gap-x-1" @keydown="step">
            <AddSandboxWay v-for="option in options" :key="option.value" :option="option" :on="pick === option.value" @pick="pick = option.value" />
            <template v-if="more !== undefined">
                <span v-if="options.length > 0" class="col-span-full px-2.5 pt-2 pb-0.5 text-xs text-muted">{{ t(`setup.addSandbox.moreWays`) }}</span>
                <AddSandboxWay v-for="option in more" :key="option.value" :option="option" :on="pick === option.value" @pick="pick = option.value" />
            </template>
            <div v-else class="col-span-full flex"><slot name="fold" /></div>
        </div>
    </div>
</template>
