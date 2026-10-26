<!-- The getting-started checklist's door on the desktop rail: a ring that fills one arc per settled step, opening the
     list beside it. On every route, so the next step is one press away from wherever a first run wandered to. Closed
     unless pressed: the beacons do the pointing, and a list that opened by itself would sit on whatever they point at.
     It also carries what the sandbox needs from its owner and what is worth knowing (SandboxErrands.vue), with the
     badge for it on its corner, so the tile outlives the checklist while any of that is left. -->
<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import { AnchoredOverlay, SegmentRing } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useSandbox } from "../../client/sandbox/useSandbox";
import RemoveSandboxDialog from "../sandbox/gates/removal/RemoveSandboxDialog.vue";
import ViewBadgeChip from "../../workbench/views/ViewBadgeChip.vue";
import GettingStartedList from "./GettingStartedList.vue";
import SandboxErrands from "./SandboxErrands.vue";
import { useGettingStarted } from "./useGettingStarted";
import { useSandboxErrands } from "./useSandboxErrands";
import { HOME_PATH } from "../../lib/routes/firstScreens";

const t = useT();
const tour = useGettingStarted();
const errands = useSandboxErrands();

const trigger = ref<HTMLButtonElement>();
const open = ref(false);

const shown = computed(() => tour.visible.value || errands.any.value);

// The checklist's count while it is up, else the errands' own heading; the badge's sentence joins either, since a
// tooltip on the badge would nest inside this one.
const label = computed(() =>
    [
        tour.visible.value
            ? t(`gettingStarted.ring.label`, { settled: tour.progress.value.settled, total: tour.progress.value.total })
            : errands.needs.value.length > 0 || errands.unfinished.value.length > 0
              ? t(`shared.needs`)
              : t(`shared.worthKnowing`),
        errands.badge.value?.tooltip,
    ]
        .filter((part) => part !== undefined)
        .join(` · `),
);

// AN UNFINISHED SETUP BEING REMOVED (SandboxErrands' trash). Held here, outside the panel, because the panel closes as
// the question is asked. It is the reader's own row (unfinishedSandboxes keeps owners only), so removing it is a plain
// drop with no member list to leave first; with nothing left on the account, Home's first run is where the reader goes next.
const router = useRouter();
const sandbox = useSandbox();
const removing = ref<SandboxSummary | undefined>(undefined);
const askRemove = (option: SandboxSummary): void => {
    open.value = false;
    removing.value = option;
};
const removeRow = async (target: SandboxSummary): Promise<void> => {
    await sandbox.remove(target.id);
    if (sandbox.sandboxes.value.length === 0) {
        void router.push(HOME_PATH);
    }
};

// The one time the list opens unasked: the last step just settled here, which is worth saying while it is fresh.
watch(
    () => tour.finished.value,
    (finished) => {
        if (finished) {
            open.value = true;
        }
    },
);

// Nothing left to draw closes the panel rather than leaving an empty card where the tile was.
watch(shown, (now) => {
    if (!now) {
        open.value = false;
    }
});
</script>

<template>
    <template v-if="shown">
        <button
            ref="trigger"
            type="button"
            class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg"
            :class="[{ 'ui-row-select-on': open }, tour.visible.value ? 'text-accent' : 'text-muted hover:text-content']"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :aria-label="label"
            v-tooltip.right="open ? undefined : label"
            data-tour="ring"
            @click="open = !open"
        >
            <!-- The glyph says what the ring counts: a bare ring of empty arcs reads as something loading. Once the
                 checklist is put away the glyph stands alone, the tile then being only the errands' door. -->
            <span class="relative flex size-7 items-center justify-center">
                <SegmentRing
                    v-if="tour.visible.value"
                    :segments="tour.progress.value.total"
                    :filled="tour.progress.value.settled"
                    :size="28"
                    :stroke="2.5"
                    class="absolute inset-0"
                />
                <Icon name="list-check" :class="tour.visible.value ? 'text-xs' : 'icon-rail-glyph'" />
            </span>
            <!-- The same corner and scale as every badge on the rail. aria-hidden: its sentence is in the label. -->
            <ViewBadgeChip :badge="errands.badge.value" class="icon-rail-mark pointer-events-none absolute right-0.5 top-0.5" aria-hidden="true" />
        </button>
        <AnchoredOverlay v-model="open" :anchor="trigger" side="right" cross="end">
            <div class="flex max-h-[calc(100vh-2rem)] max-w-full flex-col overflow-y-auto overscroll-contain">
                <!-- The errands sit inside the checklist's card, above its footer, so the panel is one list. -->
                <GettingStartedList v-if="tour.visible.value" @done="open = false">
                    <SandboxErrands v-if="errands.any.value" class="border-t border-line-subtle pt-1" @done="open = false" @remove="askRemove" />
                </GettingStartedList>
                <SandboxErrands v-else class="w-80 max-w-full p-1" @done="open = false" @remove="askRemove" />
            </div>
        </AnchoredOverlay>
    </template>
    <RemoveSandboxDialog :target="removing" :remove-row="removeRow" @close="removing = undefined" @reopen="(row) => (removing = row)" />
</template>
