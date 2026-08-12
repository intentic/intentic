<!-- THE PLUGIN MARKETPLACE, resolved into the form below it.
     Point this at a registry repository and it lists what that registry publishes; picking a row fills in the
     url, commit and path the install form would otherwise ask a person to copy by hand.

     PLUGINS ONLY, now. It used to serve the extension card too, and that was the whole of extension discovery in
     this product: a collapsed block on a form, five clicks from the rail, presented as a way to pre-fill a text
     field. Extensions have a surface of their own (the Sandbox screen's Discover row), and that card links to it
     rather than growing a second, worse copy of it. What stays here is a genuinely different object — a plugin
     loads into the agent rather than running in this browser, its registries are usually somebody else's, and
     its install form is the one below. -->
<script setup lang="ts">
import { isShaPinned, type RegistryEntry } from "@intentic/registry";
import type { Marketplace } from "@intentic-app/api-contract";
import type { CapabilityKind } from "@intentic/sandbox-contract";
import { BrandMark, cmp, type NoticeModel, RowGroup } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { browseMarketplace } from "../composables/extensions/useCapabilities";
import { formatCredits } from "../composables/membership/creditMeter";
import { useMembership } from "../composables/membership/useMembership";
import { checksOk, checksProblem } from "../pages/sandbox/discoverListing";

/** What this card installs — the rows of any other kind are not its to offer. */
const props = defineProps<{ kind: CapabilityKind }>();

/* A premium row's price, from the platform rather than from a sentence typed here — the same figure the
 * extension catalogue quotes, since it is the same donation. This card only PRE-FILLS the install form, so the
 * spend is still a step away; naming the number here is what stops it being a surprise at the end of it. */
const { donationCredits } = useMembership();

const premiumHint = computed(() =>
    donationCredits.value > 0
        ? `Premium — installing pays its creator ${formatCredits(donationCredits.value)} credits from your daily allowance, once a month`
        : `Premium — needs an intentic membership; installing donates credits to its creator`,
);

const emit = defineEmits<{
    /** A row's install coordinates, ready for the form. */
    pick: [answers: { name: string; url: string; ref: string; path: string; token: string }];
    /** Why the browse failed, on the page's own notice — or null to clear it before a fresh attempt. */
    notice: [notice: NoticeModel | null];
}>();

const url = ref(``);
const token = ref(``);
const market = ref<Marketplace | null>(null);
const browsing = ref(false);

const browse = async (): Promise<void> => {
    if (url.value.trim().length === 0 || browsing.value) {
        return;
    }
    browsing.value = true;
    emit(`notice`, null);
    market.value = null;
    try {
        market.value = await browseMarketplace(url.value.trim(), token.value.trim() || undefined);
    } catch (err) {
        emit(`notice`, noticeFrom(err, `Could not browse the registry.`));
    } finally {
        browsing.value = false;
    }
};

// Only the rows this card can actually install: a registry serves plugins and extensions from one file, and
// offering an extension row on the plugin form would pre-fill a config the daemon then refuses.
const entries = computed<RegistryEntry[]>(() => market.value?.plugins.filter((entry) => entry.kind === props.kind) ?? []);

/* Why a row can't be clicked, in the words the reader needs — the button is disabled either way, and a disabled
 * row with no reason reads as a broken page. Blocked leads: it is the one case where the entry is fine
 * mechanically and the answer is still no. The sha rule bites only extensions (their code runs trusted in this
 * browser), so a plugin row pinned to a branch stays installable. */
const blockedReason = (entry: RegistryEntry): string | undefined => {
    if (entry.trust === `blocked`) {
        return entry.trustReason ?? `blocked`;
    }
    if (entry.install === undefined) {
        return `not installable from here`;
    }
    if (entry.kind === `extension` && !isShaPinned(entry.install)) {
        return `no pinned commit`;
    }
    return undefined;
};

const pick = (entry: RegistryEntry): void => {
    const install = entry.install;
    if (install === undefined || blockedReason(entry) !== undefined) {
        return;
    }
    emit(`pick`, {
        name: entry.name.replaceAll(/[^a-zA-Z0-9_-]/g, `-`),
        url: install.url,
        ref: install.ref ?? ``,
        path: install.path ?? ``,
        // Code hosted inside a private registry repo needs the same token to clone.
        token: install.url === url.value.trim() ? token.value.trim() : ``,
    });
};
</script>

<template>
    <RowGroup label="From a registry (optional)">
        <div class="flex flex-col gap-2 px-4 py-3">
            <div class="flex gap-2">
                <input v-model="url" placeholder="https://github.com/owner/registry" :class="cmp.input('min-w-0 flex-1')" />
                <input v-model="token" type="password" autocomplete="off" placeholder="Token" :class="cmp.input('w-28')" />
                <Button label="Browse" size="small" :disabled="url.trim().length === 0 || browsing" :loading="browsing" @click="browse" />
            </div>
            <div v-if="market" class="scrollbar-thin flex max-h-40 flex-col gap-0.5 overflow-auto">
                <button
                    v-for="entry in entries"
                    :key="entry.name"
                    type="button"
                    class="flex items-center gap-2 rounded-md bg-canvas px-2.5 py-1.5 text-left text-xs transition-colors enabled:hover:bg-overlay disabled:opacity-50"
                    :disabled="blockedReason(entry) !== undefined"
                    @click="pick(entry)"
                >
                    <!-- The mark the registry carries, which for most rows is the extension's own initials: these
                         are names nobody has seen before, and a column of marks is the only thing here that can
                         be scanned without reading. -->
                    <BrandMark :size="20" :name="entry.name" :logo="entry.logo" :icon="entry.icon" />
                    <!-- Verified is the only badge: it is the one state a human asserted, and badging "listed"
                         too would dress the honest default up as a review. -->
                    <Icon v-if="entry.trust === 'verified'" name="shield" class="shrink-0 text-success" title="Verified" />
                    <span class="font-medium text-content">{{ entry.name }}</span>
                    <!-- The price, before the click: a premium row needs a membership to install, and its
                         retained use is what pays its creator from the pool. -->
                    <span
                        v-if="entry.tier === 'premium'"
                        class="shrink-0 rounded-sm bg-overlay px-1 text-2xs font-medium text-primary-500"
                        v-tooltip.top="premiumHint"
                        >Premium</span
                    >
                    <span v-if="entry.version" class="text-2xs text-subtle">{{ entry.version }}</span>
                    <!-- Evidence, not endorsement: the nightly scan re-read this row's pinned commit and found
                         (or didn't) a thing that loads. Silent when there are no checks at all — absence of
                         evidence is not a warning. -->
                    <Icon
                        v-if="checksOk(entry)"
                        name="check"
                        class="shrink-0 text-success"
                        v-tooltip.top="`Loads — re-checked at the pinned commit by the registry's nightly scan`"
                    />
                    <Icon
                        v-else-if="checksProblem(entry)"
                        name="exclamation-triangle"
                        class="shrink-0 text-warning"
                        v-tooltip.top="checksProblem(entry)"
                    />
                    <span v-if="entry.stars !== undefined" class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle">
                        <Icon name="star" />{{ entry.stars }}
                    </span>
                    <span class="min-w-0 truncate text-2xs text-muted">{{ entry.description }}</span>
                    <span
                        v-if="blockedReason(entry)"
                        :class="['ml-auto shrink-0 text-2xs', entry.trust === 'blocked' ? 'text-danger' : 'text-subtle']"
                    >
                        {{ blockedReason(entry) }}
                    </span>
                </button>
            </div>
            <p v-if="market && entries.length === 0" class="text-2xs text-subtle">That registry lists no plugins.</p>
        </div>
    </RowGroup>
</template>
