<!-- Shown in the viewer pane when no file is open. -->
<script setup lang="ts">
import Button from "primevue/button";
import { computed, nextTick, ref } from "vue";
import { Notice, type NoticeModel } from "@intentic/ui";
import { startAgent } from "../../composables/agents/agentActions";
import { useAddRepo } from "../../composables/workspace/useAddRepo";

/* TWO DIFFERENT SILENCES SHARE THIS PANE, and they used to get the same screen. A workspace with code in it and
 * no file open is a reader between files: they know what this place is, and the drop target is a footnote. A
 * workspace with NOTHING in it is somebody who has come here to get their work in and has not done it yet:
 * this is where setup lands them, and for them this pane is the entire product: whatever it offers is what
 * they will believe the options are.
 *
 * It offered one, and the wrong one. "Drop your work here" is a file upload, and most people's code is on a
 * host, so the screen that greets an empty workspace asked them to drag their repository into a browser and
 * mentioned no alternative. The three ways code actually gets in are all here now, repository first because it
 * is the common one.
 *
 * `empty` is read off the tree by the view that owns it: this pane never fetches. */
const props = defineProps<{ empty: boolean }>();
const emit = defineEmits<{ pick: [] }>();

const { addRepo, cloning, error } = useAddRepo();
// The clone form opens in place rather than on its own screen: it is one field, and a route change to collect
// one URL is a heavier promise than the action behind it.
const cloneOpen = ref(false);
const cloneUrl = ref(``);
const cloneField = ref<HTMLInputElement | undefined>(undefined);
const canClone = computed(() => cloneUrl.value.trim().length > 0 && !cloning.value);
// The daemon's sentence is the DETAIL, under a title that says which action failed: the app's one failure
// shape (see Notice), rather than a bare string in a red box.
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
    // Keep the typed URL on failure: the error is usually about credentials or a typo, and both are edits to
    // what is already in the box rather than reasons to retype it.
    if (await addRepo(cloneUrl.value)) {
        cloneUrl.value = ``;
        cloneOpen.value = false;
    }
};
// The door for code that is neither on a host nor on this machine: a private host needing setup, a tarball, a
// checkout on a server. The agent has the shell and the credentials, so the honest answer is to ask it.
const askAgent = (): void => {
    startAgent(`Help me get my code into this workspace. Ask me where it currently lives before you do anything.`);
};
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
        <!-- THE FULL WORKSPACE'S VERSION: a reader between files needs the drop target and nothing else. -->
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

        <!-- THE EMPTY WORKSPACE'S VERSION: every way in, most common first. -->
        <template v-else>
            <div class="flex max-w-md flex-col gap-1">
                <p class="text-base font-semibold text-content">Get your code in</p>
                <p class="text-xs text-muted">
                    This is the workspace your agents read and edit. Bring something in and they have something to work on.
                </p>
            </div>

            <div class="flex w-full max-w-md flex-col gap-2 text-left">
                <!-- 1: A REPOSITORY. The common case, so it leads and it is the one that is spelled out. -->
                <div class="rounded-xl border border-line bg-card p-3">
                    <button v-if="!cloneOpen" type="button" class="flex w-full items-center gap-3 text-left" @click="openClone">
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
                                class="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2 py-1.5 text-xs text-content placeholder:text-subtle focus:border-primary-500 focus:outline-none"
                            />
                            <Button size="small" type="submit" :disabled="!canClone" class="shrink-0">
                                <Icon :name="cloning ? `spinner` : `arrow-down-left`" :spin="cloning" />{{ cloning ? "Cloning…" : "Clone" }}
                            </Button>
                        </div>
                        <!-- Private repositories need the host connected first; the daemon's refusal says so,
                             so the message is passed through rather than guessed at ahead of it. -->
                        <Notice v-if="cloneNotice !== undefined" :of="cloneNotice" />
                        <p class="text-2xs text-subtle">A private repository needs its host connected under Capabilities first.</p>
                    </form>
                </div>

                <!-- 2: FILES FROM THIS MACHINE. The original door, kept whole (drag-and-drop still works over
                     the whole pane; this is its button). -->
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

                <!-- 3: ANYTHING ELSE. The agent has a shell and the credentials, so it is the general case. -->
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
