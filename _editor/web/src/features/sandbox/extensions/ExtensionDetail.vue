<script setup lang="ts">
import { extensionApiVersion, satisfiesEngines } from "@intentic/extension-api";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { Button, Notice, type NoticeTone, Row, RowGroup, RowNote, StatusBadge, type StatusVariant } from "@intentic/ui";
import { computed } from "vue";
import type { ExtensionEntry } from "../../extensions/useExtensionList";
import ExtensionPlaces from "./detail/ExtensionPlaces.vue";
import ExtensionPublishing from "./detail/ExtensionPublishing.vue";
import ExtensionReach from "./detail/ExtensionReach.vue";
import { routesOf } from "./detail/extensionRoutes";
import ProfileLayout, { type ProfileStat } from "./detail/ProfileLayout.vue";
import { devLineOf } from "./extensionDev";
import ExtensionSettingsForm from "./ExtensionSettingsForm.vue";
import ExtensionSwitch from "./ExtensionSwitch.vue";
import ExtensionUpdateOffer from "./ExtensionUpdateOffer.vue";
import ExtensionUpdatePolicy from "./ExtensionUpdatePolicy.vue";
import { useT } from "@intentic/ui/i18n";

// One installed extension, opened where the Installed list stood. Its card says who it is with its switch beside the
// name, since on and off is the verb for the whole of it, and answers at a glance whether it works, what it may reach,
// how it updates, whether it fits this app and which build runs. What is wrong or waiting runs the full width under
// that. Below, what the reader sets (settings, update policy), what it may reach, publishing, and last, removing it, on
// one side; where it shows up in the editor on the other, first on a narrow pane.

const t = useT();

// `manage` is whether this reader may change it. Below maintainer the page is a record: what it is, where it shows up and
// what it may reach, with none of the switch, settings, updates or removal the daemon would refuse them.
const { entry, pending, manage } = defineProps<{ entry: ExtensionEntry; pending: boolean; manage: boolean }>();

// Each verb names the extension it acts on, so the list that owns the verbs needs no handle on which page is open.
const emit = defineEmits<{
    toggle: [extension: ExtensionSummary, enabled: boolean];
    remove: [extension: ExtensionSummary];
    devClear: [extension: ExtensionSummary];
    back: [];
}>();

const manifest = computed(() => entry.extension.manifest);
const settings = computed(() => manifest.value.contributes?.settings ?? []);
const installed = computed(() => entry.extension.source === `installed`);
const workspace = computed(() => entry.extension.source === `workspace`);

// Where it runs from when that is not its pinned copy (extensionDev.ts).
const dev = computed(() => entry.extension.dev);
const devLine = computed(() => devLineOf(entry.extension));

// The host's explanation in its own tone where it ranked one; anything it explained without ranking it is a fact.
const detailTone = computed<NoticeTone>(() => (entry.state.variant === `danger` || entry.state.variant === `warning` ? entry.state.variant : `info`));
// A registry advisory or an unhealthy update is the detail's source, and the update offer states both in full with what
// to do about them; the plain sentence would only say it twice.
const registryAlert = computed(() => installed.value && (entry.extension.advisory !== undefined || entry.extension.health?.state === `unhealthy`));
const detailNotice = computed(() => (registryAlert.value ? undefined : entry.detail));

// The update offer's own id, which its card reads and the header's update figure lands on.
const updateAnchor = computed(() => `extension-update-${entry.extension.id}`);

// Offered only where removal means something: a baked extension has no files here to delete, and an essential one is
// the control surface for work that carries on regardless. Both refuse daemon-side too; this is what stops the button
// being an invitation to be told no.
const removable = computed(() => manage && entry.extension.source !== `builtin` && entry.extension.essential !== true);
// The one consequence worth naming beside the button, because it is the one nobody expects: connections the owner
// configured themselves go too. The dialog spells out the rest.
const removalHint = computed(() =>
    entry.dependents.length === 0
        ? t(`sandbox.extensionRow.removalHintNone`)
        : t(`sandbox.extensionRow.removalHintConnections`, { count: entry.dependents.length }, entry.dependents.length),
);

const routes = computed(() => routesOf(entry.extension));
// Whether the main column holds anything; a reader who may change nothing of an extension that reaches nothing reads
// where it shows up there instead, rather than beside an empty column.
const hasMain = computed(() => manage || routes.value.length > 0 || workspace.value);

