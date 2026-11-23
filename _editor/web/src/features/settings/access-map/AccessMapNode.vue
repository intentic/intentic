<script setup lang="ts">
import { Avatar, Button, Icon, SandboxLogo, type Tip, toneDot } from "@intentic/ui";
import type { IconName } from "@intentic/ui/icons";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import AccessMapStrip from "./AccessMapStrip.vue";
import type { AccountGraph, GraphEdge, GraphMachine, GraphSandbox, ReadState } from "./accountGraph";
import { machineName, nodeName, readWords, sandboxLine } from "./accessMapWords";
import { landingTies } from "./tieStrip";

// ONE THING ON THE ACCESS MAP: the account, one of the sandboxes it reaches, or a computer, phone, browser, server or the
// cloud one of them reaches. All three light the same way as the sandbox's own map (features/sandbox/map): dim is out of
// the focus's reach, a tinted edge is in it, a halo is the focus itself. A card names what it is and how its read
// stands; what reaches it is drawn by the lines, and what each of those ties allows is drawn on the card it lands on, as
// a row of glyphs (AccessMapStrip), so the map says it without a caption to read.

const t = useT();

const { graph, id, lit, litEdges, pinned, now, picture } = defineProps<{
    graph: AccountGraph;
    id: string;
    lit: `self` | `on` | `off` | undefined;
    /** The ties the focus lights, so a card two sandboxes reach dims the row of the one out of focus. */
    litEdges?: ReadonlySet<string> | undefined;
    pinned: boolean;
    now: number;
    /** The account's own picture, for its card. */
    picture?: string | null | undefined;
}>();
defineEmits<{ point: [on: boolean]; press: []; read: [sandboxId: string] }>();

const node = computed(() => graph.nodes.get(id));
const sandbox = computed(() => {
    const found = node.value;
    return found !== undefined && `standing` in found ? (found satisfies GraphSandbox) : undefined;
});
const machine = computed(() => {
    const found = node.value;
    return found !== undefined && !(`standing` in found) ? (found satisfies GraphMachine) : undefined;
});

const MACHINE_ICONS = { computer: `desktop`, phone: `mobile`, browser: `browsers`, server: `server`, cloud: `cloud` } as const satisfies Record<
    GraphMachine[`kind`],
    IconName
>;

// A read that could not be made now is a quiet dot; one that needs the reader (sign in, update) is a warmer one.
const toneOfRead = (state: ReadState | undefined): `neutral` | `warning` | `info` | undefined => {
    switch (state) {
        case `asleep`:
        case `locked`:
            return `neutral`;
        case `unreachable`:
        case `old`:
            return `warning`;
        case `signin`:
            return `info`;
        default:
            return undefined;
    }
};

const title = computed(() => (sandbox.value !== undefined ? sandbox.value.name : machine.value !== undefined ? machineName(machine.value) : t(`settings.accessMap.you`)));
const line = computed((): string | undefined => {
    if (sandbox.value !== undefined) {
        // Who the reader is there and whose policy holds it; then, only when it was not read this time, why not.
        const stale = sandbox.value.read === `fresh` ? undefined : readWords(sandbox.value.read, sandbox.value.readAt, now);
        return [sandboxLine(sandbox.value), stale].filter((part) => part !== undefined && part !== ``).join(` · `);
    }
    if (machine.value !== undefined) {
        return machine.value.detail ?? machine.value.platform;
    }
    return graph.you.email;
});
const readTone = computed(() => toneOfRead(sandbox.value?.read));

// Who else is here, and a fleet card's reach, as hover cards: the marks are a glyph and a number on the card.
const peopleTip = computed((): Tip | undefined => {
    const count = sandbox.value?.people ?? 0;
    return count > 0 ? { title: t(`settings.accessMap.glyph.peopleTitle`), note: t(`settings.accessMap.glyph.peopleNote`, { count }, count) } : undefined;
});
const fleetTip = computed((): Tip | undefined => {
    const found = sandbox.value;
    if (found?.fleet === undefined) {
        return undefined;
    }
    return {
        title: t(`settings.accessMap.glyph.fleetTitle`),
        note: found.standing === `yours` ? t(`settings.accessMap.glyph.fleetYours`) : t(`settings.accessMap.glyph.fleetOwner`),
    };
});
// A sandbox with no session to read it under: the one press that fills it in, on its own card.
const readable = computed(() => (sandbox.value?.read === `signin` ? sandbox.value.sandboxId : undefined));

