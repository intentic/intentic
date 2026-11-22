<script setup lang="ts">
import type { AutoApproveMark } from "@intentic/sandbox-contract/schemas/auto-approve";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// The auto-approve mark a card wears (sandbox-contract schemas/auto-approve.ts): a bolt in the warning's ink, since every
// permission the session asks for is approved with nobody looking. Fainter when the session only follows the one that
// started it, whose own menu is where it comes off. Its hover says which, so the corner never has to.
const t = useT();
const { mark } = defineProps<{ mark: NonNullable<AutoApproveMark> }>();
const tip = computed(() => (mark === `own` ? t(`agents.autoApprove.ownTip`) : t(`agents.autoApprove.inheritedTip`)));
</script>

<template>
    <Icon
        name="bolt"
        role="img"
        :aria-label="tip"
        v-tooltip.bottom="tip"
        class="shrink-0 text-warning"
        :class="mark === `inherited` && `opacity-60`"
        :data-auto-approve="mark"
    />
</template>
