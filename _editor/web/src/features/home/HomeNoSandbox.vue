<!-- HOME'S FIRST RUN: what the person sees before their first sandbox, which since Home became the first screen
     (2026-10-25) is the first thing a new account sees at all. It says what a sandbox is and how the master view is
     used, in three steps, and makes one on a press: the new sandbox's tile and page in this one's place, which stays
     until its home conversation is on screen here (newSandbox/newSandbox.ts; a phone's dialog, features/setup/add/). It
     used to be a disabled composer and a coach
     mark pointing at the rail's +, and before that a setup page that started a machine the moment it arrived.
     - A setup of the person's own that never finished is offered first, by name: it resumes on /setup.
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

// Under the phone list's own heading the page is a section of it; on a desktop it is the page.
const { nested = false } = defineProps<{ nested?: boolean }>();

const t = useT();
const { user } = useAuth();
const sandbox = useSandbox();
const signedOut = computed(() => user.value === null);
const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value)[0]);
const add = useRequestAddSandbox();
const STEPS = [`create`, `ask`, `open`] as const;
</script>

<template>
    <section class="ground-card flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-card" data-home-no-sandbox>
        <div class="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-6 py-10">
            <div class="flex flex-col gap-2">
                <component :is="nested ? `h2` : `h1`" class="text-xl font-semibold text-content">{{ t(`home.noSandboxTitle`) }}</component>
                <p class="text-sm text-muted">{{ t(`home.noSandboxLine`) }}</p>
            </div>
            <ol class="flex flex-col gap-3">
                <li v-for="(step, at) in STEPS" :key="step" class="flex items-start gap-3">
                    <span
                        class="flex size-6 shrink-0 items-center justify-center rounded-full bg-content/5 text-xs font-medium text-muted tabular-nums"
                        aria-hidden="true"
                        >{{ at + 1 }}</span
                    >
                    <span class="flex min-w-0 flex-col">
                        <span class="text-sm font-medium text-content">{{ t(`home.firstRun.steps.${step}.title`) }}</span>
                        <span class="text-xs text-muted">{{ t(`home.firstRun.steps.${step}.line`) }}</span>
                    </span>
                </li>
            </ol>
            <div class="flex flex-wrap items-center gap-2">
                <Button
                    v-if="unfinished"
                    :as="RouterLink"
                    :to="{ path: `/setup`, query: { sandbox: unfinished.id } }"
                    :label="t(`home.firstRun.finish`, { name: unfinished.name })"
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
    </section>
</template>
