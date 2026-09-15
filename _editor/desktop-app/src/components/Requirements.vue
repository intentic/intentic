<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import type { Requirement, RequirementAction, RequirementProgress, SessionEnd } from "../desktop";

// Requirements render as actionable rows — what's missing, what will happen, one button — not a raw error box.
// The install's first pass changes nothing and only reports; rows this app can't fix (like firmware
// virtualization) show the installer's own walkthrough instead.
//
// Nothing here is said twice: a single row is its own heading, its badge only earns its place while several rows
// are being scanned, and the remedy is only printed where it says something the button under it does not.

const props = defineProps<{
    requirements: Requirement[];
    busy: boolean;
    progress?: Record<string, RequirementProgress>;
    /** How the session ended for this setup before it resumed, when it did (App.vue `resumedHow`). */
    resumedFrom?: SessionEnd;
}>();
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

// The two actions whose remedy is the button under the list and nothing more; every other remedy says
// something the button does not (what gets downloaded, that Windows will ask, what to do by hand).
const SAID_BY_BUTTON = new Set<RequirementAction>([`restart`, `signOut`]);

const ourCount = computed(
    () => props.requirements.filter((requirement) => requirement.action === `fix` || requirement.action === `fixElevated`).length,
);
const ours = computed(() => ourCount.value > 0);
// A row that was tried and did not work: the button becomes a retry, since "continue" is not what it would do.
const anyFailed = computed(() => props.requirements.some((requirement) => stateOf(requirement.id)?.state === `failed`));
// Button label matches the per-row promise in BADGE, so the two verbs never disagree (e.g. "Install" when the
// real job is just starting Docker).
const doLabel = computed(() => (anyFailed.value ? `Try again` : ourCount.value > 1 ? `Do these and continue` : `Do this and continue`));
const restarting = computed(() => props.requirements.some((requirement) => requirement.action === `restart`));
// docker-users membership needs a Windows sign-out to take effect, not a recheck; setup is parked and resumes via
// the same RunOnce as a restart.
const signingOut = computed(() => props.requirements.some((requirement) => requirement.action === `signOut`));
// The sign-out was already taken and Windows still hands out the old sign-in: the next thing that issues a fresh
// one is a restart, so that is the button — asking for the same sign-out again is the loop this exists to end.
const signOutAgain = computed(() => signingOut.value && props.resumedFrom === `signout`);
// …and one a restart did not settle either is out of this app's hands.
const signOutExhausted = computed(() => signingOut.value && props.resumedFrom === `restart`);
// None of these rows are fixable here, so the only honest control left is Check again.
const stuck = computed(() => (!ours.value && !restarting.value && !signingOut.value) || signOutExhausted.value);
const needsAdmin = computed(() => props.requirements.some((requirement) => requirement.action === `fixElevated`));
// A single row states the problem in its own title; a list of them needs saying what the list is.
const many = computed(() => props.requirements.length > 1);

const badgeOf = (requirement: Requirement): string | undefined =>
    STATE_BADGE[stateOf(requirement.id)?.state ?? `pending`] ?? (many.value ? BADGE[requirement.action] : undefined);

const remedyOf = (requirement: Requirement): string | undefined => (SAID_BY_BUTTON.has(requirement.action) ? undefined : requirement.remedy);

// What the session-ending button will do, said once under the buttons rather than per row.
const sessionNote = computed(() => {
    if (signOutExhausted.value) {
        return `Even a restart didn't apply it. Whoever looks after this PC may have to add your account to Docker's group by hand; until then, your sandbox can run on a machine we host.`;
    }
    if (signOutAgain.value) {
        return `Signing out and back in didn't refresh it on this PC. A restart always does: your setup is saved and continues on its own once you're back.`;
    }
    if (restarting.value || signingOut.value) {
        return `Your setup is saved: this window picks it up again once you're back.`;
    }
    return undefined;
});
</script>

