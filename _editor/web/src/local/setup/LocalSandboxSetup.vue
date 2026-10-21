<!-- A FOLDER'S WAY TO AN AGENT, AS A PAGE OF ITS OWN: before the press, what a sandbox of the folder's own involves and
     the one press that starts it; after it, every step to the open sandbox, on the same page. The agent's house goes up
     as the sandbox's setup really goes (AgentHouse.vue), with the setup's own measure, how long it has run and roughly
     how long is left (SetupMeter.vue). The folder's steps sit beside what is known about it (JourneySteps.vue,
     SetupFacts.vue), and the one thing to do next is the primary press whenever there is one. A sign-in, where nobody is
     signed in, is the way's first step here too: once the browser hands back, the page carries on by itself. Nothing on
     it holds the reader: they can go back to Files, and the rail's tile for it says how far it is (LocalShell.vue).
     (2026-10-21: it replaced a dialog that went away on the press and a card in the window's corner that could not be
     put away and said almost nothing, setupView.ts.) -->
<script setup lang="ts">
import { Button, Icon, Notice, toneWash } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { localFace } from "../../app/environments/local";
import { useAccount } from "../../client/auth/useAccount";
import AgentHouse from "../house/AgentHouse.vue";
import JourneySteps from "../journey/JourneySteps.vue";
import { cautionSentence } from "../projectWords";
import { runSetupAction } from "../setupAction";
import { useLocalProject } from "../useLocalProject";
import SetupFacts from "./SetupFacts.vue";
import SetupMeter from "./SetupMeter.vue";
import type { SetupPress, SetupTone } from "./setupView";

const t = useT();
const router = useRouter();
const face = computed(localFace);
const { user } = useAccount();
const { view, setup, preview, creating, failure, actionFailure, weigh, seen } = useLocalProject();

const folderName = computed(() => face.value?.name ?? setup.value?.name ?? ``);

// Back to the folder's files: a link wherever the reader presses for it.
const FILES = `/workspace`;

// The first look, when nothing has been asked yet: a folder that has its sandbox already is opened, and the page goes.
// Looked at again when a setup is put away, since who is signed in may have changed meanwhile.
const look = async (): Promise<void> => {
    if ((await weigh()) === `opened`) {
        void router.push(FILES);
    }
};
onMounted(look);
watch(
    () => setup.value === undefined,
    (gone) => {
        if (gone) {
            void look();
        }
    },
);
// The reader saw the folder in: its tile can leave the rail once they move on.
onUnmounted(seen);

const tone = computed<SetupTone>(() => view.value?.tone ?? `working`);
// The colour of what the page says, by how it is going.
const TONE_WASH = { asking: `primary`, working: `primary`, waiting: `warning`, ready: `success`, failed: `danger` } as const;
const plate = computed(() => toneWash(TONE_WASH[tone.value]));

const started = computed(() => setup.value !== undefined);
const detail = computed(() => actionFailure.value ?? view.value?.detail);
// What to beware of before the press, beside it: the app's cautions, and a first copy that will take its time.
const cautions = computed(() => {
    const asked = setup.value === undefined && preview.value?.kind === `new` ? preview.value : undefined;
    const said = (asked?.cautions ?? []).map(cautionSentence);
    return asked?.large === true ? [...said, t(`local.project.large`)] : said;
});
// A copy under way has no measure of its own: a bar that only moves says it is going.
const copying = computed(() => setup.value?.state === `copying` && setup.value.status !== `paused`);

const actions = computed<readonly SetupPress[]>(() => view.value?.actions ?? []);
const label = (press: SetupPress): string => t(`local.setup.action.${press}`);
const run = (press: SetupPress): Promise<void> | undefined => runSetupAction(press, (path) => void router.push(path));
// Beside the press: before it, the way back to Files; once the folder is in, the same, for a reader who stays on their
// files for now. In between, a cancel is the app's own (`dismiss`), which puts the folder's setup away.
const secondaryLabel = computed(() => {
    if (!started.value) {
        return t(`local.sandboxSetup.notNow`);
    }
    return tone.value === `ready` ? t(`local.sandboxSetup.backToFiles`) : undefined;
});
// Who it is for: the account's email once the window has it, else whether anyone is signed in, as the setup says.
const signedIn = computed(() => (setup.value === undefined ? preview.value?.kind === `new` && preview.value.signedIn : setup.value.state !== `signedOut`));
</script>

