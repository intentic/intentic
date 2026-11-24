<!-- ALL SANDBOXES, FOLDED: the reader's other sandboxes as overlapping circles under the switcher, two on top and one
     tucked below, the last a "+n" past three. One press unrolls them along the rail (MasterRail.vue): each circle flies
     out to its tile and the sections go into the bookmark (railMorph.ts, by the marks below), the page on screen staying
     where it is (sandboxScreen.ts `unrolledPath`). Not a Home tile (the owner turned one down twice): it says something
     a tile could not, which other sandboxes there are and which of them waits for the reader, the reason to unroll at
     all. For a reader with no other sandbox it is the add tile instead, so a first extra sandbox is always one press away
     (the unrolled rail ends in the same tile, HomeSandboxes.vue).
     The same part under This computer's logo in the desktop app's window on a folder (local/LocalShell.vue), where every
     sandbox is another: its press unrolls that window's rail (local/LocalMasterRail.vue, models/home/masterRail.ts
     `localRailUnrolled`), in the order the workspace last told the app, and its add tile is that window's own add (the
     sign-in first, while nobody is signed in). It asks no sandbox what waits there: a folder window dials no daemon but
     its folder's. -->
<script setup lang="ts">
import { SandboxLogo, type Tip, ui } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useFolderPlace } from "../../features/sandbox/gates/switcherPlace";
import type { AttentionReading } from "../../models/home/homeFacts";
import { localRailUnrolled } from "../../models/home/masterRail";
import { sandboxColor } from "../../features/sandbox/overview/logo/sandboxColor";
import { type ClusterSlot, clusterOf, type MakingBox } from "../../models/home/otherSandboxes";
import { newSandbox, readNewSandbox, readySandboxes } from "../../features/home/newSandbox/newSandbox";
import { sandboxOrder } from "../../models/home/sandboxOrder";
import { useHomeAttention } from "../../models/home/useHomeAttention";
import { switchableSandboxes } from "../../models/sandbox/live/roster";
import { useRequestAddSandbox, warmAddSandbox } from "../../models/sandbox/addSandbox";
import { unrolledPath } from "../../models/sandbox/sandboxScreen";
import { commandShortcut } from "../../workbench/commands/useCommands";
import { badgeClass } from "../../workbench/views/viewBadge";

