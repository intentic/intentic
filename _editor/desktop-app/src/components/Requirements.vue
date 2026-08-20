<script setup lang="ts">
import Button from "primevue/button";
import { computed, ref } from "vue";
import type { Requirement, RequirementAction, RequirementProgress } from "../desktop";

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

const props = defineProps<{ requirements: Requirement[]; busy: boolean; progress?: Record<string, RequirementProgress> }>();
const emit = defineEmits<{ install: []; restart: []; signout: []; recheck: []; elsewhere: [] }>();

/* HOW EACH ROW IS GOING, WHILE IT IS GOING.
 *
 * The list used to be a thing you read once and then replaced with a spinner: click "Install and continue"
 * and the whole card was swapped for one progress row reading "Set up Docker", which then sat there for as
 * long as it took to switch WSL2 on, download 600 MB, run an installer, start an engine and wait for a
 * daemon. Ten minutes of one spinner, on the machines that need the most work — the readers least likely to
 * believe it is still going.
 *
 * So the rows stay, and each reports itself: the installer names what it is doing per requirement and what
 * it measures underneath (desktop.ts's requirement-state marker). Nothing here invents a state — a row with
 * no report is simply still pending, which is exactly what it is. */
const stateOf = (id: string): RequirementProgress | undefined => props.progress?.[id];

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

/* …and what a row says about itself once it HAS a state, which retires the promise in `BADGE`. `pending` is
 * spelled here as the absence of one so the lookup has a total answer rather than a branch. */
const STATE_BADGE: Record<string, string | undefined> = {
    pending: undefined,
    running: `working on it`,
    done: `done`,
    failed: `didn't work`,
};

const ours = computed(() => props.requirements.some((requirement) => requirement.action === `fix` || requirement.action === `fixElevated`));
const restarting = computed(() => props.requirements.some((requirement) => requirement.action === `restart`));
/* The one that had no button. Adding an account to `docker-users` succeeds immediately and does nothing at
 * all until Windows re-issues the login token, which it does on the next sign-in — so this row's only
 * control was "Check again", which cannot possibly work, on a machine where everything else had. Same shape
 * as the restart: the setup is parked, Windows is asked to sign out, and the same RunOnce that survives a
 * reboot picks it up on the way back in. */
const signingOut = computed(() => props.requirements.some((requirement) => requirement.action === `signOut`));
// Nothing here is ours, and nothing we can drive: every button would be a lie, so only "Check again" remains —
// it is the honest one, because the user is about to go and change something we cannot see from here.
const stuck = computed(() => !ours.value && !restarting.value && !signingOut.value);
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
                    <!-- The row's own state wins over its action, because once something is being DONE about
                         a requirement, "we'll do this" is history and "how is it going" is the question. -->
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
                            <!-- The badge is a PROMISE about what will happen, so it retires the moment
                                 something has. A row that has just failed still reading "we'll do this" is
                                 the screen contradicting the red mark beside it. -->
                            <span class="text-2xs text-subtle">{{
                                STATE_BADGE[stateOf(requirement.id)?.state ?? `pending`] ?? BADGE[requirement.action]
                            }}</span>
                        </div>
                        <p class="text-2xs text-muted">{{ requirement.problem }}</p>
                        <!-- While something is happening, the installer's own words about THIS row replace the
                             remedy — the remedy describes what will happen, and it already is. -->
                        <p v-if="stateOf(requirement.id)?.detail" class="text-2xs text-subtle">{{ stateOf(requirement.id)?.detail }}</p>
                        <p v-else-if="requirement.remedy" class="text-2xs text-subtle">{{ requirement.remedy }}</p>
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
            <Button v-if="signingOut" :disabled="busy" label="Sign out now" @click="emit(`signout`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <Button severity="secondary" :text="true" :disabled="busy" label="Check again" @click="emit(`recheck`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
        </div>
        <p v-if="restarting || signingOut" class="text-2xs text-subtle">Your setup is saved — this window picks it up again once you're back.</p>

        <!-- THE WAY OUT THAT IS NOT GIVING UP, and the only place in this app that offers one.
             Everything above is a machine being asked for administrator, a 600 MB download and a restart, and
             some of the people reading it are on a PC where none of that is going to happen. The browser has
             offered a cloud machine and a hosted one all along; the app hid them on the argument that "this
             computer" is the whole point of being here — true until this computer cannot, and then it is a
             dead end. One quiet line, under the loud default. -->
        <button
            type="button"
            class="flex items-center gap-2 self-start text-2xs text-muted hover:text-content"
            :disabled="busy"
            @click="emit(`elsewhere`)"
        >
            <Icon name="cloud" class="shrink-0" />
            <span>Not on this computer? Run it in the cloud instead</span>
        </button>
    </div>
</template>
