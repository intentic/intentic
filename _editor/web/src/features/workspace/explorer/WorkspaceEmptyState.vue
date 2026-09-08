<!-- Shown in the viewer pane when no file is open. -->
<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Button, Notice, type NoticeModel, vAction } from "@intentic/ui";
import { startAgent } from "../../agents/fleet/agentActions";
import { useAddRepo } from "./useAddRepo";

// An empty workspace spells out every way to get code in; a workspace with files needs only the drop target.
// `empty` is read off the tree by the view that owns it: this pane never fetches.
const props = defineProps<{ empty: boolean }>();
const emit = defineEmits<{ pick: [] }>();

const { addRepo, cloning, error } = useAddRepo();
// Clone form opens inline instead of on its own route.
const cloneOpen = ref(false);
const cloneUrl = ref(``);
const cloneField = ref<HTMLInputElement | undefined>(undefined);
const canClone = computed(() => cloneUrl.value.trim().length > 0 && !cloning.value);
// Notice built from the daemon's error: title names the failure, detail is the daemon's message.
const cloneNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't clone that repository.`, detail: error.value },
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
        <!-- Non-empty workspace: just the drop target. -->
        <template v-if="!props.empty">
            <button
                type="button"
                class="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line px-10 py-8 transition-colors hover:border-primary-500 hover:bg-primary-600/5 focus:outline-none focus-visible:border-primary-500"
                @click="emit('pick')"
            >
                <Icon name="upload" class="text-3xl text-subtle" />
                <p class="text-base font-semibold text-content">Drop your work here</p>
                <p class="max-w-xs text-xs text-muted">Then ask chat to organize, refactor, or explain it: it edits this working tree for you.</p>
            </button>
        </template>

        <!-- Empty workspace: every way in, most common first. -->
        <template v-else>
            <div class="flex max-w-md flex-col gap-1">
                <p class="text-base font-semibold text-content">Get your code in</p>
                <p class="text-xs text-muted">
                    This is the workspace your agents read and edit. Bring something in and they have something to work on.
                </p>
            </div>

            <div class="flex w-full max-w-md flex-col gap-2 text-left">
                <!-- 1: repository, the common case. -->
                <div class="rounded-xl border border-line bg-card p-3">
                    <button v-if="!cloneOpen" type="button" class="flex w-full items-center gap-3 text-left" v-action="openClone">
                        <Icon name="code" class="shrink-0 text-lg text-link" />
                        <span class="min-w-0 flex-1">
                            <span class="block text-xs font-semibold text-content">Clone a repository</span>
                            <span class="block text-2xs text-muted">Paste a Git address: GitHub, GitLab, anywhere you can clone from.</span>
                        </span>
                        <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                    </button>
                    <form v-else class="flex flex-col gap-2" @submit.prevent="submitClone">
                        <label class="text-2xs font-semibold text-content" for="clone-url">Repository address</label>
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
                                <Icon :name="cloning ? `spinner` : `arrow-down-left`" :spin="cloning" />{{ cloning ? "Cloning…" : "Clone" }}
                            </Button>
                        </div>
                        <!-- Message comes from the daemon's refusal, not guessed ahead of it. -->
                        <Notice v-if="cloneNotice !== undefined" :of="cloneNotice" />
                        <p class="text-2xs text-subtle">A private repository needs its host connected under Capabilities first.</p>
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
                        <span class="block text-xs font-semibold text-content">Upload files or a folder</span>
                        <span class="block text-2xs text-muted">Or drag them anywhere onto this panel.</span>
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
                        <span class="block text-xs font-semibold text-content">Ask an agent to fetch it</span>
                        <span class="block text-2xs text-muted">For code somewhere else: a private host, a server, an archive.</span>
                    </span>
                </button>
            </div>
        </template>

        <span class="inline-flex items-center gap-1.5 rounded-full bg-subtle/10 px-2.5 py-1 text-2xs font-medium text-subtle">
            <Icon name="lock" class="text-[0.7rem]" />
            Files stay on your sandbox machine: nowhere else
        </span>
    </div>
</template>
