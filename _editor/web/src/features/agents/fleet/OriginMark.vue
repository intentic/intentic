<script setup lang="ts">
import { computed } from "vue";
import type { AgentOrigin } from "@intentic/sandbox-contract";
import type { Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { originMeta } from "./agentStatus";

/* "This conversation came in from outside": the one mark that tells an agent an automation opened for a Discord mention. */

const props = defineProps<{ origin?: AgentOrigin; compact?: boolean }>();

const t = useT();

const meta = computed(() => (props.origin !== undefined ? originMeta(props.origin) : undefined));

// The compact glyph's hover: the source, then which automation opened it, where, and for whom.
const tip = computed((): Tip | undefined =>
    props.compact !== true || props.origin === undefined || meta.value === undefined
        ? undefined
        : {
              title: meta.value.label,
              rows: [
                  { label: t(`common.originMark.automation`), value: props.origin.automationId },
                  { label: t(`common.originMark.channel`), value: props.origin.channelId ?? `` },
                  { label: t(`common.originMark.author`), value: props.origin.author ?? `` },
              ],
          },
);
</script>

<template>
<!-- The hint only in `compact`, where the glyph stands alone. -->
    <span
        v-if="meta !== undefined"
        v-tooltip.top="tip"
        class="flex min-w-0 items-center gap-1.5 text-2xs text-muted"
        :aria-label="meta.hint"
    >
        <Icon :name="meta.icon" class="shrink-0 text-2xs" />
        <template v-if="compact !== true">
            <span class="shrink-0 font-medium">{{ meta.label }}</span>
            <template v-if="meta.detail !== undefined">
                <span>·</span>
                <span class="truncate">{{ meta.detail }}</span>
            </template>
        </template>
    </span>
</template>
