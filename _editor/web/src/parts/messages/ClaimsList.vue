<script setup lang="ts">
import type { S2sClaims } from "@intentic/sandbox-contract/schemas/s2s";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { claimLabel, claimValue } from "../../models/messages/claimWords";

// WHAT A VOUCH CLAIMS, one quiet label and its value a line, as the issuer signed them (or as a request asks for them):
// a well-known claim in words, any other by its own name. The words are another sandbox's, drawn as plain text.

const { claims } = defineProps<{ claims: S2sClaims }>();

const t = useT();
const rows = computed(() => Object.entries(claims).map(([key, value]) => ({ key, label: claimLabel(key), value: claimValue(key, value) })));
</script>

<template>
    <dl v-if="rows.length > 0" class="flex flex-col gap-0.5 text-xs" data-claims>
        <div v-for="row in rows" :key="row.key" class="flex gap-3" :data-claim="row.key">
            <dt class="w-28 shrink-0 text-muted">{{ row.label }}</dt>
            <dd class="min-w-0 break-words text-content">{{ row.value }}</dd>
        </div>
    </dl>
    <p v-else class="text-xs text-muted" data-claims>{{ t(`sandbox.messages.claims.none`) }}</p>
</template>
