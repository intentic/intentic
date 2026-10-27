<!-- HOME'S FIRST RUN: what the person sees before their first sandbox, which since Home became the first screen
     (2026-10-25) is the first thing a new account, or a visitor not signed in yet, sees at all. It names the one idea the
     rest of the app is built on, what a sandbox is, in a line, then draws how it is used (HomeNoSandboxFigure.vue: you
     ask, agents work inside it, you keep the change) and makes one on a press: the new sandbox's dialog, then its tile and
     its run's page in this one's place, which stays until its home conversation is on screen here (newSandbox/newSandbox.ts;
     a phone's dialog, features/setup/add/). It used to be three numbered lines of prose leaning on the app's own words
     ("home conversation", "one press away") (until 2026-10-27), before that a disabled composer and a coach mark pointing at
     the rail's +, and before that a setup page that started a machine the moment it arrived.
     - A setup of the person's own that never finished is offered first, by name, and finished here, in the new sandbox's
       tile and page (models/sandbox/finishOnHome.ts): a machine of ours on it waited on, this computer's app
       running it, or its command shown again. Never the one Home is making right now, whose run is its tile's: offered
       here, it read as a setup left unfinished and sent its reader to "finish" a sandbox already starting (2026-10-26).
     - Signed out (anonymous Home), Create signs in first and comes back to the same ask (models/sandbox/addSandbox.ts),
       and a returning person whose session ended is told plainly that signing in brings their sandboxes back. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAuth } from "../../client/auth/useAuth";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { signInAt } from "../../lib/routes/signIn";
import { useRequestAddSandbox } from "../../models/sandbox/addSandbox";
import { unfinishedSandboxes } from "../../models/sandbox/live/roster";
import { finishOnHome } from "../../models/sandbox/finishOnHome";
import { newSandbox } from "./newSandbox/newSandbox";
import HomeNoSandboxFigure from "./HomeNoSandboxFigure.vue";

// Under the phone list's own heading the page is a section of it; on a desktop it is the page.
const { nested = false } = defineProps<{ nested?: boolean }>();

const t = useT();
const { user } = useAuth();
const sandbox = useSandbox();
const signedOut = computed(() => user.value === null);
const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value).find((box) => box.id !== newSandbox.value?.here.add.created.value?.id));
// Finishing it is Home's own tile and page, wherever this is.
const finish = computed(() => (unfinished.value === undefined ? undefined : finishOnHome(unfinished.value.id)));
const add = useRequestAddSandbox();
</script>

<template>
    <section class="ground-card flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-card" data-home-no-sandbox>
        <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-8 px-6 py-8 sm:gap-10 sm:py-10">
            <div class="flex max-w-md flex-col items-center gap-2 text-center">
                <component :is="nested ? `h2` : `h1`" class="text-2xl font-semibold text-content">{{ t(`home.firstRun.title`) }}</component>
                <p class="text-balance text-sm text-muted">{{ t(`home.firstRun.line`) }}</p>
            </div>
            <HomeNoSandboxFigure />
            <div class="flex flex-col items-center gap-3">
                <div class="flex flex-wrap items-center justify-center gap-2">
                    <Button
                        tier="accent"
                        v-if="unfinished && finish"
                        :as="RouterLink"
                        :to="finish"
                        :label="t(`home.firstRun.finish`, { name: unfinished.name })"
                        data-home-finish
                    />
                    <Button :label="t(`home.firstRun.create`)" :tier="unfinished ? `boring` : `accent`" data-home-create @click="add">
                        <template #icon><Icon name="plus" aria-hidden="true" /></template>
                    </Button>
                    <Button v-if="signedOut" :as="RouterLink" :to="signInAt(HOME_PATH)" :label="t(`home.firstRun.signIn`)" tier="boring">
                        <template #icon><Icon name="sign-in" aria-hidden="true" /></template>
                    </Button>
                </div>
                <p v-if="signedOut" class="text-xs text-muted">{{ t(`home.firstRun.signedOut`) }}</p>
            </div>
        </div>
    </section>
</template>