// Where its code comes from, in words: the heading's line, since nothing in a manifest says what it does.
const sourceWords = computed(() => {
    switch (entry.extension.source) {
        case `builtin`:
            return t(`sandbox.extensionRow.sourceBuiltin`);
        case `workspace`:
            return t(`sandbox.extensionRow.sourceWorkspace`);
        default:
            return t(`sandbox.extensionRow.sourceInstalled`);
    }
});

// A state's own colour, where it has one a figure can wear.
const toneOf = (variant: StatusVariant): ProfileStat[`tone`] =>
    variant === `success` || variant === `warning` || variant === `danger` || variant === `info` ? variant : undefined;

// Does it work: its trouble in the host's word where it has one, else on or off.
const status = computed<ProfileStat>(() => {
    const label = t(`sandbox.extensionRow.status`);
    const word = entry.state.badge ? entry.state.label : undefined;
    if (entry.state.attention || dev.value?.held !== undefined || registryAlert.value) {
        return {
            id: `status`,
            icon: `exclamation-triangle`,
            value: word ?? t(`sandbox.extensionRow.needsYou`),
            label,
            tone: entry.state.variant === `danger` ? `danger` : `warning`,
        };
    }
    if (!entry.extension.enabled) {
        return { id: `status`, icon: `circle`, value: t(`sandbox.extensionRow.off`), label };
    }
    return {
        id: `status`,
        icon: `check-circle`,
        value: word ?? t(`sandbox.extensionRow.on`),
        label,
        tone: word === undefined ? `success` : toneOf(entry.state.variant),
    };
});

// What it may reach, and how much of that it has used once anything was observed.
const reach = computed<ProfileStat>(() => {
    const count = routes.value.length;
    if (count === 0) {
        return {
            id: `reach`,
            icon: `shield`,
            value: t(`sandbox.extensionRow.reachNone`),
            label: t(`sandbox.extensionRow.reachLabel`),
            tone: `success`,
        };
    }
    if (entry.extension.usage === undefined) {
        return { id: `reach`, icon: `shield`, value: `${count}`, label: t(`sandbox.extensionRow.reachDeclared`, count), target: `extension-reach` };
    }
    const used = routes.value.filter((route) => route.calls > 0).length;
    return { id: `reach`, icon: `shield`, value: `${used} / ${count}`, label: t(`sandbox.extensionRow.reachUsed`), target: `extension-reach` };
});

// The release on offer where there is one; otherwise the standing answer for the next.
const POLICY_WORDS = {
    notify: () => t(`sandbox.extensionUpdatePolicy.notify`),
    agent: () => t(`sandbox.extensionUpdatePolicy.agentPrepared`),
    auto: () => t(`sandbox.extensionUpdatePolicy.auto`),
} as const;
const updates = computed<ProfileStat[]>(() => {
    if (!installed.value) {
        return [];
    }
    const offer = entry.extension.update;
    if (offer !== undefined) {
        return [
            {
                id: `updates`,
                icon: offer.securityFix ? `shield` : `arrow-circle-up`,
                value: offer.version === undefined ? offer.ref.slice(0, 7) : `v${offer.version}`,
                label: offer.securityFix ? t(`sandbox.extensionRow.securityUpdate`) : t(`sandbox.extensionRow.update`),
                tone: offer.securityFix ? `danger` : `info`,
                target: manage ? updateAnchor.value : undefined,
            },
        ];
    }
    const policy = entry.extension.updatePolicy?.updates ?? `notify`;
    return [
        {
            id: `updates`,
            icon: `arrow-circle-up`,
            value: POLICY_WORDS[policy](),
            label: t(`sandbox.extensionRow.onNewRelease`),
            target: manage ? `extension-updates` : undefined,
        },
    ];
});

