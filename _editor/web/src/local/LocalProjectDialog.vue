<!-- "WORK ON THIS WITH AN AGENT", ASKED IN THE WINDOW: what a sandbox for this folder is, drawn rather than explained (the
     folder's copy carried into the agent's house), what the first copy carries, anything to beware of, and one button.
     It replaced the system's own message box, which said all of it in two paragraphs. -->
<script setup lang="ts">
import { Button, Icon, InfoHint, Modal, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { localFace } from "../app/environments/local";
import AgentHouse from "./AgentHouse.vue";
import { cautionSentence, copyWeight, refusalSentence } from "./projectWords";
import { useLocalProject } from "./useLocalProject";

const t = useT();
const face = localFace();
const { dialogOpen, preview, creating, failure, create, cancel } = useLocalProject();

// The folder's own name, known before the app has finished weighing it.
const name = computed(() => (preview.value?.kind === `new` ? preview.value.name : (face?.name ?? ``)));
const fresh = computed(() => (preview.value?.kind === `new` ? preview.value : undefined));
const refused = computed(() => (preview.value?.kind === `refused` ? refusalSentence(preview.value.refusal, face?.path ?? ``) : undefined));
const document = computed(() => preview.value?.kind === `document`);

const header = computed(() => {
    if (refused.value !== undefined) {
        return t(`local.project.refusedTitle`);
    }
    if (document.value) {
        return t(`local.project.documentTitle`);
    }
    return t(`local.project.dialogTitle`, { name: name.value });
});

// The folder's path, split where its own name begins, so the name is never what gets cut off.
const folder = computed(() => face?.name ?? ``);
const parent = computed(() => {
    const path = face?.path ?? ``;
    return path.endsWith(folder.value) ? path.slice(0, path.length - folder.value.length) : ``;
});

// What to beware of: the app's cautions, and a first copy that will take its time.
const cautions = computed(() => {
    const said = (fresh.value?.cautions ?? []).map(cautionSentence);
    return fresh.value?.large === true ? [...said, t(`local.project.large`)] : said;
});

// The one press, which needs the app's answer first: whether there is a session to make it with, and room to build it.
const ready = computed(() => fresh.value !== undefined && !fresh.value.busy);
const label = computed(() => (fresh.value?.signedIn === false ? t(`local.project.signInCreate`) : t(`local.project.create`)));

const open = computed({
    get: () => dialogOpen.value,
    set: (shown: boolean) => {
        if (!shown) {
            cancel();
        }
    },
});
</script>

<template>
    <Modal v-model:open="open" size="md" :header="header" :dismissable="!creating">
        <!-- The picture says what the button does: this folder stays where it is, and its copy goes into a house of its
             own, built beside it. A folder that cannot have one gets the empty site with the sign on it. -->
        <div class="mb-4 rounded-md border border-line bg-canvas px-3 pb-2 pt-4">
            <AgentHouse
                :stage="refused !== undefined || document ? `plan` : `moving`"
                :failed="refused !== undefined || document"
                class="mx-auto h-auto max-h-36 w-full"
            />
        </div>

        <template v-if="refused !== undefined">
            <p class="text-xs leading-relaxed text-content">{{ refused }}</p>
        </template>
        <template v-else-if="document">
            <p class="text-xs leading-relaxed text-content">{{ t(`local.project.document`) }}</p>
        </template>
        <template v-else>
            <p class="text-xs leading-relaxed text-content">{{ t(`local.project.lede`) }}</p>

            <!-- The folder, by its full path, its own name the brightest part of it; then what its first copy carries, with
                 what stays behind a hint away. -->
            <div class="mt-3 flex items-center gap-2 rounded-md border border-line bg-canvas px-2.5 py-2 font-mono text-xs">
                <Icon name="folder-open" class="shrink-0 text-subtle" aria-hidden="true" />
                <span class="flex min-w-0" v-tooltip.top="face?.path">
                    <span class="truncate text-subtle">{{ parent }}</span>
                    <span class="shrink-0 text-content">{{ folder }}</span>
                </span>
            </div>
            <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-muted">
                <span v-if="fresh !== undefined" class="tabular-nums">{{ copyWeight(fresh) }}</span>
                <Icon v-else-if="failure === undefined" name="spinner" spin class="text-xs" :aria-label="t(`workspace.words.working`)" />
                <InfoHint :label="t(`local.project.staysHere`)">
                    <span class="block text-xs text-content">{{ t(`local.project.staysHere`) }}</span>
                </InfoHint>
            </p>

            <Notice v-for="caution in cautions" :key="caution" tone="warning" class="mt-2 text-2xs">{{ caution }}</Notice>

            <p v-if="fresh?.busy" class="mt-3 text-2xs text-warning">{{ t(`local.project.busy`) }}</p>
            <p v-else-if="fresh?.signedIn === false" class="mt-3 text-2xs text-muted">{{ t(`local.project.signInNote`) }}</p>
        </template>

        <Notice v-if="failure !== undefined" tone="danger" class="mt-3 text-2xs">
            <span class="block font-medium">{{ t(`local.project.createFailed`) }}</span>
            <span class="block break-words">{{ failure }}</span>
        </Notice>

        <template #footer>
            <template v-if="refused !== undefined || document">
                <Button :label="t(`ui.action.close`)" @click="cancel" />
            </template>
            <template v-else>
                <Button severity="secondary" :text="true" :label="t(`ui.action.cancel`)" :disabled="creating" @click="cancel" />
                <Button :label="label" :loading="creating" :disabled="!ready" @click="create" />
            </template>
        </template>
    </Modal>
</template>
