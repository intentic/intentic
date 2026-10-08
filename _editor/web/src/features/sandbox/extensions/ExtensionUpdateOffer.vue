<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { Button, Notice, StatusBadge, timeAgo, toneTint, ui, useAsyncAction } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import ActionLink from "../../../components/ActionLink.vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { useAgents } from "../../agents/fleet/useAgents";
import { useHubWork } from "../../../workbench/hub/hubWork";
import { router } from "../../../router";
import { updateBrief } from "./extensionBrief";
import { useExtensionUpdates } from "./useExtensionUpdates";
import { useT } from "@intentic/ui/i18n";

// What an open row says about its installed version before anything else, so it leads the drawer: a registry advisory,
// an update that came up wrong, then the update on offer. The offer is named for the row's `update` pill, so the pill
// and the thing to press are one idea, and it is two clicks on purpose: Review stages the powers diff, then the confirm
// is labelled by what that found. The standing policy lives in the drawer's Updates section, not here.

const t = useT();

const { extension, anchor } = defineProps<{
    extension: ExtensionSummary;
    /** The offer box's id, so the row's pill can bring the reader straight to it. */
    anchor: string;
}>();

const { previewUpdate, apply: applyUpdate, revert: revertUpdate } = useExtensionUpdates();
const hubWork = useHubWork();
const { busy, notice, run } = useAsyncAction();

const offer = computed(() => extension.update);
const unhealthy = computed(() => (extension.health?.state === `unhealthy` ? extension.health : undefined));
const short = (ref_: string): string => ref_.slice(0, 7);

// The staged read behind the first click; dropped whenever the offer it describes changes.
const preview = ref<Awaited<ReturnType<typeof previewUpdate>>>();
watch(
    () => offer.value?.ref,
    () => {
        preview.value = undefined;
        notice.value = undefined;
    },
);

// A release can keep its version string and still be new code; the commit is then the only thing telling them apart.
const sameVersion = computed(() => offer.value?.version !== undefined && offer.value.version === extension.manifest.version);
const fromLabel = computed(() =>
    sameVersion.value ? `v${extension.manifest.version} · ${short(extension.commit)}` : `v${extension.manifest.version}`,
);
const toLabel = computed(() => {
    const current = offer.value;
    if (current === undefined) {
        return ``;
    }
    if (current.version === undefined) {
        return short(current.ref);
    }
    return sameVersion.value ? `v${current.version} · ${short(current.ref)}` : `v${current.version}`;
});

const added = computed(() => preview.value?.powers.added ?? []);
// The confirm is named for what it means: growing powers makes it an approval, not a refresh.
const confirmLabel = computed(() => {
    if (added.value.length > 0) {
        return t(`sandbox.extensionUpdateOffer.approvePowersUpdate`);
    }
    const current = offer.value;
    const target = current?.version === undefined || sameVersion.value ? short(current?.ref ?? ``) : `v${current.version}`;
    return t(`sandbox.extensionUpdateOffer.updateTo`, { version: target });
});

const failed = (): string => t(`sandbox.extensionUpdateOffer.didntWork`);

const stage = (): Promise<void> =>
    run(async () => {
        preview.value = await previewUpdate(extension.id);
    }, failed());

// Applying reloads the host so this browser runs the new code (useExtensionUpdates). A pending image rebuild is
// reported, not implied away.
const rebuildNote = ref(false);
const apply = (): Promise<void> =>
    run(
        () =>
            // Fetching the new code and reconciling it takes longer than a click, so the Extensions row says so.
            hubWork.track(t(`sandbox.extensionUpdateOffer.updating`, { id: extension.id }), async () => {
                const applied = await applyUpdate(extension.id, preview.value?.ref);
                rebuildNote.value = applied.rebuildNeeded === true;
                preview.value = undefined;
            }),
        failed(),
    );

const revert = (): Promise<void> => run(() => revertUpdate(extension.id), failed());

// Links a finished agent diff-read when the policy already ran one, offers to start one otherwise; an unregistered
// conversation still resolves by id through the chat route.
const reviewAt = (conversationId: string): string => `/agents/${encodeURIComponent(conversationId)}`;
const openReview = (conversationId: string): void => {
    const { agentById, open } = useAgents();
    const agent = agentById(conversationId);
    if (agent !== undefined) {
        open(agent);
    } else {
        void router.push(reviewAt(conversationId));
    }
};
const readDiff = (): void => {
    const current = offer.value;
    if (current === undefined) {
        return;
    }
    startAgent(
        updateBrief({
            label: extensionIdOf(extension.manifest),
            url: current.url,
            fromRef: extension.commit,
            toRef: current.ref,
            path: current.path ?? ``,
        }),
    );
};

const advisoryState = computed(() => {
    if (extension.advisory?.autoDisabled === true) {
        return t(`sandbox.extensionUpdateOffer.switchedOffAutomaticallySwitch`);
    }
    return extension.enabled ? t(`sandbox.extensionUpdateOffer.stillRunningBecauseAdvisory`) : t(`sandbox.extensionUpdateOffer.switchedOff`);
});

// Renders nothing at all for the ordinary installed extension, so the drawer leads with its sections instead of a gap.
const shown = computed(
    () =>
        extension.advisory !== undefined ||
        unhealthy.value !== undefined ||
        offer.value !== undefined ||
        rebuildNote.value ||
        notice.value !== undefined,
);
</script>

