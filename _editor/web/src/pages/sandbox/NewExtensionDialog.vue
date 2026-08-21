<script setup lang="ts">
import Button from "primevue/button";
import { ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";

/* NEW EXTENSION: the whole form, because there is almost nothing to ask.
 *
 * What this creates is a RUNNING extension, not a project to set up: the daemon writes a manifest and one ESM
 * file that the host loads by its bytes, so there is no install, no build and no first-run failure to debug. That
 * is why the dialog asks for a name and stops. Every other decision an extension eventually needs: what it
 * draws, which files it watches, whether it may reach the daemon at all: is better made against something that
 * already runs than guessed at in a form, and is made by editing the two files this writes (or by asking an
 * agent to).
 *
 * THE PUBLISHER IS A FIELD, not a constant, because it is half of the identity the extension is installed under
 * everywhere (`publisher.name`), and after publication changing it is a rename rather than an edit. It defaults
 * to `workspace`: true of a draft that lives only here, and visibly not a real publisher, so anyone who intends
 * to publish has a reason to set theirs before the name is one people have installed. */

const open = defineModel<boolean>({ required: true });
// `wish` is the author's own words, passed on untouched: the tab turns it into the agent's brief, because that
// brief is about the contribution surface rather than about this form.
const emit = defineEmits<{ created: [{ id: string; dir: string; wish: string }] }>();
const { create } = defineProps<{ create: (publisher: string, name: string) => Promise<{ id: string; dir: string }> }>();

// The same shape the manifest schema demands and the daemon re-checks: `name` becomes a directory, so a value
// this rejects is one that could not be written anyway.
const SLUG = /^[a-z0-9][a-z0-9-]*$/u;

const publisher = ref(`workspace`);
const name = ref(``);
const wish = ref(``);
const busy = ref(false);
const failure = ref<NoticeModel>();

// A second extension must not inherit the first one's name or the first one's brief, and a previous failure must
// not greet a fresh open.
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
                Writes a working extension into this workspace and switches it on. Nothing is installed and nothing is built: the files are what
                runs, so an edit shows up on the next reload.
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
            <!-- Said once, under both fields, because the rule is the same for each and it is the only way to
                 get this wrong: lower case, digits and hyphens, starting with a letter or digit. -->
            <span class="text-2xs text-subtle">
                Lower case, digits and hyphens.
                <template v-if="ready"
                    >It will be listed as <code class="ui-code">{{ publisher }}.{{ name }}</code
                    >.</template
                >
            </span>

            <!-- The field the whole feature is for. Optional, and last, because the two above are the only ones
                 that must be right: an extension created with this empty is a working stub to edit by hand, and
                 an extension created with it filled is one an agent starts on before the dialog has closed. -->
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
