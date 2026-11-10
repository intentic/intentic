<!-- ALL SANDBOXES, FOLDED: the reader's other sandboxes as overlapping circles under the switcher, two on top and one
     tucked below, the last a "+n" past three. One press unrolls them along the rail (MasterRail.vue): each circle flies
     out to its tile and the sections go into the bookmark (railMorph.ts, by the marks below), the page on screen staying
     where it is (sandboxScreen.ts `unrolledPath`). Not a Home tile (the owner turned one down twice): it says something
     a tile could not, which other sandboxes there are and which of them waits for the reader, the reason to unroll at
     all. For a reader with no other sandbox it is the add tile instead, so a first extra sandbox is always one press away
     (the unrolled rail ends in the same tile, HomeSandboxes.vue). -->
<script setup lang="ts">
import { SandboxLogo, type Tip, ui } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { identityHue } from "../../lib/identityHue";
import { clusterOf } from "../../models/home/otherSandboxes";
import { sandboxOrder } from "../../models/home/sandboxOrder";
import { useHomeAttention } from "../../models/home/useHomeAttention";
import { switchableSandboxes } from "../../models/sandbox/live/roster";
import { useRequestAddSandbox, warmAddSandbox } from "../../models/sandbox/addSandbox";
import { unrolledPath } from "../../models/sandbox/sandboxScreen";
import { commandShortcut } from "../../workbench/commands/useCommands";
import { badgeClass } from "../../workbench/views/viewBadge";

const t = useT();
const sandbox = useSandbox();
// Home's own count of what waits for the reader in each box, so the point here and the chip on Home's tile agree. At the
// across-sandboxes store's ambient pace, and never the box the shell is in: its own tiles count that one.
const readings = useHomeAttention({ everyMs: 45_000, skip: () => sandbox.activeSandboxId.value });
const cluster = computed(() =>
    clusterOf(switchableSandboxes(sandbox.sandboxes.value), sandbox.activeSandboxId.value, readings.value, sandboxOrder.value),
);

// Where each circle sits, in circle diameters (iconRail.css `--cluster-d`): a pair on top and one below between them, the
// Olympic rings' fold. Fewer circles keep the same box, centred in it, so the rail below never moves.
const PLACES = [
    [[0.39, 0.34]],
    [
        [0, 0.34],
        [0.78, 0.34],
    ],
    [
        [0, 0],
        [0.78, 0],
        [0.39, 0.68],
    ],
] as const;
const at = (index: number) => {
    const count = cluster.value.slots.length + (cluster.value.more > 0 ? 1 : 0);
    const [x, y] = PLACES[count - 1]?.[index] ?? [0, 0];
    return { left: `calc(var(--cluster-d) * ${x})`, top: `calc(var(--cluster-d) * ${y})` };
};

// A picture brings its own colour and sits on the card, since a logo is often line art on nothing. A monogram's own colour, from the same curated wheel a person's avatar is drawn from, mixed toward the theme's own card
// and ink so it reads in light and dark alike: three grey letters overlapping at this size would read as one smudge.
const tint = (id: string) => {
    const hue = `hsl(${identityHue(id)} 65% 50%)`;
    return {
        backgroundColor: `color-mix(in oklab, ${hue} 24%, var(--color-card))`,
        color: `color-mix(in oklab, ${hue} 55%, var(--color-content))`,
    };
};

// The page on screen, the rail unrolled around it.
const route = useRoute();
const home = computed(() => unrolledPath(route));

// The same add action everywhere: signed in opens the dialog here; signed out returns to it after sign-in.
const add = useRequestAddSandbox();

const needy = computed(() => cluster.value.slots.filter((slot) => slot.needsYou > 0));
const tip = computed<Tip>(() => ({
    title: t(`home.open`),
    keys: commandShortcut(`view.home`),
    rows: needy.value.map((slot) => ({ label: slot.name, value: slot.needsYou })),
    note: needy.value.length > 0 ? t(`home.otherSandboxes.waiting`) : t(`home.otherSandboxes.quiet`),
}));
const label = computed(() =>
    [
        t(`home.otherSandboxes.label`, { names: cluster.value.names.join(`, `) }),
        cluster.value.needing > 0 ? t(`home.otherSandboxes.needing`, { count: cluster.value.needing }) : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(`. `),
);
</script>

<template>
    <RouterLink
        v-if="cluster.slots.length > 0"
        :to="home"
        class="icon-rail-cluster ui-row-select ui-row-select-horizontal flex items-center justify-center rounded-lg"
        data-rail-holds="sandboxes"
        :aria-label="label"
        v-tooltip.right="tip"
    >
        <span class="icon-rail-cluster-box relative" aria-hidden="true">
            <span
                v-for="(slot, index) in cluster.slots"
                :key="slot.id"
                :data-rail-key="`sandbox:${slot.id}`"
                data-rail-into="sandboxes"
                class="icon-rail-cluster-circle absolute flex items-center justify-center rounded-full font-semibold"
                :class="{ 'opacity-40 grayscale': slot.unreachable, 'bg-card': slot.image }"
                :style="{ ...at(index), ...(slot.image ? {} : tint(slot.id)) }"
            >
                <SandboxLogo :image="slot.image" :name="slot.name" class="rounded-full [&_span]:text-inherit" />
                <!-- Which of them waits for the reader: a point on that circle, in the count chip's own plate, above the circles that
                     overlap it. -->
                <span v-if="slot.needsYou > 0" class="icon-rail-cluster-point absolute z-10 rounded-full" :class="badgeClass({ count: slot.needsYou })"></span>
            </span>
            <span
                v-if="cluster.more > 0"
                class="icon-rail-cluster-circle absolute flex items-center justify-center rounded-full bg-overlay font-semibold tabular-nums text-muted"
                :style="at(cluster.slots.length)"
                >+{{ cluster.more }}</span
            >
        </span>
    </RouterLink>
    <button
        v-else-if="sandbox.sandboxes.value.length > 0"
        type="button"
        :class="ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`)"
        data-rail-key="rail:add-sandbox"
        :aria-label="t(`sandbox.words.addSandbox`)"
        v-tooltip.right="t(`sandbox.words.addSandbox`)"
        @click="add"
        @pointerenter="warmAddSandbox"
        @focus="warmAddSandbox"
    >
        <Icon name="box-plus" class="icon-rail-glyph" aria-hidden="true" />
    </button>
</template>
