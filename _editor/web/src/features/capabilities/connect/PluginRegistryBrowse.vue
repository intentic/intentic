<!--
    Lists what a plugin registry repository publishes; picking a row fills the url, commit and path fields of the install form below it. Plugins only
    — extension discovery lives on the Sandbox screen's Discover row, not here.
-->
<script setup lang="ts">
import { isShaPinned, type RegistryEntry } from "@intentic/registry";
import type { Marketplace } from "@intentic/api-contract";
import type { CapabilityKind } from "@intentic/sandbox-contract";
import { BrandMark, Button, type NoticeModel, RowGroup, RowNote, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { browseMarketplace } from "./useCapabilities";
import { checksOk, checksProblem } from "../../sandbox/extensions/discoverListing";

/** What this card installs: the rows of any other kind are not its to offer. */
const props = defineProps<{ kind: CapabilityKind }>();

const emit = defineEmits<{
    /** A row's install coordinates, ready for the form. */
    pick: [answers: { name: string; url: string; ref: string; path: string; token: string }];
    /** Why the browse failed, on the page's own notice, or null to clear it before a fresh attempt. */
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

// Only rows this card can install: a registry serves plugins and extensions from one file, and the daemon refuses a
// mismatched kind.
const entries = computed<RegistryEntry[]>(() => market.value?.plugins.filter((entry) => entry.kind === props.kind) ?? []);

// Why a row can't be clicked, since a disabled row with no reason reads as broken. Blocked leads; the sha-pinned
// rule bites only extensions, since their code runs trusted in this browser.
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
        <RowNote variant="block">
            <div class="flex flex-col gap-2">
                <div class="flex gap-2">
                    <input v-model="url" placeholder="https://github.com/owner/registry" :class="ui.input('min-w-0 flex-1')" />
                    <input v-model="token" type="password" autocomplete="off" placeholder="Token" :class="ui.input('w-28')" />
                    <Button label="Browse" size="small" :disabled="url.trim().length === 0 || browsing" :loading="browsing" @click="browse" />
                </div>
                <div v-if="market" class="scrollbar-thin flex max-h-40 flex-col gap-0.5 overflow-auto">
                    <button
                        v-for="entry in entries"
                        :key="entry.name"
                        type="button"
                        class="ui-off flex items-center gap-2 rounded-md bg-canvas px-2.5 py-1.5 text-left text-xs transition-colors enabled:hover:bg-overlay"
                        :disabled="blockedReason(entry) !== undefined"
                        @click="pick(entry)"
                    >
                        <!--
                            Registry's own mark (usually the extension's initials); a column of them is scannable
                            without reading unfamiliar
                            names.
                        -->
                        <BrandMark :size="20" :name="entry.name" :art="entry.art" :logo="entry.logo" :icon="entry.icon" />
                        <!--
                            Verified is the only badge: the one state a human actually asserted, unlike the default
                            "listed".
                        -->
                        <Icon v-if="entry.trust === 'verified'" name="shield" class="shrink-0 text-success" title="Verified" />
                        <span class="font-medium text-content">{{ entry.name }}</span>
                        <span v-if="entry.version" class="text-2xs text-subtle">{{ entry.version }}</span>
                        <!--
                            Evidence, not endorsement: the nightly scan re-checked this pinned commit and loaded it (or
                            didn't); silent when
                            there's no check at all.
                        -->
                        <Icon
                            v-if="checksOk(entry)"
                            name="check"
                            class="shrink-0 text-success"
                            v-tooltip.top="`Loads: re-checked at the pinned commit by the registry's nightly scan`"
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
        </RowNote>
    </RowGroup>
</template>
