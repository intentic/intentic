<script setup lang="ts">
import { Avatar, Icon, SandboxLogo, toneDot } from "@intentic/ui";
import type { IconName } from "@intentic/ui/icons";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { AccountGraph, GraphMachine, GraphSandbox, ReadState } from "./accountGraph";
import { machineName, readWords, sandboxLine } from "./accessMapWords";

// ONE THING ON THE ACCESS MAP: the account, one of the sandboxes it reaches, or a computer, phone, browser, server or the
// cloud one of them reaches. All three light the same way as the sandbox's own map (features/sandbox/map): dim is out of
// the focus's reach, a tinted edge is in it, a halo is the focus itself. A card names what it is and how its read
// stands; what it is tied to is drawn by the lines and said in the caption when it is the focus.

const t = useT();

const { graph, id, lit, pinned, now, picture } = defineProps<{
    graph: AccountGraph;
    id: string;
    lit: `self` | `on` | `off` | undefined;
    pinned: boolean;
    now: number;
    /** The account's own picture, for its card. */
    picture?: string | null | undefined;
}>();
defineEmits<{ point: [on: boolean]; press: [] }>();

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
const readTitle = computed(() => (sandbox.value === undefined ? undefined : readWords(sandbox.value.read, sandbox.value.readAt, now)));

const edge = computed(() => {
    if (lit === `self`) {
        return `border-(--map-edge-strong) shadow-(--map-halo) bg-(--map-wash)`;
    }
    return lit === `on` ? `border-(--map-edge) bg-card` : `border-line-subtle bg-card hover:border-line`;
});
</script>

<template>
    <button
        type="button"
        :data-access-node="id"
        :aria-pressed="pinned"
        class="relative flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-[opacity,border-color,box-shadow,filter,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link"
        :class="[edge, lit === `off` ? `opacity-30 saturate-0` : ``]"
        @pointerenter="$emit(`point`, true)"
        @pointerleave="$emit(`point`, false)"
        @focus="$emit(`point`, true)"
        @blur="$emit(`point`, false)"
        @click="$emit(`press`)"
    >
        <SandboxLogo v-if="sandbox !== undefined" :size="22" :image="sandbox.image ?? null" :name="sandbox.name" class="shrink-0 rounded-md" />
        <span v-else-if="machine !== undefined" class="flex size-5.5 shrink-0 items-center justify-center rounded-md bg-overlay text-xs text-muted">
            <Icon :name="MACHINE_ICONS[machine.kind]" />
        </span>
        <Avatar v-else :size="26" :name="graph.you.email" :src="picture" />

        <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-sm text-content" :class="sandbox === undefined && machine === undefined ? `font-medium` : ``">{{ title }}</span>
            <span v-if="line !== undefined && line !== ``" class="truncate text-xs text-subtle">{{ line }}</span>
        </span>

        <span v-if="(sandbox?.people ?? 0) > 0" class="flex shrink-0 items-center gap-0.5 text-2xs text-muted" :title="t(`settings.accessMap.people`, { count: sandbox?.people }, sandbox?.people ?? 0)">
            <Icon name="users" />{{ sandbox?.people }}
        </span>
        <span v-if="sandbox?.fleet !== undefined" class="shrink-0 text-2xs text-muted" :title="sandbox.standing === `yours` ? t(`settings.accessMap.fleetYours`) : t(`settings.accessMap.fleetOwner`)">
            <Icon name="key" />
        </span>
        <span v-if="readTone !== undefined" class="size-1.5 shrink-0 rounded-full" :class="toneDot(readTone)" :title="readTitle" />
        <span
            v-else-if="machine?.online !== undefined"
            class="size-1.5 shrink-0 rounded-full"
            :class="machine.online ? toneDot(`success`) : toneDot(`neutral`)"
            :title="machine.online ? t(`settings.accessMap.connected`) : t(`settings.accessMap.notConnected`)"
        />
    </button>
</template>
