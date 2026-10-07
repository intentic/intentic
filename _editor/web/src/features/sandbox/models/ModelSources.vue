<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract";
import { DisclosureRow, Row, RowGroup, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { type ComponentPublicInstance, nextTick, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import type { ModelSource, ModelSourceStanding } from "./modelSources";
import ProviderAccounts from "./ProviderAccounts.vue";

// CONNECTED, at the top of Sandbox ▸ Models once anything is: every source this sandbox can run a model on, one row
// each, what needs a person first (modelSources.ts). A provider's row opens in place onto its accounts (ProviderAccounts);
// a model on this machine or an endpoint is managed on its capability card, so its row says where.

const t = useT();

const { sources, live, focus } = defineProps<{
    sources: readonly ModelSource[];
    // The provider whose sign-in is in flight in the page's card, so its rows stop offering another.
    live?: AgentProvider;
    // A provider a link named (`?provider=` for one already connected): opened and brought into view on arrival.
    focus?: AgentProvider;
}>();
const emit = defineEmits<{ connect: [provider: AgentProvider, request: { via: `native` | `routed`; variant?: string }] }>();

// One dot per standing, the same four tones ConnectionRow draws for an account, so the summary and the rows under it
// agree on what a colour means.
const DOT = {
    attention: `bg-warning`,
    blocked: `bg-danger`,
    ready: `bg-success`,
    waiting: `bg-content/25`,
} as const satisfies Record<ModelSourceStanding, string>;

// Which rows are open. Ones that need a person open by themselves the first time they are seen: the fix is the reason
// to be here, and a closed row that says "sign in again" would only cost a press to reach the button that does it.
const open = ref<ReadonlySet<AgentProvider>>(new Set());
const seen = new Set<AgentProvider>();
watch(
    () => sources,
    (now) => {
        const opened = new Set(open.value);
        for (const source of now) {
            if (!seen.has(source.provider) && (source.standing === `attention` || source.provider === focus) && source.kind === `account`) {
                opened.add(source.provider);
            }
            seen.add(source.provider);
        }
        open.value = opened;
    },
    { immediate: true },
);
const toggle = (provider: AgentProvider, now: boolean): void => {
    const next = new Set(open.value);
    if (now) {
        next.add(provider);
    } else {
        next.delete(provider);
    }
    open.value = next;
};

// The row a link named, in view once the list has drawn it.
const rows = new Map<AgentProvider, Element>();
const keep = (provider: AgentProvider, element: Element | ComponentPublicInstance | null): void => {
    if (element instanceof Element) {
        rows.set(provider, element);
    } else {
        rows.delete(provider);
    }
};
watch(
    () => focus,
    async (provider) => {
        if (provider === undefined) {
            return;
        }
        toggle(provider, true);
        await nextTick();
        rows.get(provider)?.scrollIntoView?.({ block: `nearest` });
    },
    { immediate: true },
);
</script>

<template>
    <RowGroup :label="t(`connect.modelSources.title`)">
        <template v-for="source in sources" :key="source.provider">
            <div :ref="(element) => keep(source.provider, element)" :data-source="source.provider">
                <DisclosureRow
                    v-if="source.kind === `account`"
                    body="drawer"
                    :open="open.has(source.provider)"
                    @update:open="(now: boolean) => toggle(source.provider, now)"
                >
                    <template #lead="{ mark }">
                        <span class="relative flex shrink-0 items-center justify-center text-base text-muted" :style="{ width: `${mark}px` }">
                            <ProviderLogo :provider="source.provider" />
                            <span
                                class="absolute -bottom-0.5 right-0 h-2 w-2 rounded-full ring-2 ring-card"
                                :class="DOT[source.standing]"
                                aria-hidden="true"
                            />
                        </span>
                    </template>
                    <template #title>
                        <span class="flex min-w-0 items-baseline gap-2">
                            <span class="truncate">{{ source.label }}</span>
                            <span class="min-w-0 truncate text-2xs font-normal text-subtle" v-tooltip.overflow="source.summary">{{
                                source.summary
                            }}</span>
                        </span>
                    </template>
                    <template v-if="source.line" #description>
                        <span :class="source.standing === `attention` ? `text-warning` : source.standing === `blocked` ? `text-danger` : ``">{{
                            source.line
                        }}</span>
                    </template>
                    <template #below>
                        <!-- Its own surface, so a provider's accounts read as belonging to its row rather than as more providers. -->
                        <div class="overflow-hidden rounded-xl border border-line-subtle bg-canvas/40">
                            <ProviderAccounts
                                :provider="source.provider"
                                :live="live === source.provider"
                                @connect="(request) => emit(`connect`, source.provider, request)"
                            />
                        </div>
                    </template>
                </DisclosureRow>

                <!-- A model on this machine, an endpoint, the trial: one fact each, managed where it was made. -->
                <Row v-else>
                    <template #lead="{ mark }">
                        <span class="relative flex shrink-0 items-center justify-center text-base text-muted" :style="{ width: `${mark}px` }">
                            <ProviderLogo :provider="source.provider" />
                            <span
                                class="absolute -bottom-0.5 right-0 h-2 w-2 rounded-full ring-2 ring-card"
                                :class="DOT[source.standing]"
                                aria-hidden="true"
                            />
                        </span>
                    </template>
                    <template #title>
                        <span class="flex min-w-0 items-baseline gap-2">
                            <span class="truncate">{{ source.label }}</span>
                            <span class="min-w-0 truncate text-2xs font-normal text-subtle">{{ source.summary }}</span>
                        </span>
                    </template>
                    <template v-if="source.line" #description>{{ source.line }}</template>
                    <template v-if="source.manage" #control>
                        <RouterLink :to="source.manage" :class="ui.linkButton(`text-xs`)">{{ t(`connect.modelSources.manage`) }}</RouterLink>
                    </template>
                </Row>
            </div>
        </template>
    </RowGroup>
</template>
