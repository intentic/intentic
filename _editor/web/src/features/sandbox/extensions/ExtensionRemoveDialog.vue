<script setup lang="ts">
import type { ExtensionRemovalPlan, ExtensionSummary } from "@intentic/sandbox-contract";
import { Button, Modal, Notice, SkeletonRows, StatusBadge, ui } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { facetsOf } from "../../extensions/extensionFacets";
import { removalPlan } from "../../extensions/useExtensions";
import { useT } from "@intentic/ui/i18n";

// The read before an uninstall. Removing an extension is the one act that also removes things the owner configured
// themselves — connections added from its cards, with their credentials — so this dialog exists to make that visible
// BEFORE the click rather than reportable after it. The daemon's plan supplies everything the browser cannot know
// (which entries came from which card, which settings actually hold values, what is on disk); the manifest supplies
// the surfaces, which it already has on the row.

const t = useT();

const { extension, busy } = defineProps<{
    /** The row being removed, undefined while the dialog is closed. */
    extension: ExtensionSummary | undefined;
    /** The removal is in flight; owned by the list, which is where the call and its failure live. */
    busy: boolean;
}>();
const emit = defineEmits<{ close: []; confirm: [] }>();

const plan = ref<ExtensionRemovalPlan>();
const failure = ref<string>();

// Re-read per opening, never cached: a connection added in another tab since the last look is exactly the one this
// dialog must not omit.
watch(
    () => extension?.id,
    async (id) => {
        plan.value = undefined;
        failure.value = undefined;
        if (id === undefined) {
            return;
        }
        try {
            plan.value = await removalPlan(id);
        } catch (error) {
            failure.value = errorMessage(error, `Couldn't work out what removing this would take away.`);
        }
    },
    { immediate: true },
);

// What disappears from the app itself, read off the manifest the row already holds: places, not state, so it belongs
// beside the plan rather than in it.
const surfaces = computed(() =>
    extension === undefined
        ? []
        : facetsOf(extension.manifest)
              .filter((facet) => facet.surface)
              .map((facet) => facet.label),
);

// What removal does not reach at once, for the same reason the row states it before a switch-off: an agent's tools are
// rebuilt per turn and the image only at a rebuild, so "removed" is true of different things at different moments.
const DEFERRED: Record<string, string> = {
    agent: `its skills, hooks and MCP servers leave the agent from the next turn`,
    bin: `its CLIs leave the agent's PATH from the next turn`,
    environment: `what it baked into the sandbox image is gone only after the next environment rebuild`,
};
const deferred = computed(() => Object.keys(extension?.manifest.contributes ?? {}).flatMap((kind) => DEFERRED[kind] ?? []));

// Credentials are counted rather than listed per connection: the count is the consequence (you will be entering these
// again), the field names are not.
const credentials = computed(() => (plan.value?.connections ?? []).reduce((total, connection) => total + connection.secrets.length, 0));
const secretSettings = computed(() => (plan.value?.settings ?? []).filter((setting) => setting.secret).length);
// Every credential the click destroys, from both halves: a connection's fields and the extension's own secret
// settings are the same loss to whoever has to enter them again.
const credentialsLost = computed(() => credentials.value + secretSettings.value);

// Counted prose built here rather than assembled from interpolations in the template, where a line break between two
// mustaches renders as a space and puts one in front of the comma.
const settingsLine = computed(() => {
    const settings = plan.value?.settings ?? [];
    const noun = settings.length === 1 ? `setting you entered` : `settings you entered`;
    const keys = settings.map((setting) => setting.key).join(`, `);
    return { lead: `${settings.length} ${noun}`, keys };
});
const secretsAside = computed(() =>
    secretSettings.value === 0
        ? undefined
        : `, ${secretSettings.value} of them ${secretSettings.value === 1 ? `a stored credential` : `stored credentials`}`,
);
const processesLine = computed(() => {
    const processes = plan.value?.processes ?? [];
    const subject = processes.length === 1 ? `a background service stops now` : `${processes.length} background services stop now`;
    return `${subject}: ${processes.join(`, `)}`;
});
</script>

