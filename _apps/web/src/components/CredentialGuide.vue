<!-- Per-capability credential help on the "+" config form: a deep "Create a token ↗" link straight to the
     provider's token page, the scopes it needs, and a numbered how-to-get-it behind a disclosure. Data comes
     from the card's `guide` metadata (CAPABILITY_CATALOG). Mirrors the CloudflareConnect connect step, generalized
     to every card. Renders nothing for cards without a guide (devops/monorepo/stripe and the browser-login ones).

     THE STEPS OPEN IN THE LAYOUT, NOT OVER IT. This was an InfoHint — a hover card teleported to <body> — and it
     was the wrong shape twice over. This guide sits BETWEEN the name field and the fields it explains, so the
     card dropped straight onto the inputs the reader had just been told how to fill: the instructions covered
     the thing they were instructions for. And it was hover-only and pointer-events-none, so a four-step how-to
     the user is meant to WORK THROUGH vanished the moment they reached for the field it named.

     A <details> fixes both by not being an overlay: it pushes the fields down instead of hiding them, stays open
     while the user types, and its text can be selected and copied. It is also the accessible default — summary
     is focusable and toggles on Enter/Space with no JS and no ARIA of our own. -->
<script setup lang="ts">
import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
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
    <div v-if="entry.guide" class="flex flex-col gap-1.5 text-2xs">
        <!-- Skipped entirely when a card has neither, which is the ordinary shape for anything without a token
             page to link (the model endpoint, the ACP agents) — an empty row would still spend the column gap. -->
        <div v-if="tokenUrl || scopes" class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a v-if="tokenUrl" :href="tokenUrl" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-link hover:underline">
                {{ linkLabel }} <Icon name="external-link" />
            </a>
            <span v-if="scopes" class="ml-auto text-subtle">Scopes: {{ scopes }}</span>
        </div>
        <!-- `group` + `open:` drive the caret's rotation off the element's own state, so nothing here tracks
             whether it is expanded. `list-none` drops the browser's default triangle in favour of our own caret. -->
        <details v-if="steps.length > 0" class="group">
            <summary class="inline-flex cursor-pointer list-none items-center gap-1.5 text-muted transition-colors hover:text-content">
                <Icon name="info-circle" />
                <span class="text-xs font-medium">How to get it</span>
                <Icon name="angle-right" class="transition-transform group-open:rotate-90" />
            </summary>
            <ol class="mt-2 flex list-decimal flex-col gap-1.5 rounded-lg border border-line bg-canvas px-3 py-2.5 pl-7 leading-relaxed text-muted">
                <li v-for="(step, index) in steps" :key="index">{{ step }}</li>
            </ol>
        </details>
    </div>
</template>
