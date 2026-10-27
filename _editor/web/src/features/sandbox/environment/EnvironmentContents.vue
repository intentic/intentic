<script setup lang="ts">
import { dataOf, type Loaded } from "@intentic/extension-api";
import type { EnvironmentItem } from "@intentic/sandbox-contract/schemas/environment";
import { AnchoredOverlay, Await, BrandMark, Button, Notice, ResponsiveOverlay, Section, ui, useHoverIntent } from "@intentic/ui";
import { computed, nextTick, ref, watch } from "vue";
import type { ContentsGroup } from "./useEnvironmentContents";
import { environmentVisual } from "./environmentVisual";
import { leadVersion, stateOf } from "./environmentItem";
import EnvironmentItemCard from "./EnvironmentItemCard.vue";
import { useT } from "@intentic/ui/i18n";

// What this sandbox has, not its build recipe (one pill away). The two decisions (added for this workspace, pulled in by
// a capability) are chips: mark, name, version and a glyph for a state other than live, so a dozen fit in the room three
// rows took. A resting pointer or keyboard focus peeks at one (why it is here, every tool's version, who added it); a
// press opens the whole of it, with what it installs and Remove. Several go at once through Select. The base staples
// are nobody's decision and nobody reads them, they only check for one: a plain list with nothing to press.

const t = useT();

const {
    loaded,
    removable = false,
    busy = false,
} = defineProps<{
    // The inventory, grouped by whose decision put each part there: a wait while the probe runs.
    loaded: Loaded<ContentsGroup[]>;
    // Whether the reader may take an agent-asked block out: the card's owner gate, not this list's.
    removable?: boolean;
    // A decision elsewhere on the card is on its way, so none is started here meanwhile.
    busy?: boolean;
}>();
// Asks the card to take blocks out; the card confirms them, by name, before anything is posted.
const emit = defineEmits<{ remove: [items: EnvironmentItem[]] }>();

const groups = computed(() => dataOf(loaded) ?? []);
const chipGroups = computed(() => groups.value.filter((group) => group.origin !== `base`));
const staples = computed(() => groups.value.find((group) => group.origin === `base`));
// Looked up by id, never held, so an open card follows a refetch that replaces the objects and closes once its block is gone.
const itemOf = (id: string | undefined): EnvironmentItem | undefined =>
    id === undefined ? undefined : chipGroups.value.flatMap((group) => group.items).find((item) => item.id === id);

// Only a block the sandbox names is the owner's to take out: a capability's cost goes with its capability, and a
// sandbox too old to remove one names none.
const canRemove = (item: EnvironmentItem): boolean => removable && item.block !== undefined;
const removableItems = computed(() => chipGroups.value.flatMap((group) => group.items).filter(canRemove));

// A chip and the element it is, which the card hangs off.
interface Target {
    readonly id: string;
    readonly el: HTMLElement;
}
const targetOf = (event: Event, item: EnvironmentItem): Target | undefined =>
    event.currentTarget instanceof HTMLElement ? { id: item.id, el: event.currentTarget } : undefined;

// ── SELECTING SEVERAL ────────────────────────────────────────────────────────────────────────────────────────────────
// Only once asked for, as the device list does: a tick box on every chip would be furniture on a list read far more
// often than it is pruned.
const selecting = ref(false);
const picked = ref(new Set<string>());
const pickedItems = computed(() => removableItems.value.filter((item) => picked.value.has(item.id)));
const togglePick = (item: EnvironmentItem): void => {
    const next = new Set(picked.value);
    if (!next.delete(item.id)) {
        next.add(item.id);
    }
    picked.value = next;
};
const stopSelecting = (): void => {
    selecting.value = false;
    picked.value = new Set();
};
// A removal that landed takes its chips away: the ticks go with them, and the mode once nothing ticked is left.
watch(
    () => removableItems.value.map((item) => item.id).join(`\n`),
    () => {
        const present = new Set(removableItems.value.map((item) => item.id));
        const kept = new Set([...picked.value].filter((id) => present.has(id)));
        const emptied = picked.value.size > 0 && kept.size === 0;
        picked.value = kept;
        if (emptied || present.size === 0) {
            selecting.value = false;
        }
    },
);

// ── OPENED ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const pinned = ref<Target>();
const pinnedItem = computed(() => itemOf(pinned.value?.id));
// Closing hands focus back to the chip; that focus is the card's own leaving, not a reader asking to peek.
let returning = false;
const pinnedOpen = computed({
    get: () => pinnedItem.value !== undefined,
    set: (open: boolean) => {
        if (!open) {
            returning = true;
            pinned.value = undefined;
            void nextTick(() => (returning = false));
        }
    },
});

