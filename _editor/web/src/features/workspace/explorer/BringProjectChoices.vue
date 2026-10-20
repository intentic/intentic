<!-- Every way to put code in the workspace: a Git address, files from this computer, or an agent. Shared by the empty
     workspace and the "Bring a project in" dialog, so the choices read the same wherever they are asked. -->
<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Button, Notice, vAction } from "@intentic/ui";
import { useRouter } from "vue-router";
import { startAgent } from "../../../models/fleet/agentActions";
import { useAddRepo } from "./useAddRepo";
import { repoNameFromUrl } from "../health/repoName";
import ProgressMeter from "../../../components/progress/ProgressMeter.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();
const router = useRouter();

// `pick` opens the page's file picker; `done` says something was started, so a dialog around this can close.
const emit = defineEmits<{ pick: []; done: [] }>();

const { addRepo, cloning, failure: cloneNotice, url: cloningUrl, meter: cloneWait } = useAddRepo();
// The daemon runs `git clone` to the end in one request, so there is no progress to read: only how long it has run,
// and what it is, said beneath the held button.
const cloningName = computed(() => repoNameFromUrl(cloningUrl.value ?? ``));
// Clone form opens inline instead of on its own route. A pane that comes back over a clone still running, or one that
// failed while it was away, opens on it with the address it was given.
const cloneOpen = ref(cloning.value || cloneNotice.value !== undefined);
const cloneUrl = ref(cloningUrl.value ?? ``);
const cloneField = ref<HTMLInputElement | undefined>(undefined);
const canClone = computed(() => cloneUrl.value.trim().length > 0 && !cloning.value);

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
        emit(`done`);
    }
};
// Catch-all for code not on a host or this machine: private host setup, tarball, remote checkout.
// The agent has shell and credentials to fetch it.
const askAgent = (): void => {
    startAgent(`Help me get my code into this workspace. Ask me where it currently lives before you do anything.`);
    emit(`done`);
};
// A private repository is the one case that needs an account: connect it here, at that point, rather than up front.
const connectHost = (): void => {
    emit(`done`);
    void router.push({ name: `capabilities`, params: { entry: `github` } });
};
</script>

<template>
    <div class="flex w-full flex-col gap-2 text-left">
        <!-- 1: repository, the common case. -->
        <div class="rounded-xl bg-card shadow-sm p-3">
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
                <ProgressMeter v-if="cloneWait" :progress="cloneWait" :what="t(`workspace.bringProject.cloningWhat`, { name: cloningName })" />
                <!-- Message comes from the daemon's refusal, not guessed ahead of it. -->
                <Notice v-if="cloneNotice !== undefined" :of="cloneNotice" />
                <p class="text-2xs text-subtle">{{ t(`workspace.bringProject.publicNeedsNoAccount`) }}</p>
                <p class="text-2xs text-subtle">
                    {{ t(`workspace.bringProject.privateNeedsAccount`) }}
                    <button type="button" class="text-link hover:underline" @click="connectHost">{{ t(`workspace.bringProject.connectAccount`) }}</button>
                </p>
            </form>
        </div>

        <!-- 2: local files; drag-and-drop still works over the whole pane, this is just its button. -->
        <button
            type="button"
            class="flex items-center gap-3 rounded-xl bg-card shadow-sm p-3 text-left transition-colors hover:bg-overlay"
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
            class="flex items-center gap-3 rounded-xl bg-card shadow-sm p-3 text-left transition-colors hover:bg-overlay"
            @click="askAgent"
        >
            <Icon name="robot" class="shrink-0 text-lg text-subtle" />
            <span class="min-w-0 flex-1">
                <span class="block text-xs font-semibold text-content">{{ t(`workspace.workspaceEmptyState.askAgentToFetch`) }}</span>
                <span class="block text-2xs text-muted">{{ t(`workspace.workspaceEmptyState.codeSomewhereElsePrivate`) }}</span>
            </span>
        </button>
    </div>
</template>
