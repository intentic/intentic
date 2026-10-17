<script setup lang="ts">
import { Avatar, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { identityHue } from "../../../lib/identityHue";
import { type PersonaName, principalLine, principalName } from "./mapWords";
import type { Principal, ReachHow } from "./reachModel";

// ONE WAY INTO THE SANDBOX, as the map's left column draws it: a person by their face and address, a control token by its
// key, another sandbox by its link. The row is the principal's handle on the map: pointing at it lights what it reaches,
// pressing it keeps that lit. `lit` is what the current focus says of it: undefined with nothing in focus, `off` when the
// focus leaves it dark, else how the focus reaches it. Compact, it is one line: the name, and what it may do after it.

const t = useT();

const {
    principal,
    lit,
    pinned,
    personaName,
    compact = false,
} = defineProps<{
    principal: Principal;
    lit: ReachHow | `self` | `off` | undefined;
    pinned: boolean;
    personaName: PersonaName;
    compact?: boolean;
}>();
defineEmits<{ point: [on: boolean]; press: [] }>();

const name = computed(() => principalName(principal));
const line = computed(() => principalLine(principal, personaName));
const icon = computed(() => (principal.kind === `token` ? `key` : `link`));
// The same quiet edges every card on the map wears (MapNodeButton): a tint for what the focus lights, a halo for the focus.
const edge = computed(() => {
    if (lit === `self`) {
        return `border-(--map-edge-strong) bg-(--map-wash) shadow-(--map-halo)`;
    }
    return lit !== undefined && lit !== `off` ? `border-(--map-edge) bg-card` : `border-line-subtle bg-card hover:border-line`;
});
</script>

<template>
    <button
        type="button"
        :data-principal="principal.id"
        :data-kind="principal.kind"
        :aria-pressed="pinned"
        :title="`${principal.label}\n${line}`"
        class="relative flex w-full min-w-0 items-center border text-left transition-[opacity,border-color,box-shadow,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link"
        :class="[
            edge,
            compact ? `gap-2 rounded-lg px-2 py-1` : `gap-2.5 rounded-xl px-2.5 py-2`,
            lit === `off` ? `opacity-35` : ``,
            principal.status === `active` ? `` : `border-dashed`,
        ]"
        @pointerenter="$emit(`point`, true)"
        @pointerleave="$emit(`point`, false)"
        @focus="$emit(`point`, true)"
        @blur="$emit(`point`, false)"
        @click="$emit(`press`)"
    >
        <span class="relative flex shrink-0">
            <Avatar v-if="principal.kind === `person`" :size="compact ? 20 : 26" :name="principal.label" :hue="identityHue(principal.label)" />
            <span
                v-else
                class="flex items-center justify-center bg-overlay text-muted"
                :class="compact ? `size-5 rounded-md text-2xs` : `size-6.5 rounded-lg text-sm`"
            >
                <Icon :name="icon" />
            </span>
        </span>
        <span class="flex min-w-0 flex-1" :class="compact ? `items-baseline gap-2` : `flex-col`">
            <!-- Compact, the name keeps its room and what it may do gives way first. -->
            <span
                class="truncate text-sm font-medium"
                :class="[
                    principal.status === `inert` ? `text-subtle line-through decoration-line-strong` : `text-content`,
                    compact ? `max-w-[70%] shrink-0` : `min-w-0`,
                ]"
                >{{ name }}</span
            >
            <span class="truncate text-subtle" :class="compact ? `min-w-0 flex-1 text-right text-2xs` : `text-xs`">{{ line }}</span>
        </span>
        <span v-if="principal.self" class="shrink-0 rounded-md bg-overlay px-1.5 py-0.5 text-3xs font-medium text-muted">{{ t(`sandbox.sandboxMap.you`) }}</span>
        <span
            v-else-if="principal.waiting !== undefined"
            class="shrink-0 rounded-md bg-warning-tint px-1.5 py-0.5 text-3xs font-medium text-warning"
            :title="t(`sandbox.sandboxMap.waiting`, { count: principal.waiting }, principal.waiting)"
            >{{ principal.waiting }}</span
        >
        <span v-if="lit === `through`" class="shrink-0 text-xs text-(--map-mark)" :title="t(`sandbox.sandboxMap.legendThrough`)"><Icon name="user" /></span>
    </button>
</template>
