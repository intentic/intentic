<!-- Shown in the viewer pane when the workspace holds no files at all; with files, that pane is the desk. -->
<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Button, Notice, type NoticeModel, vAction } from "@intentic/ui";
import { useAudience } from "../../../app/useAudience";
import AudienceAsk from "../../../components/AudienceAsk.vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { useAddRepo } from "./useAddRepo";
import { useT } from "@intentic/ui/i18n";

// An empty workspace spells out every way to get code in. Emptiness is read off the tree by the view that owns it
// (EditorPane's `empty`): this pane never fetches, and never renders once there is something to draw.
const t = useT();

const emit = defineEmits<{ pick: [] }>();

const { addRepo, cloning, error } = useAddRepo();
// Asked here, where a new arrival first stands, until answered once in this browser.
const { chosen: audienceChosen } = useAudience();
// Clone form opens inline instead of on its own route.
const cloneOpen = ref(false);
const cloneUrl = ref(``);
const cloneField = ref<HTMLInputElement | undefined>(undefined);
const canClone = computed(() => cloneUrl.value.trim().length > 0 && !cloning.value);
// Notice built from the daemon's error: title names the failure, detail is the daemon's message.
const cloneNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: t(`workspace.workspaceEmptyState.couldntCloneRepository`), detail: error.value },
);

const openClone = async (): Promise<void> => {
    cloneOpen.value = true;
    await nextTick();
    cloneField.value?.focus();
};
const submitClone = async (): Promise<void> => {
    if (!canClone.value) {
        return;
    }
    // On failure, keep the typed URL: the fix is usually an edit, not a retype.
    if (await addRepo(cloneUrl.value)) {
        cloneUrl.value = ``;
        cloneOpen.value = false;
    }
};
// Catch-all for code not on a host or this machine: private host setup, tarball, remote checkout.
// The agent has shell and credentials to fetch it.
const askAgent = (): void => {
    startAgent(`Help me get my code into this workspace. Ask me where it currently lives before you do anything.`);
};
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
        <!-- The newcomer's screen only, and only until answered; Settings holds the question afterwards. -->
        <AudienceAsk v-if="!audienceChosen" />

        <!-- Every way in, most common first. -->
        <div class="flex max-w-md flex-col gap-1">
            <p class="text-base font-semibold text-content">{{ t(`workspace.workspaceEmptyState.getCodeIn`) }}</p>
            <p class="text-xs text-muted">
                {{ t(`workspace.workspaceEmptyState.workspaceAgentsReadEdit`) }}
            </p>
        </div>

        <div class="flex w-full max-w-md flex-col gap-2 text-left">
            <!-- 1: repository, the common case. -->
            <div class="rounded-xl border border-line bg-card p-3">
                <button v-if="!cloneOpen" type="button" class="flex w-full items-center gap-3 text-left" v-action="openClone">
                    <Icon name="code" class="shrink-0 text-lg text-link" />
                    <span class="min-w-0 flex-1">
                        <span class="block text-xs font-semibold text-content">{{ t(`workspace.workspaceEmptyState.cloneRepository`) }}</span>
                        <span class="block text-2xs text-muted">{{ t(`workspace.workspaceEmptyState.pasteGitAddressGithub`) }}</span>
                    </span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                </button>
                <form v-else class="flex flex-col gap-2" @submit.prevent="submitClone">
                    <label class="text-2xs font-semibold text-content" for="clone-url">{{
                        t(`workspace.workspaceEmptyState.repositoryAddress`)
                    }}</label>
                    <div class="flex items-center gap-2">
                        <input
                            id="clone-url"
                            ref="cloneField"
                            v-model="cloneUrl"
                            type="text"
                            :disabled="cloning"
                            placeholder="https://github.com/owner/repo.git"
                            class="ui-field-box ui-field-sm min-w-0 flex-1"
                        />
                        <Button size="small" type="submit" :disabled="!canClone" class="shrink-0">
                            <Icon :name="cloning ? `spinner` : `arrow-down-left`" :spin="cloning" />{{
                                cloning ? t(`workspace.workspaceEmptyState.cloning`) : t(`workspace.workspaceEmptyState.clone`)
                            }}
                        </Button>
                    </div>
                    <!-- Message comes from the daemon's refusal, not guessed ahead of it. -->
                    <Notice v-if="cloneNotice !== undefined" :of="cloneNotice" />
                    <p class="text-2xs text-subtle">{{ t(`workspace.workspaceEmptyState.privateRepositoryNeedsHost`) }}</p>
                </form>
            </div>

            <!-- 2: local files; drag-and-drop still works over the whole pane, this is just its button. -->
            <button
                type="button"
                class="flex items-center gap-3 rounded-xl border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay"
                @click="emit('pick')"
            >
                <Icon name="upload" class="shrink-0 text-lg text-subtle" />
                <span class="min-w-0 flex-1">
                    <span class="block text-xs font-semibold text-content">{{ t(`workspace.workspaceEmptyState.uploadFilesFolder`) }}</span>
                    <span class="block text-2xs text-muted">{{ t(`workspace.workspaceEmptyState.dragAnywhereOntoPanel`) }}</span>
                </span>
            </button>

            <!-- 3: anything else; the agent has shell and credentials to fetch it. -->
            <button
                type="button"
                class="flex items-center gap-3 rounded-xl border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay"
                @click="askAgent"
            >
                <Icon name="robot" class="shrink-0 text-lg text-subtle" />
                <span class="min-w-0 flex-1">
                    <span class="block text-xs font-semibold text-content">{{ t(`workspace.workspaceEmptyState.askAgentToFetch`) }}</span>
                    <span class="block text-2xs text-muted">{{ t(`workspace.workspaceEmptyState.codeSomewhereElsePrivate`) }}</span>
                </span>
            </button>
        </div>

        <span class="inline-flex items-center gap-1.5 rounded-full bg-subtle/10 px-2.5 py-1 text-2xs font-medium text-subtle">
            <Icon name="lock" class="text-[0.7rem]" />
            {{ t(`workspace.workspaceEmptyState.filesStayOnSandbox`) }}
        </span>
    </div>
</template>
