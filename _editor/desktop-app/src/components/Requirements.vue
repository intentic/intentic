<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import type { Requirement, RequirementAction, RequirementProgress } from "../desktop";

// Requirements render as actionable rows — what's missing, what will happen, one button — not a raw error box.
// The install's first pass changes nothing and only reports; rows this app can't fix (like firmware
// virtualization) show the installer's own walkthrough instead.

const props = defineProps<{ requirements: Requirement[]; busy: boolean; progress?: Record<string, RequirementProgress> }>();
const emit = defineEmits<{ install: []; restart: []; signout: []; recheck: []; elsewhere: [] }>();

// Looks up a row's live progress. A row with no report is simply pending; nothing here invents an intermediate
// state.
const stateOf = (id: string): RequirementProgress | undefined => props.progress?.[id];

// Which walkthroughs are open; closed by default so a short fix isn't buried under a long one.
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

// One-word promise per row, so which ones this app will fix is visible without reading each line.
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

// Overrides BADGE once a row has a state; `pending` is undefined so the lookup is total.
const STATE_BADGE: Record<string, string | undefined> = {
    pending: undefined,
    running: `working on it`,
    done: `done`,
    failed: `didn't work`,
};

const ourCount = computed(
    () => props.requirements.filter((requirement) => requirement.action === `fix` || requirement.action === `fixElevated`).length,
);
const ours = computed(() => ourCount.value > 0);
// Button label matches the per-row promise in BADGE, so the two verbs never disagree (e.g. "Install" when the
// real job is just starting Docker).
const doLabel = computed(() => (ourCount.value > 1 ? `Do these and continue` : `Do this and continue`));
const restarting = computed(() => props.requirements.some((requirement) => requirement.action === `restart`));
// docker-users membership needs a Windows sign-out to take effect, not a recheck; setup is parked and resumes via
// the same RunOnce as a restart.
const signingOut = computed(() => props.requirements.some((requirement) => requirement.action === `signOut`));
// None of these rows are fixable here, so the only honest control left is Check again.
const stuck = computed(() => !ours.value && !restarting.value && !signingOut.value);
const needsAdmin = computed(() => props.requirements.some((requirement) => requirement.action === `fixElevated`));
</script>

<template>
    <div class="flex flex-col gap-3">
        <p class="text-2xs text-content">
            {{ stuck ? `This device can't run a sandbox yet:` : `Before your sandbox can run here:` }}
        </p>

        <ul class="flex flex-col gap-2">
            <li v-for="requirement in requirements" :key="requirement.id" class="rounded-md border border-line bg-canvas p-2.5">
                <div class="flex items-start gap-2">
                    <!-- Live state overrides the static action icon once something is actually happening. -->
                    <Icon v-if="stateOf(requirement.id)?.state === `running`" name="spinner" spin class="mt-0.5 shrink-0 text-primary-400" />
                    <Icon v-else-if="stateOf(requirement.id)?.state === `done`" name="check-circle" class="mt-0.5 shrink-0 text-success" />
                    <Icon
                        v-else
                        :name="stateOf(requirement.id)?.state === `failed` ? `times` : ICON[requirement.action]"
                        class="mt-0.5 shrink-0"
                        :class="
                            stateOf(requirement.id)?.state === `failed`
                                ? 'text-danger'
                                : requirement.action === `fix` || requirement.action === `fixElevated`
                                  ? 'text-primary-400'
                                  : 'text-warning'
                        "
                    />
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-baseline gap-x-2">
                            <span class="text-2xs font-medium text-content">{{ requirement.title }}</span>
                            <!-- Badge retires once the row has a live state, so it never contradicts it. -->
                            <span class="text-2xs text-subtle">{{
                                STATE_BADGE[stateOf(requirement.id)?.state ?? `pending`] ?? BADGE[requirement.action]
                            }}</span>
                        </div>
                        <p class="text-2xs text-muted">{{ requirement.problem }}</p>
                        <!-- Live detail replaces the static remedy once the row is running. -->
                        <p v-if="stateOf(requirement.id)?.detail" class="text-2xs text-subtle">{{ stateOf(requirement.id)?.detail }}</p>
                        <p v-else-if="requirement.remedy" class="text-2xs text-subtle">{{ requirement.remedy }}</p>
                        <button v-if="requirement.detail" type="button" :class="ui.linkButton(`mt-1 text-2xs`)" @click="toggle(requirement.id)">
                            {{ opened[requirement.id] ? `Hide the steps` : `Show me how` }}
                        </button>
                    </div>
                </div>
                <!-- Verbatim and monospace: reflowing would break the alignment of these steps. -->
                <pre
                    v-if="requirement.detail && opened[requirement.id]"
                    class="mt-2 max-h-72 overflow-auto rounded-md border border-line bg-surface p-2 font-mono text-2xs leading-relaxed text-muted whitespace-pre-wrap"
                    >{{ requirement.detail }}</pre>
            </li>
        </ul>

        <!-- Shown before the click, so an expected elevation prompt doesn't read as something going wrong. -->
        <!-- Hidden once busy: the prompt has already happened or is happening by then. -->
        <p v-if="needsAdmin && ours && !busy" class="text-2xs text-subtle">Windows will ask for permission once.</p>

        <!-- Buttons hide once busy: progress lives in the rows below, not in a disabled button beside them. -->
        <div v-if="!busy" class="flex flex-wrap items-center gap-2">
            <Button v-if="ours" :label="doLabel" @click="emit(`install`)">
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <Button v-if="restarting" label="Restart now" @click="emit(`restart`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <Button v-if="signingOut" label="Sign out now" @click="emit(`signout`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <Button severity="secondary" :text="true" label="Check again" @click="emit(`recheck`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
        </div>
        <p v-if="restarting || signingOut" class="text-2xs text-subtle">Your setup is saved: this window picks it up again once you're back.</p>

        <!-- The one escape hatch: run in a hosted browser instead, when this device can't meet the requirements. -->
        <button v-if="!busy" type="button" :class="ui.textAction(`text-2xs`)" @click="emit(`elsewhere`)">
            <Icon name="server" class="shrink-0" />
            <span>Not on this device? Run it on a machine we host</span>
        </button>
    </div>
</template>