const stats = computed<ProfileStat[]>(() => {
    const range = manifest.value.engines.intentic;
    const fits = satisfiesEngines(range, extensionApiVersion);
    return [
        status.value,
        reach.value,
        ...updates.value,
        {
            id: `fits`,
            icon: fits ? `check-circle` : `exclamation-triangle`,
            value: fits ? t(`sandbox.extensionRow.fits`) : t(`sandbox.extensionRow.doesntFit`),
            label: t(`sandbox.extensionRow.requiresApp`, { range }),
            tone: fits ? `success` : `warning`,
        },
        installed.value
            ? { id: `version`, value: `v${manifest.value.version}`, label: entry.extension.commit.slice(0, 7), mono: true }
            : { id: `version`, value: `v${manifest.value.version}`, label: t(`sandbox.extensionRow.versionLabel`) },
    ];
});
</script>

<template>
    <ProfileLayout
        :back="t(`sandbox.words.installed`)"
        :name="manifest.name"
        :prefix="entry.extension.source === `builtin` ? undefined : manifest.publisher"
        :description="sourceWords"
        :art="manifest.art"
        :logo="manifest.logo"
        :icon="manifest.icon"
        :idle="!entry.extension.enabled"
        :stats="stats"
        aside-leads
        @back="emit(`back`)"
    >
        <template v-if="entry.state.badge || entry.extension.update !== undefined" #badge>
            <StatusBadge v-if="entry.state.badge" size="xs" :dot="true" :variant="entry.state.variant" :label="entry.state.label" />
            <StatusBadge
                v-else-if="entry.extension.update !== undefined"
                size="xs"
                :variant="entry.extension.update.securityFix ? `danger` : `info`"
                :label="entry.extension.update.securityFix ? t(`sandbox.extensionRow.securityUpdate`) : t(`sandbox.extensionRow.update`)"
            />
        </template>
        <template v-if="manage" #actions>
            <ExtensionSwitch :extension="entry.extension" :pending="pending" @toggle="(enabled) => emit(`toggle`, entry.extension, enabled)" />
        </template>

        <!-- What is wrong or waiting, each in its own tone; an ordinary extension has none of them. -->
        <template #alerts>
            <Notice v-if="detailNotice" :tone="detailTone" size="sm">{{ detailNotice }}</Notice>
            <!-- Where it runs from, and the way back; the checkout itself is never touched from here. -->
            <Notice v-if="devLine !== undefined" :tone="dev?.held === undefined ? `info` : `warning`" size="sm">
                {{ devLine }}
                <template v-if="manage" #actions>
                    <Button
                        size="small"
                        :tier="dev?.held === undefined ? `boring` : `accent`"
                        :label="t(`sandbox.extensionRow.devBackToPinned`)"
                        :disabled="pending"
                        @click="emit(`devClear`, entry.extension)"
                    >
                        <template #icon><Icon name="undo" /></template>
                    </Button>
                </template>
            </Notice>
            <ExtensionUpdateOffer v-if="manage && installed" :extension="entry.extension" :anchor="updateAnchor" />
        </template>

        <div class="flex flex-col gap-6">
            <!-- What the reader sets, then what it may reach, then publishing, and apart and last, removing it. -->
            <RowGroup v-if="manage && settings.length > 0" id="extension-settings" :label="t(`shared.settings`)">
                <RowNote variant="block"><ExtensionSettingsForm :extension-id="entry.extension.id" :settings="settings" /></RowNote>
            </RowGroup>

            <!-- Only git-installed extensions have an update lifecycle to set a policy for. -->
            <ExtensionUpdatePolicy v-if="manage && installed" :extension="entry.extension" />

            <ExtensionReach :entry="entry" />

            <!-- The same checks against an installed one would flag somebody else's commit the owner can't change. -->
            <ExtensionPublishing v-if="workspace" :extension="entry.extension" />

            <!-- Uninstalling is not the errand this page is opened for; the dialog it raises spells out the consequences. -->
            <RowGroup v-if="removable">
                <Row icon="trash" tone="danger" :title="t(`sandbox.extensionRow.removeTitle`)" :description="removalHint">
                    <template #control>
                        <Button
                            tier="quiet"
                            size="small"
                            tone="danger"
                            :label="t(`sandbox.extensionRow.remove`)"
                            @click="emit(`remove`, entry.extension)"
                        />
                    </template>
                </Row>
            </RowGroup>

            <ExtensionPlaces v-if="!hasMain" :entry="entry" />
        </div>

        <template v-if="hasMain" #aside>
            <ExtensionPlaces :entry="entry" />
        </template>
    </ProfileLayout>
</template>