<template>
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 md:px-8 md:py-10">
        <!-- The picture and what is happening, the one thing to do next under it. -->
        <section class="overflow-hidden rounded-xl border border-line bg-card" :aria-busy="tone === `working`">
            <div class="flex items-center justify-center border-b border-line bg-canvas px-6 pb-3 pt-6">
                <AgentHouse
                    v-if="view === undefined || view.hero.kind === `house`"
                    :stage="view?.hero.kind === `house` ? view.hero.stage : `plan`"
                    :paused="tone === `waiting`"
                    :failed="tone === `failed`"
                    class="h-auto max-h-44 w-full max-w-lg"
                />
                <span v-else class="my-6 flex size-20 items-center justify-center rounded-full" :class="plate">
                    <Icon :name="view.hero.icon" class="text-3xl" aria-hidden="true" />
                </span>
            </div>

            <div class="flex flex-col gap-4 p-5 md:p-6">
                <div class="flex flex-col gap-1">
                    <p class="text-xs font-medium text-subtle">{{ t(`local.sandboxSetup.eyebrow`, { name: folderName }) }}</p>
                    <h1 class="text-lg font-semibold text-content" aria-live="polite">
                        {{ view?.title ?? t(`local.sandboxSetup.looking`, { name: folderName }) }}
                    </h1>
                    <p v-if="detail" class="text-sm" :class="tone === `failed` || actionFailure ? `text-danger` : `text-muted`">{{ detail }}</p>
                </div>

                <SetupMeter
                    v-if="view?.percent !== undefined"
                    :percent="view.percent"
                    :step="view.step"
                    :started-at="setup?.startedAt"
                    :left="view.left"
                    :label="view.title"
                />
                <div v-else-if="copying" class="h-2 overflow-hidden rounded-full bg-primary-600/15" role="progressbar" :aria-label="view?.title">
                    <div class="setup-sweep h-full w-1/3 rounded-full bg-primary-600"></div>
                </div>
                <Icon v-else-if="view === undefined && failure === undefined" name="spinner" spin class="text-sm text-muted" :aria-label="t(`workspace.words.working`)" />

                <div v-if="cautions.length > 0" class="flex flex-col gap-2">
                    <Notice v-for="caution in cautions" :key="caution" tone="warning" class="text-2xs">{{ caution }}</Notice>
                </div>
                <Notice v-if="failure !== undefined" tone="danger" class="text-2xs">
                    <span class="block font-medium">{{ t(`local.project.createFailed`) }}</span>
                    <span class="block break-words">{{ failure }}</span>
                </Notice>

                <!-- The one thing to do next, as the primary press; anything beside it is a quieter one. Work that carries on by
                     itself has no next step: what it offers (the sign-in's page again, a cancel) is quiet. -->
                <div v-if="actions.length > 0 || secondaryLabel" class="flex flex-wrap items-center gap-2">
                    <Button
                        v-for="(press, at) in actions"
                        :key="press"
                        :tier="at === 0 && !view?.carriesOn ? `accent` : `quiet`"
                        :label="label(press)"
                        :loading="at === 0 && creating"
                        @click="run(press)"
                    />
                    <Button v-if="secondaryLabel" :as="RouterLink" :to="FILES" tier="quiet" :label="secondaryLabel" />
                </div>
            </div>
        </section>

        <!-- The way there, step by step, beside what is known about the folder. Neither for a folder that cannot have one. -->
        <div v-if="view !== undefined && view.steps.length > 0" class="grid gap-5 md:grid-cols-2">
            <section class="flex flex-col gap-3 rounded-xl border border-line bg-card p-5">
                <h2 class="text-xs font-semibold text-content">{{ started ? t(`local.sandboxSetup.stepsHeading`) : t(`local.journey.heading`) }}</h2>
                <JourneySteps :steps="view.steps" />
            </section>
            <SetupFacts
                :preview="preview"
                :name="folderName"
                :path="face?.path ?? ``"
                :account="user?.email"
                :signed-in="signedIn"
                :started="started"
                class="rounded-xl border border-line bg-card p-5"
            />
        </div>

        <!-- Nothing here waits on the reader: they can go back to their files, and come back from the rail. -->
        <div v-if="view?.carriesOn" class="flex flex-wrap items-center gap-3 rounded-lg border border-line-subtle px-4 py-3 text-xs text-muted">
            <Icon name="info-circle" class="shrink-0 text-sm" aria-hidden="true" />
            <span class="min-w-0 flex-1">{{ t(`local.sandboxSetup.carriesOn`) }}</span>
            <Button :as="RouterLink" :to="FILES" tier="boring" size="small" :label="t(`local.sandboxSetup.backToFiles`)" />
        </div>
        <div v-else-if="view !== undefined && view.steps.length === 0" class="flex">
            <Button :as="RouterLink" :to="FILES" tier="boring" :label="t(`local.sandboxSetup.backToFiles`)" />
        </div>
    </div>
</template>

<style scoped>
/* A copy with no measure of its own: a third of a bar sweeping the track, still for a reader who asks for no motion. */
.setup-sweep {
    animation: setup-sweep 1.6s ease-in-out infinite;
}
@keyframes setup-sweep {
    from {
        transform: translateX(-100%);
    }
    to {
        transform: translateX(300%);
    }
}
:root[data-motion="reduced"] .setup-sweep {
    animation: none;
    width: 100%;
    opacity: 0.5;
}
</style>
