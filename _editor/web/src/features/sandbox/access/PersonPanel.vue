<script setup lang="ts">
import type { AgentAccess } from "@intentic/sandbox-contract/schemas/members";
import { Button, Notice, type NoticeModel, SegmentedControl, ui } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { type AccessDraft, draftGrant, draftProblem, drivesAgents } from "./accessGrant";
import AreaPicker from "./AreaPicker.vue";
import EditPicker from "./EditPicker.vue";
import PersonCard from "./PersonCard.vue";
import ReachPicker from "./ReachPicker.vue";
import { usePersonaReach } from "./usePersonaReach";
import { useT } from "@intentic/ui/i18n";

// ONE PERSON'S ACCESS, opened under their tile: whether their conversations run agents, where they see, where they edit
// by hand, what their agents may spend, whether they manage the sandbox, and how they sign in. Changes save as they are
// made, like a persona's: a run of clicks is one write, and an answer the daemon would refuse (a chat with no area, a
// narrowed scope with nothing ticked) waits here, said, instead of being sent. Mounted once per person, so a draft never
// carries from one to the next; one still waiting when the panel closes is sent on its way out.

const t = useT();

const {
    email,
    pending,
    initial,
    busy = false,
    notice,
} = defineProps<{
    email: string;
    // Whether their invite is still out, for the line under the address and its Resend.
    pending: boolean;
    // What the daemon holds for them, read once when the panel opens.
    initial: AccessDraft;
    busy?: boolean;
    notice?: NoticeModel | undefined;
}>();
const emit = defineEmits<{ save: [email: string, draft: AccessDraft]; remove: [email: string]; resend: [email: string] }>();

const draft = ref<AccessDraft>(initial);
const set = (change: Partial<AccessDraft>): void => {
    draft.value = { ...draft.value, ...change };
};

const { namesOf } = usePersonaReach();
const problem = computed(() => draftProblem(draft.value, namesOf(draft.value.see).length));
// Whether what is on screen is not yet what the daemon holds, compared as the grant each would send.
const saved = ref(JSON.stringify(draftGrant(email, initial)));
const dirty = computed(() => JSON.stringify(draftGrant(email, draft.value)) !== saved.value);

// Debounced, since several flips or a few ticks are one intent, not one write each.
const DEBOUNCE_MS = 600;
let timer: ReturnType<typeof setTimeout> | undefined;
const flush = (): void => {
    timer = undefined;
    if (problem.value !== undefined || !dirty.value) {
        return;
    }
    saved.value = JSON.stringify(draftGrant(email, draft.value));
    emit(`save`, email, draft.value);
};
watch(draft, () => {
    clearTimeout(timer);
    timer = problem.value === undefined && dirty.value ? setTimeout(flush, DEBOUNCE_MS) : undefined;
});
// A refused save leaves the draft standing as unsaved, so a retry is the next change rather than a lost one.
watch(
    () => notice,
    (now) => {
        if (now !== undefined) {
            saved.value = JSON.stringify(draftGrant(email, initial));
        }
    },
);
onBeforeUnmount(() => {
    if (timer !== undefined) {
        clearTimeout(timer);
        flush();
    }
});

// What the panel says of its own state, beside the address: held back, on its way, or what the daemon holds.
interface SaveStatus {
    readonly text: string;
    readonly tone: `muted` | `success` | `warning`;
}
const status = computed((): SaveStatus => {
    if (problem.value !== undefined || notice !== undefined) {
        return { text: t(`sandbox.sandboxAccess.notSaved`), tone: `warning` };
    }
    if (busy || dirty.value) {
        return { text: t(`sandbox.sandboxAccess.saving`), tone: `muted` };
    }
    return { text: t(`sandbox.sandboxAccess.saved`), tone: `success` };
});

// AGENTS: chatting is the guest's way of working, held to areas; leaving it keeps the areas, and coming to it drops
// hand edits, which a chat never has.
const AGENTS = computed(() => [
    { value: `off` as const, label: t(`sandbox.sandboxAccess.agentsOff`) },
    { value: `chat` as const, label: t(`sandbox.sandboxAccess.agentsChat`) },
    { value: `run` as const, label: t(`sandbox.sandboxAccess.agentsRun`) },
]);
const AGENT_NOTES = {
    off: () => t(`sandbox.sandboxAccess.agentsOffNote`),
    chat: () => t(`sandbox.sandboxAccess.agentsChatNote`),
    run: () => t(`sandbox.sandboxAccess.agentsRunNote`),
} satisfies Record<AgentAccess, () => string>;
const pickAgents = (agents: AgentAccess): void =>
    set(agents === `chat` ? { agents, see: draft.value.see ?? [], edit: `none` } : { agents });

// SEE: editing never reaches past it, so narrowing what they see narrows what they edit with it.
const pickSee = (see: string[] | undefined): void => {
    const { edit } = draft.value;
    const kept = see === undefined || edit === `none` ? edit : edit === `all` ? [...see] : edit.filter((area) => see.includes(area));
    set({ see, edit: kept });
};

// MANAGE: every other answer at once. The answers below are kept while it is on, so turning it off again gives them back;
// a person who managed from the start comes down to running agents across the workspace.
const beforeManage = ref<AccessDraft>();
const pickManage = (on: boolean): void => {
    if (on) {
        beforeManage.value = draft.value;
        set({ manage: true });
        return;
    }
    const back = beforeManage.value;
    set(back === undefined ? { manage: false, agents: `run`, see: undefined, edit: `none` } : { ...back, emailSignIn: draft.value.emailSignIn, manage: false });
};