const t = useT();
const sandbox = useSandbox();
// The desktop app's window on a folder (switcherPlace.ts): its sandboxes' order, and its own add.
const place = useFolderPlace();
const { local } = place;
// Home's own count of what waits for the reader in each box, so the point here and the chip on Home's tile agree. At the
// across-sandboxes store's ambient pace, and never the box the shell is in: its own tiles count that one. None in a
// folder window, which reaches no sandbox's daemon.
const nothingRead = computed<ReadonlyMap<string, AttentionReading>>(() => new Map());
const readings = local ? nothingRead : useHomeAttention({ everyMs: 45_000, skip: () => sandbox.activeSandboxId.value });
// The sandbox Home is making, from its press until its run ends (features/home/newSandbox/newSandbox.ts), ringed among
// the others, so a reader inside another sandbox sees it and has the way back to it. A folder window makes its own.
const making = computed((): MakingBox | undefined => {
    const run = newSandbox.value;
    const reading = readNewSandbox(run);
    if (local || run === undefined || reading === undefined || reading.phase === `draft`) {
        return undefined;
    }
    return { id: run.here.add.created.value?.id, name: reading.name === `` ? t(`home.newSandbox.title`) : reading.name, state: reading.phase };
});
const makingNote = computed(() => readNewSandbox(newSandbox.value)?.note);
const cluster = computed(() =>
    clusterOf(
        switchableSandboxes(sandbox.sandboxes.value),
        sandbox.activeSandboxId.value,
        readings.value,
        local ? place.arranged.value : sandboxOrder.value,
        { making: making.value, ready: local ? undefined : readySandboxes.value },
    ),
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

// A picture brings its own colour and sits on the card, since a logo is often line art on nothing. A monogram is drawn in
// the sandbox's own colour (sandboxColor.ts), the one its rail wears once it is open, so the circle here and the rail
// there say the same thing; mixed toward the theme's own card and ink so it reads in light and dark alike.
const tint = (slot: ClusterSlot) => {
    const hue = sandboxColor(slot);
    return {
        backgroundColor: `color-mix(in oklab, ${hue} 24%, var(--color-card))`,
        color: `color-mix(in oklab, ${hue} 55%, var(--color-content))`,
    };
};

// The page on screen, the rail unrolled around it.
const route = useRoute();
const home = computed(() => unrolledPath(route));

// The same add action everywhere: signed in opens the dialog here; signed out returns to it after sign-in. A folder
// window's own (switcherPlace.ts): made in that window, or the sign-in while nobody is signed in.
const requestAdd = local ? place.addSandbox : useRequestAddSandbox();
const add = (): void => requestAdd();
const addLabel = computed(() => (place.signedOut.value ? t(`local.placeSwitcher.putAgentsToWork`) : t(`sandbox.words.addSandbox`)));
const addTip = computed<Tip | string>(() =>
    place.signedOut.value ? { title: t(`local.placeSwitcher.putAgentsToWork`), note: t(`local.placeSwitcher.signInLead`) } : t(`sandbox.words.addSandbox`),
);

// A folder window has no Home frame: its rail unrolls in place (models/home/masterRail.ts `localRailUnrolled`).
const unrollHere = (): void => {
    localRailUnrolled.value = true;
};

const needy = computed(() => cluster.value.slots.filter((slot) => slot.needsYou > 0));
// The hover's rows: the sandbox being made and where it stands, one made while the reader was elsewhere, then what waits.
const tipRows = computed(() => [
    ...cluster.value.slots.filter((slot) => slot.making !== undefined).map((slot) => ({
            label: slot.name,
            value: makingNote.value ?? ``,
            tone: slot.making === `failed` ? (`danger` as const) : slot.making === `asking` ? (`warning` as const) : undefined,
        })),
    ...cluster.value.slots.filter((slot) => slot.ready === true).map((slot) => ({ label: slot.name, value: t(`home.otherSandboxes.ready`) })),
    ...needy.value.map((slot) => ({ label: slot.name, value: slot.needsYou })),
]);
const tip = computed<Tip>(() => ({
    title: t(`home.open`),
    keys: commandShortcut(`view.home`),
    rows: tipRows.value,
    // A folder window counts nothing, so it says nothing about what waits.
    note: local ? undefined : needy.value.length > 0 ? t(`home.otherSandboxes.waiting`) : t(`home.otherSandboxes.quiet`),
}));
// A circle's point: a count waiting there, the sandbox being made asking something (warning) or stopped (danger), or one
// made while the reader was elsewhere (the ready mark's own tone).
const pointOf = (slot: ClusterSlot): string | undefined => {
    if (slot.making === `failed`) {
        return badgeClass({ tone: `danger` });
    }
    if (slot.making === `asking`) {
        return badgeClass({ tone: `warning` });
    }
    if (slot.needsYou > 0) {
        return badgeClass({ count: slot.needsYou });
    }
    return slot.ready === true ? badgeClass({ tone: `info` }) : undefined;
};
const label = computed(() =>
    [
        t(`home.otherSandboxes.label`, { names: cluster.value.names.join(`, `) }),
        cluster.value.needing > 0 ? t(`home.otherSandboxes.needing`, { count: cluster.value.needing }) : undefined,
        making.value === undefined || makingNote.value === undefined ? undefined : `${making.value.name}: ${makingNote.value}`,
    ]
        .filter((part) => part !== undefined)
        .join(`. `),
);
</script>

<template>
    <!-- A link to the page in Home's frame in the workspace; a press that unrolls the rail in place in a folder window. -->
    <component
        :is="local ? `button` : RouterLink"
        v-if="cluster.slots.length > 0"
        v-bind="local ? { type: `button` } : { to: home }"
        class="icon-rail-cluster ui-row-select ui-row-select-horizontal flex items-center justify-center rounded-lg"
        data-rail-holds="sandboxes"
        :aria-label="label"
        v-tooltip.right="tip"
        @click="local && unrollHere()"
    >
        <span class="icon-rail-cluster-box relative" aria-hidden="true">
            <span
                v-for="(slot, index) in cluster.slots"
                :key="slot.id"
                :data-rail-key="`sandbox:${slot.id}`"
                data-rail-into="sandboxes"
                class="icon-rail-cluster-circle absolute flex items-center justify-center rounded-full font-semibold"
                :class="{ 'opacity-40 grayscale': slot.unreachable, 'bg-card': slot.image }"
                :style="{ ...at(index), ...(slot.image ? {} : tint(slot)) }"
            >
                <SandboxLogo :image="slot.image" :name="slot.name" class="rounded-full [&_span]:text-inherit" />
                <!-- The sandbox being made: a turning arc around its circle while it runs, the rail's "in flight" ink. -->
                <span
                    v-if="slot.making === `running` || slot.making === `opening`"
                    class="icon-rail-cluster-ring absolute rounded-full motion-safe:animate-spin"
                    data-cluster-making
                ></span>
                <!-- Which of them waits for the reader: a point on that circle, in the count chip's own plate, above the circles that
                     overlap it. -->
                <span v-if="pointOf(slot)" class="icon-rail-cluster-point absolute z-10 rounded-full" :class="pointOf(slot)"></span>
            </span>
            <span
                v-if="cluster.more > 0"
                class="icon-rail-cluster-circle absolute flex items-center justify-center rounded-full bg-overlay font-semibold tabular-nums text-muted"
                :style="at(cluster.slots.length)"
                >+{{ cluster.more }}</span
            >
        </span>
    </component>
    <button
        v-else-if="sandbox.sandboxes.value.length > 0"
        type="button"
        :class="ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`)"
        data-rail-key="rail:add-sandbox"
        :aria-label="addLabel"
        v-tooltip.right="addTip"
        @click="add"
        @pointerenter="warmAddSandbox"
        @focus="warmAddSandbox"
    >
        <Icon name="box-plus" class="icon-rail-glyph" aria-hidden="true" />
    </button>
</template>
