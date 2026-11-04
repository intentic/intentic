<!-- Every way to put code in the workspace: a Git address, files from this computer, or an agent. Shared by the empty
     workspace and the "Bring a project in" dialog, so the choices read the same wherever they are asked. -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Button } from "@intentic/ui";
import { useRouter } from "vue-router";
import { here, page } from "../../../lib/routes/links";
import { startAgent } from "../../../models/fleet/agentActions";
import { useAddRepo } from "./useAddRepo";
import { useT } from "@intentic/ui/i18n";
import { useWorkspaceTree } from "../../../models/workspace/tree/useWorkspaceTree";
import { workspaceDir } from "../../../app/workspaceScope";

const t = useT();
const router = useRouter();

// A dialog puts the keyboard in the address field (its box focuses the first `[autofocus]` once it has opened); the
// empty workspace leaves it where the reader put it.
const { autofocus = false } = defineProps<{ autofocus?: boolean }>();
// `pick` opens the page's file picker; `done` says something was started, so a dialog around this can close.
const emit = defineEmits<{ pick: []; done: [] }>();

// Each way in is offered only where the member may change files: a clone lands at the workspace's root, an upload in
// the folder the explorer is rooted at. An agent fetching the code is the member's agents' to answer, not this list's.
const { canWriteAt } = useWorkspaceTree();
const clones = computed(() => canWriteAt(``));
const uploads = computed(() => canWriteAt(workspaceDir.value));

// The address is the common case, so its field is open from the start. A clone runs in the background (useAddRepo):
// the press clears the field and lets a dialog close, and the notification lane follows it from there. A form that
// comes back over a failed clone opens on the address it was given, beside why it failed.
const { addRepo, failure, failedUrl } = useAddRepo();
const cloneUrl = ref(failedUrl.value ?? ``);
watch(failedUrl, (url) => {
    if (url !== undefined && cloneUrl.value.trim() === ``) {
        cloneUrl.value = url;
    }
});
const canClone = computed(() => cloneUrl.value.trim().length > 0);
const refusedOutright = computed(() => failure.value !== undefined && failure.value.tone !== `info`);

const submitClone = (): void => {
    if (canClone.value && addRepo(cloneUrl.value)) {
        cloneUrl.value = ``;
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
    void router.push(here(page.capabilities(`github`)));
};
</script>

<template>
    <div class="flex w-full flex-col gap-4 text-left">
        <!-- 1: a repository, the common case. -->
        <form v-if="clones" class="flex flex-col gap-1.5" @submit.prevent="submitClone">
            <label class="text-xs font-medium text-content" for="clone-url">{{ t(`workspace.workspaceEmptyState.repositoryAddress`) }}</label>
            <div class="flex items-center gap-2">
                <input
                    id="clone-url"
                    :autofocus="autofocus"
                    v-model="cloneUrl"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="https://github.com/owner/repo"
                    class="ui-field-box ui-field-sm min-w-0 flex-1"
                    :class="{ 'ui-field-error-box': refusedOutright }"
                />
                <Button tier="accent" size="small" type="submit" :disabled="!canClone" :label="t(`workspace.workspaceEmptyState.clone`)" class="shrink-0" />
            </div>
            <!-- The field's own error line, in the daemon's words (it knows whether it's a reserved name, an unreachable
                 host or missing credentials), not guessed ahead of it. A refusal that is only news (already cloning) is quiet. -->
            <span v-if="failure !== undefined" :class="refusedOutright ? `ui-field-error` : `text-2xs text-muted`">
                <Icon v-if="refusedOutright" name="exclamation-triangle" class="text-2xs" />
                {{ failure.detail ?? failure.title }}
            </span>
            <p class="text-2xs text-subtle">
                {{ t(`workspace.bringProject.privateRepository`) }}
                <button type="button" class="text-link hover:underline" @click="connectHost">{{ t(`workspace.bringProject.connectAccount`) }}</button>
            </p>
        </form>

        <p v-if="clones" class="flex items-center gap-3 text-2xs text-subtle" aria-hidden="true">
            <span class="h-px flex-1 bg-line"></span>{{ t(`workspace.bringProject.or`) }}<span class="h-px flex-1 bg-line"></span>
        </p>

        <!-- 2 and 3: the alternatives, side by side. Dropping files anywhere on the panel still works; this is its button. -->
        <div class="grid gap-2" :class="uploads ? `grid-cols-2` : ``">
            <Button
                v-if="uploads"
                tier="boring"
                size="small"
                :label="t(`workspace.bringProject.uploadFiles`)"
                v-tooltip.bottom="{ title: t(`workspace.bringProject.dropTitle`), note: t(`workspace.bringProject.dropNote`) }"
                @click="emit(`pick`)"
            >
                <template #icon><Icon name="upload" /></template>
            </Button>
            <Button
                tier="boring"
                size="small"
                :label="t(`workspace.bringProject.askAgent`)"
                v-tooltip.bottom="{ title: t(`workspace.bringProject.agentTitle`), note: t(`workspace.bringProject.agentNote`) }"
                @click="askAgent"
            >
                <template #icon><Icon name="robot" /></template>
            </Button>
        </div>
    </div>
</template>