const PROBLEMS = {
    pickSeeArea: () => t(`sandbox.sandboxAccess.pickSeeArea`),
    pickEditArea: () => t(`sandbox.sandboxAccess.pickEditArea`),
    chatNeedsArea: () => t(`sandbox.sandboxAccess.guestNeedsArea`),
    chatReachesNobody: () => t(`sandbox.sandboxAccess.noAssistantWorksHere`),
    editOutsideSee: () => t(`sandbox.sandboxAccess.editOutsideSee`),
} as const;

const confirmingRemove = ref(false);
const manageId = useId();
const signInId = useId();
</script>

<template>
    <section class="flex flex-col gap-5 rounded-xl bg-card p-4 shadow-sm md:p-5" :aria-label="email">
        <!-- The person as their card draws them, so a long address gives way the same way here; the presses about them
             (send the invite again, take access away) sit after it and drop under it when the panel is narrow. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <PersonCard
                :email="email"
                :line="pending ? t(`sandbox.sandboxAccess.invitePending`) : t(`sandbox.sandboxAccess.member`)"
                :avatar="36"
                flush
                class="min-w-48 flex-1"
            />
            <div class="ml-auto flex shrink-0 items-center gap-1">
                <span
                    class="mr-1 flex items-center gap-1 text-xs"
                    :class="{ 'text-success': status.tone === `success`, 'text-warning': status.tone === `warning`, 'text-muted': status.tone === `muted` }"
                    role="status"
                >
                    <Icon v-if="status.tone === `success`" name="check" class="text-2xs" />{{ status.text }}
                </span>
                <template v-if="confirmingRemove">
                    <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" @click="confirmingRemove = false" />
                    <Button :label="t(`sandbox.sandboxAccess.removeAccess`)" size="small" tone="danger" :loading="busy" @click="emit(`remove`, email)" />
                </template>
                <template v-else>
                    <Button v-if="pending" :label="t(`sandbox.sandboxAccess.resend`)" size="small" tier="quiet" :disabled="busy" @click="emit(`resend`, email)">
                        <template #icon><Icon name="send" /></template>
                    </Button>
                    <Button :label="t(`ui.action.remove`)" size="small" tier="quiet" tone="danger" :disabled="busy" @click="confirmingRemove = true">
                        <template #icon><Icon name="trash" /></template>
                    </Button>
                </template>
            </div>
        </div>

        <Notice v-if="notice" :of="notice" />
        <p v-else-if="problem !== undefined" class="text-xs text-warning">{{ PROBLEMS[problem]() }}</p>

        <p v-if="draft.manage" class="text-sm text-muted">{{ t(`sandbox.sandboxAccess.managesAll`) }}</p>
        <template v-else>
            <div class="flex flex-col gap-2">
                <span :class="ui.sectionLabel({ size: `xs` })">{{ t(`sandbox.sandboxAccess.agentsSection`) }}</span>
                <SegmentedControl :model-value="draft.agents" :options="AGENTS" @update:model-value="pickAgents" />
                <p class="text-xs text-muted">{{ AGENT_NOTES[draft.agents]() }}</p>
            </div>

            <div class="flex flex-col gap-2">
                <span :class="ui.sectionLabel({ size: `xs` })">{{ t(`sandbox.sandboxAccess.seeSection`) }}</span>
                <AreaPicker :picked="draft.see" :chat="draft.agents === `chat`" @change="pickSee" />
            </div>

            <div v-if="draft.agents !== `chat`" class="flex flex-col gap-2">
                <span :class="ui.sectionLabel({ size: `xs` })">{{ t(`sandbox.sandboxAccess.editSection`) }}</span>
                <EditPicker :edit="draft.edit" :see="draft.see" @change="(edit) => set({ edit })" />
            </div>

            <div v-if="drivesAgents(draft.agents)" class="flex flex-col gap-2">
                <span :class="ui.sectionLabel({ size: `xs` })">{{ t(`sandbox.sandboxAccess.reachSection`) }}</span>
                <ReachPicker :reach="draft.credentials" @change="(credentials) => set({ credentials })" />
            </div>
        </template>

        <div class="-mx-1 flex flex-col border-t border-line-subtle pt-3">
            <div class="flex items-center gap-3 px-1 py-1.5">
                <label :for="manageId" class="flex min-w-0 flex-1 cursor-pointer flex-col">
                    <span class="text-sm text-content">{{ t(`sandbox.sandboxAccess.manageSandbox`) }}</span>
                    <span class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.manageSandboxNote`) }}</span>
                </label>
                <ToggleSwitch :input-id="manageId" :model-value="draft.manage" class="ui-switch-sm shrink-0" @update:model-value="pickManage" />
            </div>
            <div class="flex items-center gap-3 px-1 py-1.5">
                <label :for="signInId" class="flex min-w-0 flex-1 cursor-pointer flex-col">
                    <span class="text-sm text-content">{{ t(`sandbox.sandboxAccess.signInWithCode`) }}</span>
                    <span class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.signInWithCodeNote`) }}</span>
                </label>
                <ToggleSwitch
                    :input-id="signInId"
                    :model-value="draft.emailSignIn"
                    class="ui-switch-sm shrink-0"
                    @update:model-value="(on: boolean) => set({ emailSignIn: on })"
                />
            </div>
        </div>
    </section>
</template>
