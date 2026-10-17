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
// focus leaves it dark, else how the focus reaches it.

const t = useT();

const { principal, lit, pinned, personaName } = defineProps<{
    principal: Principal;
    lit: ReachHow | `self` | `off` | undefined;
    pinned: boolean;
    personaName: PersonaName;
}>();
defineEmits<{ point: [on: boolean]; press: [] }>();

const name = computed(() => principalName(principal));
const line = computed(() => principalLine(principal, personaName));
const icon = computed(() => (principal.kind === `token` ? `key` : `link`));
</script>

<template>
    <button
        type="button"
        :data-principal="principal.id"
        :data-kind="principal.kind"
        :aria-pressed="pinned"
        :title="principal.label"
        class="relative flex w-full min-w-0 items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2 text-left transition-[opacity,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link"
        :class="[
            lit === `off` ? `opacity-35` : ``,
            lit === `self` ? `border-transparent ring-2 ring-(--map-ink)` : lit !== undefined && lit !== `off` ? `border-(--map-ink)` : `border-line-subtle hover:border-line-strong`,
            principal.status === `active` ? `` : `border-dashed`,
        ]"
        @pointerenter="$emit(`point`, true)"
        @pointerleave="$emit(`point`, false)"
        @focus="$emit(`point`, true)"
        @blur="$emit(`point`, false)"
        @click="$emit(`press`)"
    >
        <span class="relative flex shrink-0">
            <Avatar v-if="principal.kind === `person`" :size="26" :name="principal.label" :hue="identityHue(principal.label)" />
            <span v-else class="flex size-6.5 items-center justify-center rounded-lg bg-overlay text-sm text-muted">
                <Icon :name="icon" />
            </span>
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
            <span class="flex min-w-0 text-sm" :class="principal.status === `inert` ? `text-subtle line-through decoration-line-strong` : `text-content`">
                <span class="min-w-0 truncate font-medium">{{ name }}</span>
            </span>
            <span class="truncate text-xs text-subtle">{{ line }}</span>
        </span>
        <span v-if="principal.self" class="shrink-0 rounded-md bg-overlay px-1.5 py-0.5 text-3xs font-medium text-muted">{{ t(`sandbox.sandboxMap.you`) }}</span>
        <span
            v-else-if="principal.waiting !== undefined"
            class="shrink-0 rounded-md bg-warning-tint px-1.5 py-0.5 text-3xs font-medium text-warning"
            :title="t(`sandbox.sandboxMap.waiting`, { count: principal.waiting }, principal.waiting)"
            >{{ principal.waiting }}</span
        >
        <span v-if="lit === `through`" class="shrink-0 text-xs text-(--map-ink)" :title="t(`sandbox.sandboxMap.legendThrough`)"><Icon name="user" /></span>
    </button>
</template>