<template>
    <div class="flex flex-col gap-4">
        <p v-if="stuck || many" class="text-sm text-content">
            {{ stuck ? `This device can't run a sandbox yet:` : `Before your sandbox can run here:` }}
        </p>

        <ul class="flex flex-col gap-2.5">
            <li v-for="requirement in requirements" :key="requirement.id" class="entry-card p-3.5">
                <div class="flex items-start gap-3">
                    <!-- Live state overrides the static action icon once something is actually happening. -->
                    <Icon v-if="stateOf(requirement.id)?.state === `running`" name="spinner" spin class="mt-0.5 shrink-0 text-link" />
                    <Icon v-else-if="stateOf(requirement.id)?.state === `done`" name="check-circle" class="mt-0.5 shrink-0 text-success" />
                    <Icon
                        v-else
                        :name="stateOf(requirement.id)?.state === `failed` ? `times` : ICON[requirement.action]"
                        class="mt-0.5 shrink-0"
                        :class="
                            stateOf(requirement.id)?.state === `failed`
                                ? 'text-danger'
                                : requirement.action === `fix` || requirement.action === `fixElevated`
                                  ? 'text-link'
                                  : 'text-warning'
                        "
                    />
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                        <div class="flex flex-wrap items-baseline gap-x-2">
                            <!-- The heading of whatever is in the way, and the loudest text on the card while it is up. -->
                            <span class="text-sm font-medium text-content">{{ requirement.title }}</span>
                            <span v-if="badgeOf(requirement)" class="text-2xs text-subtle">{{ badgeOf(requirement) }}</span>
                        </div>
                        <p class="text-xs leading-relaxed text-muted">{{ requirement.problem }}</p>
                        <!-- Live detail replaces the static remedy once the row is running; after a failure it is the reason, and what to do. -->
                        <p
                            v-if="stateOf(requirement.id)?.detail"
                            class="text-xs leading-relaxed"
                            :class="stateOf(requirement.id)?.state === `failed` ? 'text-content' : 'text-subtle'"
                        >
                            {{ stateOf(requirement.id)?.detail }}
                        </p>
                        <p v-else-if="remedyOf(requirement)" class="text-xs leading-relaxed text-subtle">{{ remedyOf(requirement) }}</p>
                        <button v-if="requirement.detail" type="button" :class="ui.linkButton()" @click="toggle(requirement.id)">
                            {{ opened[requirement.id] ? `Hide the steps` : `Show me how` }}
                        </button>
                    </div>
                </div>
                <!-- Verbatim and monospace: reflowing would break the alignment of these steps. -->
                <pre
                    v-if="requirement.detail && opened[requirement.id]"
                    class="mt-2 max-h-72 overflow-auto rounded-md border border-line bg-canvas p-2.5 font-mono text-2xs leading-relaxed text-muted whitespace-pre-wrap"
                    >{{ requirement.detail }}</pre>
            </li>
        </ul>

        <!-- Shown before the click, so an expected elevation prompt doesn't read as something going wrong. -->
        <!-- Hidden once busy: the prompt has already happened or is happening by then. -->
        <p v-if="needsAdmin && ours && !busy" class="text-xs text-subtle">Windows will ask for permission once.</p>

        <!-- Buttons hide once busy: progress lives in the rows above, not in a disabled button beside them. -->
        <!-- The hosted alternative rides the same row, right-aligned: it is the other answer to this question, not a footnote under it. -->
        <div v-if="!busy" class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button v-if="ours" :label="doLabel" @click="emit(`install`)">
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <Button v-if="restarting || signOutAgain" label="Restart now" @click="emit(`restart`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <Button v-else-if="signingOut && !signOutExhausted" label="Sign out now" @click="emit(`signout`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <!-- The only control when nothing here can act: primary, so a screen with one honest move shows it as one. -->
            <Button :severity="stuck ? undefined : `secondary`" :text="!stuck" label="Check again" @click="emit(`recheck`)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <!-- The one escape hatch: run in a hosted browser instead, when this device can't meet the requirements. -->
            <button type="button" :class="ui.textAction()" @click="emit(`elsewhere`)">
                <Icon name="server" class="shrink-0" />
                <span>Run it on a machine we host</span>
            </button>
        </div>
        <p v-if="sessionNote && !busy" class="text-xs leading-relaxed text-subtle">{{ sessionNote }}</p>
    </div>
</template>
