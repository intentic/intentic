<script setup lang="ts">
import { BrandMark, StatusBadge, type Tip } from "@intentic/ui";
import { computed } from "vue";
import { checksOk, checksProblem, checksTip, type DiscoverListing, splitListingName } from "./discoverListing";
import { useT } from "@intentic/ui/i18n";

// One published extension, drawn as the same tile the catalog uses, at the same density: for names nobody knows yet,
// the description is the row's content, not a truncated afterthought. The publisher gets its own line (a separate trust
// fact from the name), and the button always states its own state rather than sitting dead or lying.

const t = useT();

const { listing, installing = false } = defineProps<{
    listing: DiscoverListing;
    /** Its install or update is running: the tile says so, since the dialog it was started from may be closed. */
    installing?: boolean;
}>();

const emit = defineEmits<{ open: [] }>();

const name = computed(() => splitListingName(listing.entry.name));
const problem = computed(() => checksProblem(listing.entry));
const loads = computed(() => checksOk(listing.entry));
const dim = computed(() => listing.state.kind === `blocked` || listing.state.kind === `unavailable`);

// What the scan and the audit came to, as hover cards: the commit a clean scan was run at, and the one fault that
// needs no sentence to be acted on (open the listing, read it, then decide).
const loadsTip = computed((): Tip => ({
    title: t(`sandbox.discoverCard.nightlyScan`),
    rows: [{ label: t(`sandbox.words.commit`), value: listing.entry.checks?.sha.slice(0, 7) ?? `` }],
}));
const unauditedTip = computed((): Tip => ({
    title: t(`sandbox.discoverCard.notAudited`),
    tone: `warn`,
    note: t(`sandbox.discoverCard.reviewBeforeInstall`),
}));
// The registry's own words for a verified listing where it gave some; ours, cut to what was done, where it did not.
const verifiedTip = computed(
    (): Tip | string => listing.entry.trustReason ?? { title: t(`sandbox.words.verified`), note: t(`sandbox.discoverCard.scannedAuditedRead`) },
);
// Why a listing can't be installed in one click, in two words: nowhere to clone from, or no exact commit to clone.
const unavailableTip = computed(() =>
    listing.entry.install === undefined ? t(`sandbox.discoverCard.cantClone`) : t(`sandbox.discoverCard.notPinned`),
);
</script>

<template>
    <!-- The whole tile opens the listing, even when blocked: that's the row a reader most needs to read. -->
    <button
        type="button"
        class="flex h-full w-full flex-col gap-2.5 rounded-xl bg-card shadow-sm p-3.5 text-left transition-colors hover:bg-overlay sm:p-4"
        @click="emit(`open`)"
    >
        <div class="flex w-full items-start gap-2.5">
            <BrandMark
                :size="28"
                :name="listing.entry.name"
                :art="listing.entry.art"
                :logo="listing.entry.logo"
                :icon="listing.entry.icon"
                :idle="dim"
            />
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-1.5">
                    <span class="truncate text-sm font-semibold text-content">{{ name.title }}</span>
                    <!-- The only trust badge said out loud: badging 'listed' too would dress the honest default up as a review. -->
                    <Icon
                        v-if="listing.entry.trust === `verified`"
                        name="shield"
                        class="shrink-0 text-success"
                        v-tooltip.top="verifiedTip"
                        :aria-label="t(`sandbox.words.verified`)"
                    />
                </div>
                <div v-if="name.publisher !== ``" class="truncate text-2xs text-subtle">{{ name.publisher }}</div>
            </div>
        </div>

        <!-- Clamped to two lines: the tile is a quarter of a pane, and one author's paragraph can't inflate the row. -->
        <p v-if="listing.entry.description" class="line-clamp-2 text-2xs leading-relaxed text-muted">{{ listing.entry.description }}</p>
        <p v-else class="text-2xs text-subtle italic">{{ t(`sandbox.discoverCard.noDescriptionPublished`) }}</p>

        <!-- Silent where there's nothing to say: an absent scan isn't a warning, and no stars just means a new listing. -->
        <div class="mt-auto flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 pt-0.5">
            <span v-if="loads" class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-success" v-tooltip.top="loadsTip">
                <Icon name="check" />{{ t(`sandbox.discoverCard.loads`) }}
            </span>
            <span
                v-else-if="problem"
                class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-warning"
                v-tooltip.top="checksTip(listing.entry)"
            >
                <Icon name="exclamation-triangle" />{{ t(`sandbox.discoverCard.wontLoad`) }}
            </span>
            <span v-if="listing.entry.stars !== undefined" class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle">
                <Icon name="star" />{{ listing.entry.stars }}
            </span>
            <span v-if="listing.entry.version" class="shrink-0 text-2xs text-subtle">{{ listing.entry.version }}</span>

            <!-- Right-aligned and always last: the one thing a reader scanning unfamiliar names is looking for. -->
            <span class="ml-auto shrink-0">
                <span v-if="installing" class="inline-flex items-center gap-1 text-2xs font-medium text-muted" role="status">
                    <Icon name="spinner" spin />{{
                        listing.state.kind === `update` ? t(`sandbox.discoverCard.updating`) : t(`sandbox.discoverCard.installing`)
                    }}
                </span>
                <StatusBadge
                    v-else-if="listing.state.kind === `installed`"
                    size="xs"
                    variant="success"
                    :dot="true"
                    :label="t(`sandbox.discoverCard.installed`)"
                />
                <StatusBadge
                    v-else-if="listing.state.kind === `update`"
                    size="xs"
                    :variant="listing.state.unaudited ? `warning` : `info`"
                    :label="listing.state.unaudited ? t(`sandbox.discoverCard.unauditedUpdate`) : t(`sandbox.discoverCard.update`)"
                    v-tooltip.top="listing.state.unaudited ? unauditedTip : undefined"
                />
                <StatusBadge v-else-if="listing.state.kind === `blocked`" size="xs" variant="danger" :label="t(`shared.blocked`)" />
                <span v-else-if="listing.state.kind === `unavailable`" class="text-2xs text-subtle" v-tooltip.top="unavailableTip">
                    {{ t(`sandbox.discoverCard.cantInstall`) }}
                </span>
                <span
                    v-else-if="listing.state.unaudited"
                    class="inline-flex items-center gap-0.5 text-2xs font-medium text-warning"
                    v-tooltip.top="unauditedTip"
                >
                    <Icon name="exclamation-triangle" />{{ t(`sandbox.discoverCard.unaudited`) }}
                </span>
                <span v-else class="text-2xs font-medium text-link">{{ t(`sandbox.discoverCard.install`) }}</span>
            </span>
        </div>
    </button>
</template>