<template>
    <Modal
        :open="extension !== undefined"
        size="md"
        :header="t(`sandbox.extensionRemoveDialog.remove`, { publisher: extension?.manifest.publisher, name: extension?.manifest.name })"
        @update:open="emit(`close`)"
    >
        <div v-if="plan === undefined && failure === undefined" role="status" aria-busy="true">
            <span class="sr-only">{{ t(`sandbox.extensionRemoveDialog.workingOutWhatRemoving`) }}</span>
            <SkeletonRows :rows="4" description />
        </div>

        <Notice v-else-if="failure" :of="{ tone: `danger`, title: `Couldn't read what this would remove.`, detail: failure }" />

        <div v-else-if="plan" class="flex flex-col gap-4">
            <!-- Refusals are shown, not hidden behind a missing button: the row hides the affordance, but a plan read
                 while an image changed underneath still has to say why. -->
            <Notice v-if="plan.blocked" :of="{ tone: `warning`, title: `This one can't be removed.`, detail: plan.blocked }" />

            <p class="text-sm text-content">
                v{{ plan.version }} ·
                {{
                    plan.source === `workspace`
                        ? t(`sandbox.extensionRemoveDialog.writtenInWorkspace`)
                        : plan.source === `installed`
                          ? t(`sandbox.extensionRemoveDialog.installedRepository`)
                          : t(`sandbox.words.builtIntoSandboxImage`)
                }}
            </p>

            <!-- Nothing below this point renders for a refusal. Every line of it is written in the present tense about
                 what goes, and none of it is going anywhere: "2 connections are removed with it" under a notice saying
                 it cannot be removed is a false claim, not extra information. -->
            <template v-if="plan.blocked === undefined">
                <!-- The connections lead, because they are the part nobody expects: entries the owner configured
                 themselves, with credentials in them, that cannot outlive the extension supplying their card. -->
                <section v-if="plan.connections.length > 0">
                    <p :class="ui.sectionLabel(`mb-1.5 text-2xs text-danger`)">
                        {{ t(`sandbox.extensionRemoveDialog.connectionsRemoved`, { count: plan.connections.length }, plan.connections.length) }}
                    </p>
                    <ul class="flex flex-col gap-1.5">
                        <li v-for="connection in plan.connections" :key="connection.id" class="rounded border border-danger/40 bg-danger/5 p-2">
                            <div class="flex flex-wrap items-baseline gap-x-2">
                                <span class="font-mono text-xs font-medium text-content">{{ connection.id }}</span>
                                <StatusBadge variant="neutral" :label="connection.kind" size="xs" />
                                <span class="text-2xs text-subtle">{{ t(`sandbox.extensionRemoveDialog.added`, { entry: connection.entry }) }}</span>
                            </div>
                            <p class="mt-0.5 text-2xs text-muted">{{ connection.effect }}.</p>
                            <p v-if="connection.secrets.length > 0" class="mt-0.5 text-2xs text-warning">
                                {{
                                    t(
                                        `sandbox.extensionRemoveDialog.credentialsGoWithIt`,
                                        { count: connection.secrets.length, names: connection.secrets.join(`, `) },
                                        connection.secrets.length,
                                    )
                                }}
                            </p>
                        </li>
                    </ul>
                </section>

                <!-- Files, settings and processes: the rest of the state, compact because none of it is a surprise. -->
                <section v-if="plan.files.length > 0 || plan.settings.length > 0 || plan.processes.length > 0">
                    <p :class="ui.sectionLabel(`mb-1.5 text-2xs`)">{{ t(`sandbox.extensionRemoveDialog.alsoDeleted`) }}</p>
                    <!-- `pl-3 -indent-3` hangs the wrap under the text rather than under the dash; several of these lines
                     are long enough to wrap in a narrow modal. -->
                    <ul class="flex flex-col gap-1 text-2xs text-muted">
                        <li v-for="file in plan.files" :key="file.path" class="-indent-3 pl-3">
                            — <span class="font-mono text-content">{{ file.path }}</span> · {{ file.detail }}
                        </li>
                        <li v-if="plan.settings.length > 0" class="-indent-3 pl-3">
                            — {{ settingsLine.lead }}<span v-if="secretsAside" class="text-warning">{{ secretsAside }}</span
                            >: {{ settingsLine.keys }}
                        </li>
                        <li v-if="plan.processes.length > 0" class="-indent-3 pl-3">— {{ processesLine }}</li>
                        <li class="-indent-3 pl-3">{{ t(`sandbox.extensionRemoveDialog.switchUpdateRecordWhat`) }}</li>
                    </ul>
                </section>

                <section v-if="surfaces.length > 0 || deferred.length > 0">
                    <p :class="ui.sectionLabel(`mb-1.5 text-2xs`)">{{ t(`sandbox.extensionRemoveDialog.whatStopsBeing`) }}</p>
                    <p v-if="surfaces.length > 0" class="text-2xs text-muted">{{ surfaces.join(` · `) }}.</p>
                    <ul v-if="deferred.length > 0" class="mt-1 flex flex-col gap-0.5">
                        <li v-for="note in deferred" :key="note" class="-indent-3 pl-3 text-2xs text-subtle">— {{ note }}.</li>
                    </ul>
                </section>

                <!-- Automations are the quiet failure this whole dialog is for: nothing deletes them, they simply stop. -->
                <section v-if="plan.automations.length > 0">
                    <p :class="ui.sectionLabel(`mb-1.5 text-2xs text-warning`)">
                        {{ t(`sandbox.extensionRemoveDialog.automationsStop`, { count: plan.automations.length }, plan.automations.length) }}
                    </p>
                    <p class="text-2xs text-muted">
                        {{ t(`sandbox.extensionRemoveDialog.automationsWakeOn`, { names: plan.automations.join(`, `) }) }}
                    </p>
                </section>

                <section v-if="plan.keeps.length > 0">
                    <p :class="ui.sectionLabel(`mb-1.5 text-2xs`)">{{ t(`sandbox.extensionRemoveDialog.leftAlone`) }}</p>
                    <ul class="flex flex-col gap-0.5">
                        <li v-for="keep in plan.keeps" :key="keep" class="-indent-3 pl-3 text-2xs text-subtle">— {{ keep }}.</li>
                    </ul>
                </section>

                <p v-if="credentialsLost > 0" class="text-xs text-danger">
                    {{ t(`sandbox.extensionRemoveDialog.credentialsLost`, { count: credentialsLost }, credentialsLost) }}
                </p>
            </template>
        </div>

        <template #footer>
            <Button :label="t(`ui.action.cancel`)" severity="secondary" :text="true" @click="emit(`close`)" />
            <Button
                :label="t(`ui.action.remove`)"
                severity="danger"
                autofocus
                :disabled="plan === undefined || plan.blocked !== undefined"
                :loading="busy"
                @click="emit(`confirm`)"
            >
                <template #icon><Icon name="trash" /></template>
            </Button>
        </template>
    </Modal>
</template>
