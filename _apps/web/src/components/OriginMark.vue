<script setup lang="ts">
import { computed } from "vue";
import type { AgentOrigin } from "@intentic/sandbox-contract";
import { originMeta } from "../composables/agents/agentStatus";

/* "This conversation came in from outside" — the one mark that tells an agent an automation opened for a
 * Discord mention, a web-chat visitor or a webhook apart from one the user started. Everything else about it
 * is an ordinary conversation (its own worktree, its own chat tab, its own turns), which is exactly why the
 * provenance has to be visible: without it the card reads as an agent the user forgot starting.
 *
 * Renders nothing for a user-started conversation, so callers can hand it an optional origin unconditionally.
 * `compact` is the icon alone (the chat tab strip, where the title already carries the sender); the full form
 * names the source and who sent it (the fleet card). */

const props = defineProps<{ origin?: AgentOrigin; compact?: boolean }>();

const meta = computed(() => (props.origin !== undefined ? originMeta(props.origin) : undefined));
</script>

<template>
    <span v-if="meta !== undefined" v-tooltip.top="meta.hint" class="flex min-w-0 items-center gap-1.5 text-2xs text-muted" :aria-label="meta.hint">
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