// What lands here, each as its row. A row names the sandbox it comes from when it could be read as another's: more than
// one tie lands, or a link does, whose row would otherwise read as what this sandbox may do.
const landing = computed(() => landingTies(graph.edges, id));
const named = computed(() => landing.value.length > 1 || landing.value.some((tie) => tie.kind === `link`));
const fromOf = (tie: GraphEdge): GraphSandbox | undefined => {
    const found = named.value ? graph.nodes.get(tie.from) : undefined;
    return found !== undefined && `standing` in found ? found : undefined;
};
const dimOf = (tie: GraphEdge): boolean => litEdges !== undefined && lit !== `off` && !litEdges.has(tie.id);
// The sandboxes that run on this computer: a home on its card, said in words on pointing.
const hosts = computed(() =>
    graph.edges
        .filter((tie) => tie.kind === `runs` && tie.to === id)
        .map((tie) => nodeName(graph, tie.from))
        .join(`, `),
);

const frame = computed(() => {
    if (lit === `self`) {
        return `border-(--map-edge-strong) shadow-(--map-halo) bg-(--map-wash)`;
    }
    return lit === `on` ? `border-(--map-edge) bg-card` : `border-line-subtle bg-card hover:border-line`;
});
</script>

<template>
    <div :data-access-node="id" class="relative min-w-0">
        <button
            type="button"
            :aria-pressed="pinned"
            class="relative flex w-full min-w-0 flex-col gap-1 rounded-lg border px-2.5 py-1.5 text-left transition-[opacity,border-color,box-shadow,filter,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link"
            :class="[frame, lit === `off` ? `opacity-30 saturate-0` : ``, readable !== undefined ? `pr-16` : ``]"
            @pointerenter="$emit(`point`, true)"
            @pointerleave="$emit(`point`, false)"
            @focus="$emit(`point`, true)"
            @blur="$emit(`point`, false)"
            @click="$emit(`press`)"
        >
            <span class="flex w-full min-w-0 items-center gap-2.5">
                <SandboxLogo v-if="sandbox !== undefined" :size="22" :image="sandbox.image ?? null" :name="sandbox.name" class="shrink-0 rounded-md" />
                <span v-else-if="machine !== undefined" class="flex size-5.5 shrink-0 items-center justify-center rounded-md bg-overlay text-xs text-muted">
                    <Icon :name="MACHINE_ICONS[machine.kind]" />
                </span>
                <Avatar v-else :size="26" :name="graph.you.email" :src="picture" />

                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm text-content" :class="sandbox === undefined && machine === undefined ? `font-medium` : ``">{{ title }}</span>
                    <span v-if="line !== undefined && line !== ``" class="truncate text-xs text-subtle">{{ line }}</span>
                </span>

                <span v-if="hosts !== ``" v-tooltip.top="t(`settings.accessMap.tie.hosts`, { name: hosts })" class="shrink-0 text-xs text-muted">
                    <Icon name="home" />
                </span>
                <span v-if="peopleTip !== undefined" v-tooltip.top="peopleTip" class="flex shrink-0 items-center gap-0.5 text-2xs text-muted">
                    <Icon name="users" />{{ sandbox?.people }}
                </span>
                <span v-if="fleetTip !== undefined" v-tooltip.top="fleetTip" class="shrink-0 text-2xs text-muted">
                    <Icon name="key" />
                </span>
                <!-- The read's words are on the card's second line already; the dot only colours them. -->
                <span v-if="readTone !== undefined" class="size-1.5 shrink-0 rounded-full" :class="toneDot(readTone)" />
                <span
                    v-else-if="machine?.online !== undefined"
                    v-tooltip.top="machine.online ? t(`settings.accessMap.connected`) : t(`settings.accessMap.notConnected`)"
                    class="size-1.5 shrink-0 rounded-full"
                    :class="machine.online ? toneDot(`success`) : toneDot(`neutral`)"
                />
            </span>

            <span v-if="landing.length > 0" class="flex w-full min-w-0 flex-col gap-1 pl-8">
                <AccessMapStrip
                    v-for="tie in landing"
                    :key="tie.id"
                    :edge="tie"
                    :verb="tie.kind === `link` ? `takesFrom` : tie.kind === `server` ? `signedInFrom` : `reachedFrom`"
                    :from="fromOf(tie)"
                    :dim="dimOf(tie)"
                />
            </span>
        </button>
        <Button
            v-if="readable !== undefined"
            class="absolute right-2 top-1.5"
            size="small"
            tier="boring"
            :label="t(`settings.accessMap.read`)"
            @click="$emit(`read`, readable)"
        />
    </div>
</template>
