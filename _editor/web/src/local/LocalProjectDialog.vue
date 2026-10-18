<!-- "WORK ON THIS WITH AN AGENT", ASKED IN THE WINDOW: what the first copy carries, anything to beware of, what happens
     next, and one button, which never waits on it: the folder goes in line, and the card in the corner follows it. With
     this computer's sandbox ready the copy is all that happens, drawn rather than explained (the folder's copy carried
     into the agent's house). With anything before it (a sign-in, the sandbox's setup or its start) the steps are listed
     instead, the button named for the first: the house and its moving folder over a press that only opened the browser
     to sign in read as files being uploaded (2026-10-18). It replaced the system's own message box, which said all of
     it in two paragraphs. -->
<script setup lang="ts">
import { Button, Icon, InfoHint, Modal, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { localFace } from "../app/environments/local";
import { localHost } from "../app/environments/localHost";
import AgentHouse from "./house/AgentHouse.vue";
import { journeyOf } from "./journey/journey";
import JourneySteps from "./journey/JourneySteps.vue";
import { cautionSentence, copyWeight, refusalSentence } from "./projectWords";
import { useLocalProject } from "./useLocalProject";

const t = useT();
// Read through `computed`: the dialog outlives a folder pointed at in this window's place (folderSwitch.ts).
const face = computed(localFace);
const { dialogOpen, preview, attaching, failure, attach, cancel } = useLocalProject();
const router = useRouter();

// A folder taken in on a PC that cannot run agents yet goes on to This computer, whose card sets the PC up.
const attachAndGo = async (): Promise<void> => {
    const details = localHost().project?.detailsPath;
    if ((await attach()) === `pcSetup` && details !== undefined) {
        await router.push(details);
    }
};

// The folder's own name, known before the app has finished weighing it.
const name = computed(() => (preview.value?.kind === `new` ? preview.value.name : (face.value?.name ?? ``)));
const fresh = computed(() => (preview.value?.kind === `new` ? preview.value : undefined));
const refused = computed(() => (preview.value?.kind === `refused` ? refusalSentence(preview.value.refusal, face.value?.path ?? ``) : undefined));
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
const folder = computed(() => face.value?.name ?? ``);
const parent = computed(() => {
    const path = face.value?.path ?? ``;
    return path.endsWith(folder.value) ? path.slice(0, path.length - folder.value.length) : ``;
});

// What to beware of: the app's cautions, and a first copy that will take its time.
const cautions = computed(() => {
    const said = (fresh.value?.cautions ?? []).map(cautionSentence);
    return fresh.value?.large === true ? [...said, t(`local.project.large`)] : said;
});

// The one press, which needs the app's answer first. Nobody signed in signs in on it: this computer's sandbox is made
// right after, and the folder goes into it.
const ready = computed(() => fresh.value !== undefined);
const signedOut = computed(() => fresh.value?.machine.state === `signedOut`);
const label = computed(() => (signedOut.value ? t(`local.project.signInAttach`) : t(`local.project.attach`)));

// What happens before the copy, step by step, wherever anything does: a sign-in, the sandbox's setup or its start.
// Nothing, with the sandbox ready: the copy starts on the press, and the picture says so.
const steps = computed(() => {
    const asked = fresh.value;
    if (asked === undefined || asked.machine.state === `ready`) {
        return undefined;
    }
    const machine = asked.machine;
    return journeyOf({ machine, folder: undefined, name: asked.name, signingIn: false, withSignIn: machine.state === `signedOut` || machine.state === `signedIn` });
});
// The picture: the copy moving in when that is all that happens, the empty site with its sign where nothing can.
const picture = computed(() => refused.value !== undefined || document.value || fresh.value?.machine.state === `ready`);

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
    <!-- What happens, or why it can't, is the description in each case: the folder's copy, a document, or the refusal. -->
    <Modal
        v-model:open="open"
        size="md"
        :header="header"
        :description="refused ?? (document ? t(`local.project.document`) : t(`local.project.lede`))"
        :dismissable="!attaching"
    >
        <div class="flex flex-col gap-4">
            <!-- The picture says what the button does: this folder stays where it is, and its copy goes into a house of its
                 own, built beside it. A folder that cannot have one gets the empty site with the sign on it. Drawn
                 straight on the dialog: a frame round it would be a card on a card. -->
            <AgentHouse
                v-if="picture"
                :stage="refused !== undefined || document ? `plan` : `moving`"
                :failed="refused !== undefined || document"
                class="mx-auto h-auto max-h-36 w-full"
            />

            <template v-if="refused === undefined && !document">
                <!-- The folder, by its full path, its own name the brightest part of it; then what its first copy carries, with
                     what stays behind a hint away. -->
                <div class="flex flex-col gap-1.5">
                    <div class="flex items-center gap-2 rounded-md bg-canvas px-2.5 py-2 font-mono text-xs">
                        <Icon name="folder-open" class="shrink-0 text-subtle" aria-hidden="true" />
                        <span class="flex min-w-0" v-tooltip.top="face?.path">
                            <span class="truncate text-subtle">{{ parent }}</span>
                            <span class="shrink-0 text-content">{{ folder }}</span>
                        </span>
                    </div>
                    <p class="flex items-center gap-1.5 text-2xs text-muted">
                        <span v-if="fresh !== undefined" class="tabular-nums">{{ copyWeight(fresh) }}</span>
                        <Icon v-else-if="failure === undefined" name="spinner" spin class="text-xs" :aria-label="t(`workspace.words.working`)" />
                        <InfoHint :label="t(`local.project.staysHere`)">
                            <span class="block text-xs text-content">{{ t(`local.project.staysHere`) }}</span>
                        </InfoHint>
                    </p>
                </div>

                <Notice v-for="caution in cautions" :key="caution" tone="warning" class="text-2xs">{{ caution }}</Notice>

                <!-- What happens on the press, in order, when more than the copy does. -->
                <section v-if="steps !== undefined" class="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5">
                    <h3 class="text-2xs font-medium text-subtle">{{ t(`local.journey.heading`) }}</h3>
                    <JourneySteps :steps="steps" />
                </section>
            </template>

            <Notice v-if="failure !== undefined" tone="danger" class="text-2xs">
                <span class="block font-medium">{{ t(`local.project.attachFailed`) }}</span>
                <span class="block break-words">{{ failure }}</span>
            </Notice>
        </div>

        <template #footer>
            <template v-if="refused !== undefined || document">
                <Button :label="t(`ui.action.close`)" tier="quiet" @click="cancel" />
            </template>
            <template v-else>
                <Button tier="quiet" :label="t(`ui.action.cancel`)" :disabled="attaching" @click="cancel" />
                <Button :label="label" :loading="attaching" :disabled="!ready" @click="attachAndGo" />
            </template>
        </template>
    </Modal>
</template>