// ── PEEKED AT ────────────────────────────────────────────────────────────────────────────────────────────────────────
// One clock for the whole list, so once one card is up the next chip along shows at once, as tooltips do.
const hover = useHoverIntent({ open: 300, close: 150, warm: 400 });
const peeked = ref<Target>();
const peekItem = computed(() => itemOf(peeked.value?.id));
// The opened card's item, not the target: one whose block went away under it must not silence every peek after it.
const quiet = (): boolean => selecting.value || pinnedItem.value !== undefined;
const peekOpen = computed({
    get: () => hover.shown.value && peekItem.value !== undefined && !quiet(),
    set: (open: boolean) => {
        if (!open) {
            hover.hide();
        }
    },
});
const onEnter = (event: PointerEvent, item: EnvironmentItem): void => {
    const target = targetOf(event, item);
    if (target === undefined || event.pointerType !== `mouse` || quiet()) {
        return;
    }
    hover.enter(() => (peeked.value = target));
};
const onLeave = (): void => hover.leave();
// The keyboard's way to the same peek; a press's own focus is the press's, which opens the whole card instead.
const onFocus = (event: FocusEvent, item: EnvironmentItem): void => {
    const target = targetOf(event, item);
    if (target === undefined || quiet() || returning || !target.el.matches(`:focus-visible`)) {
        return;
    }
    hover.show(() => (peeked.value = target));
};

const press = (event: MouseEvent, item: EnvironmentItem): void => {
    if (selecting.value) {
        togglePick(item);
        return;
    }
    hover.hide();
    pinned.value = pinned.value?.id === item.id ? undefined : targetOf(event, item);
};
const removeOne = (item: EnvironmentItem): void => {
    pinnedOpen.value = false;
    emit(`remove`, [item]);
};
</script>

