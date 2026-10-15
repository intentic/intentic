<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useOrgPolicy } from "./useOrgPolicy";

// One sandbox-hub section as an organisation holds it. Open (every personal sandbox): the section, untouched. Locked
// or hidden: a line naming who holds it, and the section inside a disabled fieldset, so every control in it is inert
// at once rather than each page learning about organisations. The daemon refuses the change anyway; this is so nobody
// is offered one.
const { slug } = defineProps<{ slug: string }>();

const t = useT();
const { policy, modeOf } = useOrgPolicy();
const held = computed(() => policy.value !== undefined && modeOf(slug) !== `open`);
</script>

<template>
    <div v-if="held" class="flex flex-col gap-4">
        <Notice tone="info">{{ t(`organisations.held.notice`, { org: policy?.orgName ?? `` }) }}</Notice>
        <fieldset disabled class="contents">
            <slot />
        </fieldset>
    </div>
    <slot v-else />
</template>
