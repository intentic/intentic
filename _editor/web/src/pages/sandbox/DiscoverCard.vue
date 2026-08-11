<script setup lang="ts">
import { BrandMark, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { checksOk, checksProblem, type DiscoverListing, splitListingName } from "./discoverListing";

/* ONE PUBLISHED EXTENSION, as a card in a grid — the same tile the "+" catalog is read as, on purpose.
 *
 * It used to be a line in a 160px scrolling box: a mark, a name, five glyphs and a truncated description, all
 * on one row. That shape works for a list of things the reader already knows the names of, and these are the
 * opposite — names nobody has seen, written by people nobody has heard of, where the description IS the row's
 * content and the marks are the only thing that can be scanned. So: the catalog's tile, at the catalog's
 * density, because "what could I add" is the same question in both places and should not have two answers.
 *
 * THE PUBLISHER IS ON ITS OWN LINE, under the name. `radarsu.paperwork` is one string to the daemon and two
 * facts to a reader — what it is, and whose it is — and the second one is most of how a stranger's extension
 * gets trusted or skipped. Printed as one dotted token it reads as neither.
 *
 * THE BUTTON SAYS THE STATE. Install / Update / Installed / the reason it can't be — never a live-looking
 * control that does nothing, and never a dead one with no explanation. */

const { listing } = defineProps<{ listing: DiscoverListing }>();

const emit = defineEmits<{ open: [] }>();

const name = computed(() => splitListingName(listing.entry.name));
const problem = computed(() => checksProblem(listing.entry));
const loads = computed(() => checksOk(listing.entry));
const dim = computed(() => listing.state.kind === `blocked` || listing.state.kind === `unavailable`);
</script>

<template>
    <!-- The WHOLE tile opens the listing, including when the listing can't be installed: a blocked row is the
         one a reader most needs to be able to read, and hiding its detail behind a dead button would be the
         second time this surface told them nothing. -->
    <button
        type="button"
        class="flex h-full w-full flex-col gap-2 rounded-lg border border-line bg-card px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-overlay"
        @click="emit(`open`)"
    >
        <div class="flex w-full items-start gap-2.5">
            <BrandMark :size="28" :name="listing.entry.name" :logo="listing.entry.logo" :icon="listing.entry.icon" :idle="dim" />
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-1.5">
                    <span class="truncate text-sm font-semibold text-content">{{ name.title }}</span>
                    <!-- Verified is the only trust badge that gets said out loud. Badging "listed" too would
                         dress the honest default up as a review, which is the one thing this surface must not
                         do — see the section captions above the grid. -->
                    <Icon
                        v-if="listing.entry.trust === `verified`"
                        name="shield"
                        class="shrink-0 text-success"
                        v-tooltip.top="listing.entry.trustReason ?? `Someone here read the source at the listed commit`"
                        aria-label="Verified"
                    />
                    <!-- The price, before the click. -->
                    <span
                        v-if="listing.entry.tier === `premium`"
                        class="shrink-0 rounded-sm bg-overlay px-1 text-2xs font-medium text-primary-500"
                        v-tooltip.top="`Premium — needs an intentic membership; its use pays its creator from the pool`"
                        >Premium</span
                    >
                </div>
                <div v-if="name.publisher !== ``" class="truncate text-2xs text-subtle">{{ name.publisher }}</div>
            </div>
        </div>

        <!-- Two lines, clamped. The tile is a quarter of a pane and a row is as tall as its tallest card, so one
             author's paragraph must not inflate the three beside it. -->
        <p v-if="listing.entry.description" class="line-clamp-2 text-2xs leading-relaxed text-muted">{{ listing.entry.description }}</p>
        <p v-else class="text-2xs text-subtle italic">No description published.</p>

        <!-- The signal strip: evidence and popularity, glyph-first, each with its sentence on hover. Silent
             where there is nothing to say — an absent scan is not a warning, and a listing with no stars is
             every listing for its first few months. -->
        <div class="mt-auto flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 pt-0.5">
            <span
                v-if="loads"
                class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-success"
                v-tooltip.top="`Re-checked at this exact commit by the registry's nightly scan`"
            >
                <Icon name="check" />loads
            </span>
            <span v-else-if="problem" class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-warning" v-tooltip.top="problem">
                <Icon name="exclamation-triangle" />won't load
            </span>
            <span v-if="listing.entry.stars !== undefined" class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle">
                <Icon name="star" />{{ listing.entry.stars }}
            </span>
            <span v-if="listing.entry.version" class="shrink-0 text-2xs text-subtle">{{ listing.entry.version }}</span>

            <!-- Right-aligned, always last, always the same place down the column: the one thing a reader
                 scanning a grid of unfamiliar names is actually looking for is which ones they can act on. -->
            <span class="ml-auto shrink-0">
                <StatusBadge v-if="listing.state.kind === `installed`" size="xs" variant="success" :dot="true" label="installed" />
                <StatusBadge v-else-if="listing.state.kind === `update`" size="xs" variant="info" label="update" />
                <StatusBadge v-else-if="listing.state.kind === `blocked`" size="xs" variant="danger" label="blocked" />
                <span v-else-if="listing.state.kind === `unavailable`" class="text-2xs text-subtle" v-tooltip.top="listing.state.reason">
                    can't install
                </span>
                <span v-else class="text-2xs font-medium text-link">Install →</span>
            </span>
        </div>
    </button>
</template>
