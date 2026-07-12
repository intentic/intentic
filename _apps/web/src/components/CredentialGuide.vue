<!-- Per-capability credential help on the "+" config form: a deep "Create a token ↗" link straight to the
     provider's token page, the scopes it needs, and a numbered how-to-get-it behind an (i) disclosure. Data comes
     from the card's `guide` metadata (CAPABILITY_CATALOG). Mirrors the CloudflareConnect connect step, generalized
     to every card. Renders nothing for cards without a guide (devops/monorepo/stripe and the browser-login ones). -->
<script setup lang="ts">
import type { CapabilityCatalogEntry } from "@intentic-app/catalog";
import { InfoHint } from "@intentic-app/ui";
import { computed } from "vue";

const { entry, values } = defineProps<{ entry: CapabilityCatalogEntry; values: Record<string, string> }>();

// The token page link. Absolute for a hosted provider; for a self-hostable one it's built from the instance-URL
// field's live value, so it points at the user's own host — and stays hidden until that field holds an http(s)
// URL, so we never emit a broken path-only href.
const tokenUrl = computed<string | undefined>(() => {
    const guide = entry.guide;
    if (guide === undefined) {
        return undefined;
    }
    if (guide.urlFromField !== undefined) {
        const base = (values[guide.urlFromField] ?? ``).trim().replace(/\/+$/, ``);
        if (!/^https?:\/\//i.test(base)) {
            return undefined;
        }
        return guide.path !== undefined ? `${base}${guide.path}` : base;
    }
    return guide.url;
});

const linkLabel = computed(() => entry.guide?.linkLabel ?? `Create a token`);
const scopes = computed(() => entry.guide?.scopes);
const steps = computed<readonly string[]>(() => entry.guide?.steps ?? []);
</script>

<template>
    <div v-if="entry.guide" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
        <a v-if="tokenUrl" :href="tokenUrl" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-link hover:underline">
            {{ linkLabel }} <Icon name="external-link" />
        </a>
        <InfoHint v-if="steps.length > 0" label="How to get this credential" text="How to get it">
            <p class="mb-2 text-sm font-semibold text-content">{{ entry.name }} — how to get the credential</p>
            <ol class="flex list-decimal flex-col gap-1.5 pl-4 leading-relaxed text-muted">
                <li v-for="(step, index) in steps" :key="index">{{ step }}</li>
            </ol>
        </InfoHint>
        <span v-if="scopes" class="ml-auto text-subtle">Scopes: {{ scopes }}</span>
    </div>
</template>
