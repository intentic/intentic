<script setup lang="ts">
import Button from "primevue/button";
import { computed, ref } from "vue";
import type { Requirement, RequirementAction } from "../desktop";

/* WHAT THIS COMPUTER NEEDS, AS SOMETHING YOU CAN ACT ON.
 *
 * A stopped install used to end here as four lines of stderr in a red box. That is the right shape for a
 * failure nobody could have predicted — a network that dropped, an image that would not pull — and the wrong
 * one for the failures that dominate a first Windows install, which are not accidents at all: WSL2 is not
 * turned on, this PC has no package manager, virtualization is switched off in firmware. Every one of those
 * has a known, specific answer, and three of the four we can simply do.
 *
 * So they are drawn as REQUIREMENTS rather than as an error: what is missing, what happens about it, and the
 * one button that does it. The user's consent for that button is the whole of the "ask once" this flow
 * promises — the installer's first pass deliberately changes nothing and reports the list, and this is where
 * the list is answered.
 *
 * The rows that are NOT ours to fix are the reason this is a component and not a confirm dialog. Firmware
 * virtualization cannot be turned on from inside Windows by anything, ever, and the honest UI for it is the
 * walkthrough the installer already wrote — shown here in full, in a monospace block, because it is a list of
 * keys to press on a screen that is not this one. */

const props = defineProps<{ requirements: Requirement[]; busy: boolean }>();
const emit = defineEmits<{ install: []; restart: []; recheck: [] }>();

// Which walkthroughs are open. Closed by default: the firmware one is thirty lines, and somebody whose only
// problem is a missing Docker should not have to scroll past it.
const opened = ref<Record<string, boolean>>({});
const toggle = (id: string): void => {
    opened.value = { ...opened.value, [id]: !opened.value[id] };
};

const ICON: Record<RequirementAction, string> = {
    fix: `bolt`,
    fixElevated: `bolt`,
    restart: `refresh`,
    firmware: `exclamation-triangle`,
    hostVm: `exclamation-triangle`,
    user: `exclamation-triangle`,
    signOut: `refresh`,
    unsupported: `times`,
};

// The one-word promise on each row, which is what makes a list of five problems readable at a glance: three
// of them are ours and two are not, and the reader should be able to see that without reading five sentences.
const BADGE: Record<RequirementAction, string> = {
    fix: `we'll do this`,
    fixElevated: `we'll do this`,
    restart: `needs a restart`,
    firmware: `you'll have to do this`,
    hostVm: `on the host machine`,
    user: `you'll have to do this`,
    signOut: `needs a sign-out`,
    unsupported: `not supported`,
};

const ours = computed(() => props.requirements.some((requirement) => requirement.action === `fix` || requirement.action === `fixElevated`));
const restarting = computed(() => props.requirements.some((requirement) => requirement.action === `restart`));
// Nothing here is ours and nothing is a restart: every button would be a lie, so only "Check again" remains —
// it is the honest one, because the user is about to go and change something we cannot see from here.
const stuck = computed(() => !ours.value && !restarting.value);
const needsAdmin = computed(() => props.requirements.some((requirement) => requirement.action === `fixElevated`));
</script>

<template>
    <div class="flex flex-col gap-3">
        <p class="text-2xs text-content">
            {{ stuck ? `This computer can't run a sandbox yet:` : `Before your sandbox can run here:` }}
        </p>

        <ul class="flex flex-col gap-2">
            <li v-for="requirement in requirements" :key="requirement.id" class="rounded-md border border-line bg-canvas p-2.5">
                <div class="flex items-start gap-2">
                    <Icon
                        :name="ICON[requirement.action]"
                        class="mt-0.5 shrink-0"
                        :class="requirement.action === `fix` || requirement.action === `fixElevated` ? 'text-primary-400' : 'text-warning'"
                    />
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-baseline gap-x-2">
                            <span class="text-2xs font-medium text-content">{{ requirement.title }}</span>
                            <span class="text-2xs text-subtle">{{ BADGE[requirement.action] }}</span>
                        </div>
                        <p class="text-2xs text-muted">{{ requirement.problem }}</p>
                        <p v-if="requirement.remedy" class="text-2xs text-subtle">{{ requirement.remedy }}</p>
                        <button
                            v-if="requirement.detail"
                            type="button"
                            class="mt-1 text-2xs text-link hover:underline"
                            @click="toggle(requirement.id)"
                        >
                            {{ opened[requirement.id] ? `Hide the steps` : `Show me how` }}
                        </button>
                    </div>
                </div>
                <!-- Verbatim and monospace: this is a list of keys to press on a screen that is not this one,
                     and re-flowing it would break the alignment that makes it readable at all. -->
                <pre
                    v-if="requirement.detail && opened[requirement.id]"
                    class="mt-2 max-h-72 overflow-auto rounded-md border border-line bg-surface p-2 font-mono text-2xs leading-relaxed text-muted whitespace-pre-wrap"
                >{{ requirement.detail }}</pre>
            </li>
        </ul>

        <!-- True, and worth saying BEFORE the click rather than as a surprise a second later: an elevation
             prompt nobody expected reads as something having gone wrong. -->
        <p v-if="needsAdmin && ours" class="text-2xs text-subtle">Windows will ask for permission once.</p>

        <div class="flex flex-wrap items-center gap-2">
            <Button v-if="ours" :disabled="busy" label="Install and continue" @click="emit(`install`)">
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <Button v-if="restarting" :disabled="busy" label="Restart now" @click="emit(`restart`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <Button severity="secondary" :text="true" :disabled="busy" label="Check again" @click="emit(`recheck`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
        </div>
        <p v-if="restarting" class="text-2xs text-subtle">Your setup is saved — this window picks it up again after the restart.</p>
    </div>
</template>
