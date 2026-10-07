<script setup lang="ts">
import { endpointIdOf, isTrialProvider, type LocalModelFitResponse } from "@intentic/sandbox-contract";
import { Button, Icon, RowGroup, RowNote, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { z } from "zod";
import { RouterLink } from "vue-router";
import { endpointProviders } from "../../chat/accounts/providerCatalog";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import ConnectionRow from "../secrets/ConnectionRow.vue";
import HostServerRows from "./HostServerRows.vue";
import LocalModelLane from "./LocalModelLane.vue";

// LOCAL MODELS, opened from its tile in Sandbox ▸ Models' grid: the models this sandbox runs itself and the servers it is
// pointed at, in one card. What it already has first (a server, an API key, a model added from its capability card),
// then the servers already running on the computer hosting the sandbox, one press from being used (HostServerRows, where
// a GPU model comes from), then the two models sized for this machine's CPU (LocalModelLane), each an offer until taken
// and a status once it is, then the way to point at any other server. Those live here and nowhere else on the page:
// somebody running Ollama is somebody who chose to run models themselves.

const t = useT();

const { fit, landed } = defineProps<{
    fit: LocalModelFitResponse | undefined;
    // What just started serving here, in a sentence naming the sandbox it went to.
    landed?: string;
}>();
const emit = defineEmits<{ ready: [provider: string]; stopPrefetch: []; chat: [] }>();

const { capabilities } = useCapabilities();

// The models the lane below offers, which it also reports on once taken; listed above as well, they would be said twice.
const offered = computed(() => new Set([fit?.instant?.model, fit?.best?.model].filter((model): model is string => model !== undefined)));
// A capability's config is open-ended; the model it serves is read through a schema, not assumed.
const ModelConfigSchema = z.object({ model: z.string() });
const entryOf = (provider: string) => {
    const id = endpointIdOf(provider);
    return id === undefined ? undefined : (capabilities.value ?? []).find((entry) => entry.id === id);
};

// Everything else this sandbox runs a model on outside a provider's account: servers and keys, and local models the lane
// does not offer. The trial is the platform's, not the reader's, and is not managed here.
const held = computed(() =>
    endpointProviders.value
        .filter((endpoint) => !isTrialProvider(endpoint.id))
        .filter((endpoint) => {
            const config = ModelConfigSchema.safeParse(entryOf(endpoint.id)?.config);
            return endpoint.kind !== `localmodel` || !config.success || !offered.value.has(config.data.model);
        })
        .map((endpoint) => {
            const status = entryOf(endpoint.id)?.status;
            return {
                id: endpoint.id,
                label: endpoint.label,
                note: endpoint.kind === `localmodel` ? t(`connect.modelSources.local`) : t(`connect.modelSources.endpoint`),
                state:
                    status === undefined || status.state === `active`
                        ? (`connected` as const)
                        : status.state === `pending`
                          ? (`unknown` as const)
                          : (`blocked` as const),
                description: status !== undefined && status.state !== `active` ? status.detail : undefined,
                manage: endpoint.kind === `localmodel` ? `/capabilities/localmodel` : `/capabilities/endpoint`,
            };
        }),
);
</script>

<template>
    <RowGroup :label="t(`connect.providerGrid.local`)" :caption="t(`connect.connect.localSubtitle`)">
        <RowNote v-if="landed" variant="block">
            <div class="flex flex-wrap items-center gap-3">
                <Icon name="check" class="shrink-0 text-success" />
                <span class="min-w-0 flex-1 text-sm text-content">{{ landed }}</span>
                <Button size="small" :label="t(`connect.connect.startChatting`)" @click="emit(`chat`)" />
            </div>
        </RowNote>

        <ConnectionRow
            v-for="entry in held"
            :key="entry.id"
            :title="entry.label"
            :state="entry.state"
            :note="entry.note"
            :note-busy="entry.state === `unknown`"
            :description="entry.description"
        >
            <template #control>
                <RouterLink :to="entry.manage" :class="ui.linkButton(`text-xs`)">{{ t(`connect.modelSources.manage`) }}</RouterLink>
            </template>
        </ConnectionRow>

        <HostServerRows />

        <LocalModelLane :fit="fit" @ready="(provider) => emit(`ready`, provider)" @stop-prefetch="emit(`stopPrefetch`)" />

        <!-- The two ways past the curated pair, as one footer: the card that holds every other model, and,
             for somebody already running a server, the card that points at it. Named once, here, without a tour. -->
        <RowNote variant="block">
            <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                <RouterLink to="/capabilities/localmodel" :class="ui.linkButton(`text-xs`)">
                    <Icon name="sliders-h" class="text-2xs" />{{ t(`connect.localModelLane.moreModels`) }}<Icon name="arrow-right" class="text-2xs" />
                </RouterLink>
                <span class="flex flex-wrap items-center gap-x-2 text-muted">
                    <Icon name="server" class="text-2xs text-subtle" />{{ t(`connect.providerGrid.ownServer`) }}
                    <RouterLink to="/capabilities/endpoint" :class="ui.linkButton(`text-xs`)">
                        {{ t(`connect.providerGrid.pointAtServer`) }}<Icon name="arrow-right" class="text-2xs" />
                    </RouterLink>
                </span>
            </div>
        </RowNote>
    </RowGroup>
</template>
