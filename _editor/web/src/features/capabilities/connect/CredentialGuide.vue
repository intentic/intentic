<!-- Per-capability credential help (scopes, how-to-get-it steps, a link to the provider's token page), read from the tile's `guide` metadata. -->
<script setup lang="ts">
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { computed } from "vue";
import { guideParts } from "./credentialGuide";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { entry, values } = defineProps<{ entry: CapabilityCatalogEntry; values: Record<string, string> }>();

// Token page link: absolute for a hosted provider, or built from the instance-URL field for a self-hostable one.
// Hidden until that field holds a real http(s) URL, so no broken path-only href is shown.
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

// Weight and colour mark a literal, not a chip or mono span: those visually outweighed the short surrounding prose.
const literal = `font-medium text-content`;

const linkLabel = computed(() => entry.guide?.linkLabel ?? `Create a token`);
const scopes = computed(() => entry.guide?.scopes);
const steps = computed<readonly string[]>(() => entry.guide?.steps ?? []);
</script>

<template>
    <div class="ui-card flex flex-col gap-3">
        <!-- The link leads, since opening the provider's token page is the actual first step; the numbered steps are the fallback. -->
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p class="text-sm font-semibold text-content">{{ t(`capabilities.credentialGuide.howToGet`) }}</p>
            <a
                v-if="tokenUrl"
                :href="tokenUrl"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center gap-1 text-xs text-link hover:underline"
            >
                {{ linkLabel }} <Icon name="external-link" />
            </a>
        </div>

        <!-- Permissions line comes before the steps, since it decides whether the token about to be made is the right one. -->
        <p v-if="scopes" class="flex items-start gap-2 text-xs leading-relaxed text-muted">
            <Icon name="key" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <span class="min-w-0">
                <span class="text-subtle">{{ t(`capabilities.credentialGuide.needs`) }} </span>
                <span v-for="(part, index) in guideParts(scopes)" :key="index" :class="part.literal ? literal : ''">{{ part.text }}</span>
            </span>
        </p>

        <!-- `break-words`: literals (hostnames, commands) have no spaces to break at, and the docked column is narrow. -->
        <ol v-if="steps.length > 0" class="flex list-decimal flex-col gap-2.5 pl-4 text-xs leading-relaxed break-words text-muted marker:text-subtle">
            <li v-for="(step, index) in steps" :key="index">
                <span v-for="(part, partIndex) in guideParts(step)" :key="partIndex" :class="part.literal ? literal : ''">{{ part.text }}</span>
            </li>
        </ol>
    </div>
</template>