<template>
    <!-- Section spacing matches the hub pages, including the outline while the inventory loads. -->
    <div class="flex flex-col gap-6">
        <!-- Loading draws the sections as they last looked in this sandbox; until then, chip shapes and a plain line, so it
             reads as the same two kinds of list at a glance. -->
        <Await :of="loaded" imprint="sandbox.environment.contents" :label="t(`sandbox.environmentContents.checkingInstalledVersions`)">
            <template #fallback>
                <div class="flex flex-col gap-6" role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.environmentContents.checkingInstalledVersions`) }}</span>
                    <!-- Two sections, not three: a sandbox may have no capability group, and an extra one would over-promise height. -->
                    <Section v-for="(chips, index) in [[`w-40`, `w-32`, `w-36`], [`w-28`, `w-32`]]" :key="index">
                        <template #label><span class="skeleton block h-2.5" :class="index === 0 ? `w-44` : `w-36`" aria-hidden="true" /></template>
                        <div class="flex flex-wrap gap-2" aria-hidden="true">
                            <span v-for="(width, chip) in chips" :key="chip" class="skeleton block h-8 rounded-full" :class="width" />
                        </div>
                    </Section>
                    <Section>
                        <template #label><span class="skeleton block h-2.5 w-28" aria-hidden="true" /></template>
                        <div class="flex flex-wrap gap-x-4 gap-y-2" aria-hidden="true">
                            <span v-for="(width, index) in [`w-20`, `w-16`, `w-14`, `w-20`, `w-16`, `w-12`]" :key="index" class="skeleton block h-4" :class="width" />
                        </div>
                    </Section>
                </div>
            </template>
            <template #failed="{ error }">
                <Notice :of="{ tone: `warning`, title: t(`sandbox.environmentContents.couldNotRead`), detail: error }" />
            </template>
            <template #default="{ refreshError }">
                <!-- Spaced as the column it sits in; only drawn with something in it, or an empty box would add a gap of its own. -->
                <div v-if="groups.length > 0" class="flex flex-col gap-6">
                    <Section v-for="group in chipGroups" :key="group.origin" :label="group.label" @keydown.escape="selecting && stopSelecting()">
                        <!-- Taking several out at once, in the group that has blocks to take out, once there are two of them. -->
                        <template v-if="group.origin === `custom` && removableItems.length > 1" #actions>
                            <!-- The count rides the verb rather than a line of its own, so the header keeps to the one line
                                 Select had and the chips under it do not jump. -->
                            <div v-if="selecting" class="flex flex-wrap items-center justify-end gap-1">
                                <Button
                                    size="small"
                                    tier="quiet"
                                    tone="danger"
                                    :label="
                                        pickedItems.length > 0
                                            ? t(`sandbox.environmentContents.removeCount`, { count: pickedItems.length })
                                            : t(`sandbox.environmentCard.remove`)
                                    "
                                    :disabled="busy || pickedItems.length === 0"
                                    @click="emit(`remove`, pickedItems)"
                                >
                                    <template #icon><Icon name="trash" /></template>
                                </Button>
                                <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="stopSelecting" />
                            </div>
                            <Button
                                v-else
                                size="small"
                                tier="quiet"
                                :label="t(`sandbox.environmentContents.select`)"
                                :disabled="busy"
                                @click="selecting = true"
                            >
                                <template #icon><Icon name="check-square" /></template>
                            </Button>
                        </template>

                        <div class="flex flex-wrap gap-2">
                            <!-- While selecting, a chip is a tick box; one that cannot go is drawn off, which is also why. -->
                            <button
                                v-for="item in group.items"
                                :key="item.id"
                                type="button"
                                :class="ui.chip({ size: `lg`, lead: true, on: selecting ? picked.has(item.id) : pinned?.id === item.id }, `max-w-full`)"
                                :disabled="selecting && !canRemove(item)"
                                :role="selecting ? `checkbox` : undefined"
                                :aria-checked="selecting ? picked.has(item.id) : undefined"
                                :aria-haspopup="selecting ? undefined : `dialog`"
                                :aria-expanded="selecting ? undefined : pinned?.id === item.id"
                                :data-environment-chip="item.id"
                                @click="press($event, item)"
                                @pointerenter="onEnter($event, item)"
                                @pointerleave="onLeave"
                                @focus="onFocus($event, item)"
                                @blur="hover.hide()"
                            >
                                <Icon v-if="selecting && canRemove(item)" :name="picked.has(item.id) ? `check-square` : `square`" class="text-sm" />
                                <!-- Idle marks a block the recipe has but the container does not yet, readable even without colour. -->
                                <BrandMark
                                    plain
                                    :size="18"
                                    :name="item.name"
                                    :logo="environmentVisual(item).logo"
                                    :icon="environmentVisual(item).icon"
                                    :idle="item.state !== `active`"
                                />
                                <!-- The name keeps the chip's own off ink while it cannot be ticked, or the chip would read as pressable. -->
                                <span class="min-w-0 truncate font-medium" :class="selecting && !canRemove(item) ? `` : `text-content`">{{ item.name }}</span>
                                <span v-if="leadVersion(item) !== undefined" class="font-mono text-2xs tabular-nums text-subtle">{{ leadVersion(item) }}</span>
                                <template v-if="stateOf(item) !== undefined">
                                    <Icon :name="stateOf(item)!.icon" :class="stateOf(item)!.tone" />
                                    <span class="sr-only">{{ t(`sandbox.environmentContents.${stateOf(item)!.words}`) }}</span>
                                </template>
                            </button>
                        </div>
                    </Section>

                    <!-- Nobody's decision, nothing to do with it: names and versions to scan, not to press. -->
                    <Section v-if="staples !== undefined" :label="staples.label">
                        <ul class="flex flex-wrap gap-x-4 gap-y-2" data-environment-staples>
                            <li v-for="item in staples.items" :key="item.id" class="inline-flex items-center gap-1.5 text-xs">
                                <BrandMark plain :size="16" :name="item.name" :logo="environmentVisual(item).logo" :icon="environmentVisual(item).icon" />
                                <span class="text-content">{{ item.name }}</span>
                                <span v-if="leadVersion(item) !== undefined" class="font-mono text-2xs tabular-nums text-subtle">{{ leadVersion(item) }}</span>
                            </li>
                        </ul>
                    </Section>
                </div>

                <Notice
                    v-if="refreshError !== undefined"
                    :of="{ tone: `warning`, title: t(`sandbox.environmentContents.couldNotRead`), detail: refreshError }"
                />
                <div v-else-if="groups.length === 0" :class="ui.emptyState(`py-8`)">
                    {{ t(`sandbox.environmentContents.nothingAddedOnTop`) }}
                </div>
            </template>
        </Await>

        <!-- The peek: what a resting pointer asks, said without a press, and gone when it moves on. -->
        <AnchoredOverlay v-model="peekOpen" :anchor="peeked?.el" side="top" cross="start" :restore-focus="false">
            <div v-if="peekItem" class="w-80 max-w-[calc(100vw-2rem)]" @pointerenter="hover.cancel()" @pointerleave="onLeave">
                <EnvironmentItemCard :item="peekItem" />
            </div>
        </AnchoredOverlay>

        <!-- Pressed open: a panel off the chip on a desktop, a sheet on a phone. No sheet title: the card opens on the
             block's own mark and name, which a title would only say twice. -->
        <ResponsiveOverlay
            v-model="pinnedOpen"
            :anchor="pinned?.el"
            side="bottom"
            cross="start"
            panel-class="w-[26rem] max-w-[calc(100vw-2rem)]"
        >
            <EnvironmentItemCard
                v-if="pinnedItem"
                :key="pinnedItem.id"
                :item="pinnedItem"
                full
                :removable="canRemove(pinnedItem)"
                :operable="removable"
                :busy="busy"
                @remove="removeOne(pinnedItem)"
            />
        </ResponsiveOverlay>
    </div>
</template>
