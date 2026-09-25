<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useT } from "@intentic/ui/i18n";

// Creates a running extension, not a project: the dialog only asks for a name, and further decisions are made by
// editing the two files it writes. Publisher defaults to `workspace`, a placeholder to replace before publishing
// under a real identity.

const t = useT();

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

// Trimmed before testing, and the trimmed value is what gets created: pasting a name is how a trailing space arrives,
// and refusing it without saying so reads as a broken button.
const cleanPublisher = computed(() => publisher.value.trim());
const cleanSlug = computed(() => name.value.trim());
const ready = computed(() => SLUG.test(cleanPublisher.value) && SLUG.test(cleanSlug.value));
// Which of the two boxes is wrong, said only once the box has something in it to be wrong about.
const slugProblem = (value: string): string | undefined =>
    value.length === 0 || SLUG.test(value) ? undefined : `Lower case letters, digits and hyphens, starting with a letter or digit.`;
const publisherProblem = computed(() => slugProblem(cleanPublisher.value));
const nameProblem = computed(() => slugProblem(cleanSlug.value));

const submit = async (): Promise<void> => {
    // Re-entry drops: the keyboard path reaches this directly, and each call writes a directory.
    if (busy.value || !ready.value) {
        return;
    }
    busy.value = true;
    failure.value = undefined;
    try {
        const created = await create(cleanPublisher.value, cleanSlug.value);
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
    <Modal v-model:open="open" size="md" :header="t(`sandbox.words.newExtension`)">
        <div class="flex flex-col gap-4">
            <p class="text-2xs text-subtle">
                {{ t(`sandbox.newExtensionDialog.writesWorkingExtensionInto`) }}
            </p>

            <div class="flex items-end gap-2">
                <label class="flex flex-col gap-1" :style="{ width: '9rem' }">
                    <span :class="ui.sectionLabel()">{{ t(`sandbox.newExtensionDialog.publisher`) }}</span>
                    <input v-model="publisher" :class="ui.input()" spellcheck="false" />
                </label>
                <span class="pb-2 text-subtle">.</span>
                <label class="flex flex-1 flex-col gap-1">
                    <span :class="ui.sectionLabel()">{{ t(`shared.name`) }}</span>
                    <input v-model="name" :class="ui.input()" placeholder="release-notes" spellcheck="false" autofocus @keyup.enter="submit()" />
                </label>
            </div>
            <!-- The rule at rest; once a box holds something that breaks it, the same line names which box and turns
                 to a warning, rather than leaving Create greyed out with nothing pointing at the cause. -->
            <span v-if="publisherProblem || nameProblem" class="text-2xs text-warning">
                {{ publisherProblem ? t(`sandbox.newExtensionDialog.publisher`) : t(`shared.name`) }}:
                {{ publisherProblem ?? nameProblem }}
            </span>
            <span v-else class="text-2xs text-subtle">
                {{ t(`sandbox.newExtensionDialog.lowerCaseDigitsHyphens`) }}
                <template v-if="ready"
                    >{{ t(`sandbox.newExtensionDialog.listed`) }} <code class="ui-code">{{ cleanPublisher }}.{{ cleanSlug }}</code
                    >.</template
                >
            </span>

            <!-- Optional, and last: empty leaves a stub to edit by hand, filled starts an agent on it before dialog closes. -->
            <label class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">{{ t(`sandbox.newExtensionDialog.whatShouldDo`) }}</span>
                <textarea v-model="wish" :class="ui.input()" rows="3" :placeholder="t(`sandbox.newExtensionDialog.showWhatShippedWeek`)"></textarea>
                <span class="text-2xs text-subtle">
                    {{ t(`sandbox.newExtensionDialog.optionalSayInOwn`) }}
                </span>
            </label>

            <Notice v-if="failure" :of="failure" />
        </div>

        <template #footer>
            <Button :label="t(`ui.action.cancel`)" severity="secondary" text @click="open = false" />
            <Button
                :label="wish.trim() === `` ? t(`ui.action.create`) : t(`sandbox.newExtensionDialog.createStart`)"
                :loading="busy"
                :disabled="!ready"
                @click="submit"
            >
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>
    </Modal>
</template>
