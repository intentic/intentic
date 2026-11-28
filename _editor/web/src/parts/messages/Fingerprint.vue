<script setup lang="ts">
import { CopyButton } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { fingerprintGroups } from "../../models/messages/messagesView";

// A KEY'S FINGERPRINT, set for two people to compare it aloud: its prefix, then thirteen groups of four in a monospaced
// face, every other group on a faint plate so a reader keeps their place mid-line ("…group seven, k-q-4-m…"). What a
// contact pins, and what the owner reads to whoever adds this sandbox. Copied whole.

const { fingerprint, size = `md`, copy = true } = defineProps<{
    fingerprint: string;
    /** `lg` on the Identity part, where comparing it is the point; `md` beside a contact. */
    size?: `md` | `lg`;
    copy?: boolean;
}>();

const t = useT();
const parts = computed(() => fingerprintGroups(fingerprint));
</script>

<template>
    <div class="flex items-start gap-2" :data-fingerprint="fingerprint">
        <p class="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1 font-mono tabular-nums" :class="size === `lg` ? `text-sm tracking-wider` : `text-xs tracking-wide`" :aria-label="fingerprint">
            <span v-if="parts.prefix" class="pr-1 text-subtle">{{ parts.prefix }}</span>
            <span v-for="(group, at) in parts.groups" :key="at" class="rounded px-1 text-content" :class="at % 2 === 1 ? `bg-line-subtle` : ``">{{ group }}</span>
        </p>
        <CopyButton v-if="copy" class="shrink-0" :text="fingerprint" :aria-label="t(`sandbox.messages.identity.copyFingerprint`)" />
    </div>
</template>