<template>
    <div v-if="shown" class="flex flex-col gap-2.5">
        <!-- Stays until the registry unblocks the listing: an advisory is a standing fact, not a notice to dismiss. -->
        <Notice v-if="extension.advisory" tone="danger" size="sm">
            <span class="block font-medium">{{ t(`sandbox.extensionUpdateOffer.blockedByRegistry`) }}</span>
            <span class="mt-0.5 block text-content">{{ extension.advisory.reason }}</span>
            <span class="mt-1 block text-muted">{{ advisoryState }}</span>
        </Notice>

        <!-- Healthy is silent; only a verdict worth acting on takes space here. -->
        <Notice v-if="unhealthy" tone="warning" size="sm">
            <span class="block font-medium">
                {{
                    unhealthy.autoReverted ? t(`sandbox.extensionUpdateOffer.updateCameUpWrong`) : t(`sandbox.extensionUpdateOffer.updateIsntHealthy`)
                }}
            </span>
            <span v-if="unhealthy.detail" class="mt-0.5 block text-content">{{ unhealthy.detail }}</span>
            <template v-if="unhealthy.autoReverted !== true && extension.previous" #actions>
                <Button
                    size="small"
                    tone="warning"
                    :label="t(`sandbox.extensionUpdateOffer.revertTo`, { ref: short(extension.previous.ref) })"
                    :loading="busy"
                    @click="revert"
                >
                    <template #icon><Icon name="undo" /></template>
                </Button>
            </template>
        </Notice>

        <!-- The offer, under the same name as the row's pill. A security fix wears the danger tone the pill does. -->
        <div v-if="offer" :id="anchor" class="rounded-lg border px-3 py-2.5" :class="toneTint(offer.securityFix ? `danger` : `info`, `soft`)">
            <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <Icon
                    :name="offer.securityFix ? `shield` : `arrow-circle-up`"
                    class="shrink-0"
                    :class="offer.securityFix ? `text-danger` : `text-info`"
                    aria-hidden="true"
                />
                <span class="text-xs font-medium" :class="offer.securityFix ? `text-danger` : `text-content`">
                    {{
                        offer.securityFix
                            ? t(`sandbox.extensionUpdateOffer.securityUpdateAvailable`)
                            : t(`sandbox.extensionUpdateOffer.updateAvailable`)
                    }}
                </span>
                <span class="text-xs tabular-nums text-muted">
                    {{ fromLabel }} <span class="text-subtle">→</span> <span class="font-medium text-content">{{ toLabel }}</span>
                </span>
                <StatusBadge
                    :variant="offer.trust === `verified` ? `success` : `neutral`"
                    :label="
                        offer.trust === `verified`
                            ? t(`sandbox.extensionUpdateOffer.verified`)
                            : t(`sandbox.extensionUpdateOffer.listedNoHumanReview`)
                    "
                    size="xs"
                />
                <span class="text-2xs text-subtle">{{ t(`sandbox.extensionUpdateOffer.listed`, { at: timeAgo(Date.parse(offer.at)) }) }}</span>
            </div>
            <!-- Why the unattended rung didn't take it: the reason the click is the owner's. -->
            <p v-if="offer.needsReview" class="mt-1.5 text-2xs text-muted">
                {{ t(`sandbox.extensionUpdateOffer.heldReview`, { needsReview: offer.needsReview }) }}
            </p>

            <!-- The staged read: what the next click would approve, mechanically. -->
            <div v-if="preview" class="mt-2.5 flex flex-col gap-1.5 border-t border-line pt-2.5">
                <p v-if="!preview.compatible" class="text-2xs text-warning">
                    {{ t(`sandbox.extensionUpdateOffer.asksAppAppCant`, { engines: preview.engines }) }}
                </p>
                <template v-if="added.length > 0">
                    <p class="text-2xs font-medium text-warning">{{ t(`sandbox.extensionUpdateOffer.newPowersVersionAsks`) }}</p>
                    <ul class="flex flex-col gap-0.5">
                        <li v-for="power in added" :key="power" class="text-2xs text-content">+ {{ power }}</li>
                    </ul>
                </template>
                <p v-else class="text-2xs text-success">{{ t(`sandbox.extensionUpdateOffer.samePowersInstalledVersion`) }}</p>
                <ul v-if="preview.powers.removed.length > 0" class="flex flex-col gap-0.5">
                    <li v-for="power in preview.powers.removed" :key="power" class="text-2xs text-subtle">− {{ power }}</li>
                </ul>
                <p v-if="preview.powers.unchanged.length > 0" class="text-2xs text-subtle">
                    {{ t(`sandbox.extensionUpdateOffer.unchanged`, { count: preview.powers.unchanged.length }) }}
                </p>
            </div>

            <div class="mt-2.5 flex flex-wrap items-center gap-2">
                <Button v-if="!preview" size="small" :loading="busy" :label="t(`sandbox.extensionUpdateOffer.reviewUpdate`)" @click="stage" />
                <template v-else>
                    <Button size="small" :tone="added.length > 0 ? `warning` : undefined" :loading="busy" :label="confirmLabel" @click="apply" />
                    <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" :disabled="busy" @click="preview = undefined" />
                </template>
                <ActionLink
                    v-if="offer.review"
                    :to="reviewAt(offer.review.conversationId)"
                    :class="ui.textButton({ size: `xs` })"
                    @activate="openReview(offer.review.conversationId)"
                >
                    {{ t(`sandbox.extensionUpdateOffer.agentAlreadyReadDiff`) }}
                </ActionLink>
                <Button
                    v-else-if="!preview"
                    size="small"
                    tier="boring"
                    :label="t(`sandbox.extensionUpdateOffer.agentReadDiffFirst`)"
                    @click="readDiff"
                >
                    <template #icon><Icon name="sparkles" /></template>
                </Button>
            </div>
        </div>

        <Notice v-if="rebuildNote" tone="warning" size="sm">{{ t(`sandbox.extensionUpdateOffer.updateExtendsSandboxImage`) }}</Notice>
        <Notice v-if="notice" :of="notice" size="sm" />
    </div>
</template>
