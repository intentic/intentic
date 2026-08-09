<!-- Per-capability credential help on the "+" config form: the scopes the token needs, the numbered
     how-to-get-it, and a deep "Create a token ↗" link straight to the provider's token page. Data comes from
     the card's `guide` metadata (CAPABILITY_CATALOG). The CALL SITE decides whether there is a guide to
     render — a card without one (devops/monorepo/stripe, the browser-kind ones) must not reach here, since
     the docked placement would otherwise hold its whole column open around nothing.

     NOTHING HERE IS BEHIND A DISCLOSURE, AND IT SITS BESIDE THE FORM RATHER THAN IN IT. Two shapes came before
     this one and both failed the same way. First an InfoHint — a hover card teleported to <body> — which
     landed ON the inputs it was explaining and vanished the moment the reader went for the field it named.
     Then a <details>, which fixed the covering by pushing the fields down, at the price of the steps being
     shut by default: a four-step how-to that only appears if you first guess there is one is, for most
     readers, a how-to that does not exist.

     So this is /setup's shape, which had already settled the same argument (SetupRunDetails): reference
     material lives in a column of its own, permanently open, where it can be read WHILE the form is filled in
     rather than instead of it. Capabilities.vue docks it on the right wherever the page is wide enough and
     drops it inline above the fields where it isn't — visible either way.

     The prose carries `backticks` around the literals a reader has to find or type (see credentialGuide.ts),
     and they come out as chips. That is what turns "add write:public_key for native ssh" from a sentence you
     have to parse into a value you can pick out of it. -->
<script setup lang="ts">
import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import { computed } from "vue";
import { guideParts } from "./credentialGuide";

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

/* A scope name, a menu item, a hostname, a port. A STEP UNDER the sans around it and tinted low — which is
 * prose.css's rule for the same chip inside markdown, arrived at for the two reasons visible here as well.
 * Mono reads optically LARGER than sans at the same nominal size, so a chip that matched the sentence's size
 * came out bigger than the sentence carrying it. And at a solid surface tint a step holding three literals
 * stopped being a sentence at all and became a row of boxes with words between them.
 *
 * Sized in `em` rather than a fixed step so the chip tracks whatever line it lands in, and so its own leading
 * stays comfortably inside the paragraph's — which is what keeps a three-literal step from rippling the
 * line height, the thing the previous same-size rule was written to avoid.
 *
 * `box-decoration-clone` because these wrap: a menu path is three chips in one sentence and a narrow column
 * breaks them mid-token. Without it the fragment left on the first line keeps the chip's left corners and
 * padding and the rest arrives with a square, flush edge — one literal drawn as two half-boxes. */
const literal = `box-decoration-clone rounded-sm bg-content/10 px-1 py-px font-mono text-[0.8125em] text-content`;

const linkLabel = computed(() => entry.guide?.linkLabel ?? `Create a token`);
const scopes = computed(() => entry.guide?.scopes);
const steps = computed<readonly string[]>(() => entry.guide?.steps ?? []);
</script>

<template>
    <div class="ui-card flex flex-col gap-3">
        <p class="text-sm font-semibold text-content">How to get it</p>

        <!-- The permissions line comes BEFORE the steps: it is what decides whether the token you are about to
             make is the right one, and reading it after step four is reading it too late.

             Its glyph is sized and toned like the ones in <CapabilityEffects> directly below it — small, muted,
             hung off the first line. Drawn at the link colour and at full text size it stopped reading as a UI
             icon and started reading as an emoji dropped in front of the sentence, which is the one thing a
             mark in this position must not do: it is labelling a fact, not decorating one. -->
        <p v-if="scopes" class="flex items-start gap-2 text-sm leading-relaxed text-muted">
            <Icon name="key" class="mt-1 shrink-0 text-xs text-subtle" />
            <span class="min-w-0">
                <span class="text-subtle">Needs </span>
                <span v-for="(part, index) in guideParts(scopes)" :key="index" :class="part.literal ? literal : ''">{{ part.text }}</span>
            </span>
        </p>

        <!-- break-words, because the literals are hostnames, scopes and commands with no spaces to break at,
             and the docked column is narrower than several of them.

             AT THE PROSE SIZE, not the chrome size. These steps are read in paragraphs — five of them, before
             a single field is filled in — and the design system puts the floor for something read that way at
             0.875rem (prose.css). A step under it, in a docked column, the five of them arrived as one grey
             slab: the size that is right for a badge or a status line is not the size for instructions. -->
        <ol v-if="steps.length > 0" class="flex list-decimal flex-col gap-2.5 pl-5 text-sm leading-relaxed break-words text-muted marker:text-subtle">
            <li v-for="(step, index) in steps" :key="index">
                <span v-for="(part, partIndex) in guideParts(step)" :key="partIndex" :class="part.literal ? literal : ''">{{ part.text }}</span>
            </li>
        </ol>

        <!-- The shortcut past step one, kept last: it is where the reader goes once they know what they are
             making, and a link above the instructions is one taken before they have been read. Absent until a
             self-hosted card's instance URL is filled in — until then there is no host to send anyone to. -->
        <a
            v-if="tokenUrl"
            :href="tokenUrl"
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1 border-t border-line pt-3 text-sm text-link hover:underline"
        >
            {{ linkLabel }} <Icon name="external-link" />
        </a>
    </div>
</template>
