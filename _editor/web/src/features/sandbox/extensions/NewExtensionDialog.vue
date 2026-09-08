<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";

// Creates a running extension, not a project: the dialog only asks for a name, and further decisions are made by
// editing the two files it writes. Publisher defaults to `workspace`, a placeholder to replace before publishing
// under a real identity.

const open = defineModel<boolean>({ required: true });
// `wish` is the author's own words, untouched: the tab turns it into the agent's brief.
const emit = defineEmits<{ created: [{ id: string; dir: string; wish: string }] }>();
const { create } = defineProps<{ create: (publisher: string, name: string) => Promise<{ id: string; dir: string }> }>();

// Mirrors the manifest schema's slug rule: `name` becomes a directory, so a rejected value can't be written.
const SLUG = /^[a-z0-9][a-z0-9-]*$/u;

const publisher = ref(`workspace`);
const name = ref(``);
const wish = ref(``);
const busy = ref(false);
const failure = ref<NoticeModel>();

// Resets name, wish and any previous failure so a second extension doesn't inherit the first one's state.
watch(open, (shown) => {
    if (shown) {
        name.value = ``;
        wish.value = ``;
        failure.value = undefined;
    }
});

const ready = computed(() => SLUG.test(publisher.value) && SLUG.test(name.value));

const submit = async (): Promise<void> => {
    busy.value = true;
    failure.value = undefined;
    try {
        const created = await create(publisher.value, name.value);
        open.value = false;
        emit(`created`, { ...created, wish: wish.value.trim() });
    } catch (error) {
        failure.value = noticeFrom(error, `The extension could not be created.`);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <Modal v-model:open="open" size="md" header="New extension">
        <div class="flex flex-col gap-4">
            <p class="text-2xs text-subtle">
                Writes a working extension into this workspace and switches it on. Nothing is installed and nothing is built: the files are what runs,
                so an edit shows up on the next reload.
            </p>

            <div class="flex items-end gap-2">
                <label class="flex flex-col gap-1" :style="{ width: '9rem' }">
                    <span :class="ui.sectionLabel()">Publisher</span>
                    <input v-model="publisher" :class="ui.input()" spellcheck="false" />
                </label>
                <span class="pb-2 text-subtle">.</span>
                <label class="flex flex-1 flex-col gap-1">
                    <span :class="ui.sectionLabel()">Name</span>
                    <input
                        v-model="name"
                        :class="ui.input()"
                        placeholder="release-notes"
                        spellcheck="false"
                        autofocus
                        @keyup.enter="ready && submit()"
                    />
                </label>
            </div>
            <!-- States the rule once for both fields: lower case, digits and hyphens, starting with a letter or digit. -->
            <span class="text-2xs text-subtle">
                Lower case, digits and hyphens.
                <template v-if="ready"
                    >It will be listed as <code class="ui-code">{{ publisher }}.{{ name }}</code
                    >.</template
                >
            </span>

            <!-- Optional, and last: empty leaves a stub to edit by hand, filled starts an agent on it before dialog closes. -->
            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">What should it do?</span>
                <textarea v-model="wish" :class="ui.input()" rows="3" placeholder="show what shipped this week, read from the git log"></textarea>
                <span class="text-2xs text-subtle">
                    Optional. Say it in your own words: an agent starts on it in a chat you can watch and argue with. Leave it empty for a working
                    stub to edit yourself.
                </span>
            </label>

            <Notice v-if="failure" :of="failure" />
        </div>

        <template #footer>
            <Button label="Cancel" severity="secondary" text @click="open = false" />
            <Button :label="wish.trim() === `` ? `Create` : `Create and start`" :loading="busy" :disabled="!ready" @click="submit">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>
    </Modal>
</template>
