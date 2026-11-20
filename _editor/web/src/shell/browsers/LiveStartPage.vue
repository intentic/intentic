<!-- The browsers view with nothing open: a new tab's page, whose search box (the address bar's twin, with its
     suggestions) starts the person's own window, and under it everything else the view can open. Quiet, it is a blank
     tab of the person's own, from the press of + until an address commits in it: nothing to type into but the address
     bar, which has the keyboard. -->
<script setup lang="ts">
import { DEFAULT_SEARCH_ENGINE, type SearchEngine } from "@intentic/sandbox-contract/schemas/browsing";
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import Omnibox from "../../features/browsers/Omnibox.vue";
import { NO_MARKS, type PageMarks } from "../../features/browsers/bookmarks/bookmarkTree";
import LiveLauncher, { type LaunchGroup } from "./LiveLauncher.vue";

const {
    opening = false,
    openError,
    engine = DEFAULT_SEARCH_ENGINE,
    groups,
    quiet = false,
    marks = NO_MARKS,
} = defineProps<{
    // The person's own window is starting: the box waits, and the caption says so.
    opening?: boolean;
    // Why the last start failed, with a way to try it again.
    openError?: string | undefined;
    engine?: SearchEngine;
    // Everything but a web tab, which the box already is.
    groups: readonly LaunchGroup[];
    // A blank tab's face: no box and no caption.
    quiet?: boolean;
    // Which pages are bookmarked and each site's icon, for the box's suggestions.
    marks?: PageMarks;
}>();

// `submit` is the address to open the window at; `retry` asks for the last one again; `launch` is a launcher row's key.
const emit = defineEmits<{ submit: [url: string]; retry: []; launch: [key: string] }>();

const t = useT();
const box = ref<{ focus: () => void } | undefined>();

defineExpose({ focus: (): void => box.value?.focus() });
</script>

<template>
    <div class="absolute inset-0 flex justify-center overflow-y-auto p-6">
        <div class="my-auto flex w-full max-w-xl flex-col items-center gap-5">
            <Icon name="browsers" class="text-3xl text-subtle" />
            <template v-if="!quiet">
                <Omnibox
                    ref="box"
                    value=""
                    editable
                    variant="hero"
                    :busy="opening"
                    :engine="engine"
                    :marks="marks"
                    :placeholder="t(`browsers.browsers.addressPlaceholder`)"
                    class="w-full"
                    @submit="(url) => emit(`submit`, url)"
                />
                <p v-if="openError" class="flex flex-wrap items-center justify-center gap-x-2 text-center text-xs text-danger">
                    {{ openError }}
                    <button type="button" :class="ui.textButton({ flush: true })" @click="emit(`retry`)">{{ t(`ui.action.tryAgain`) }}</button>
                </p>
                <p v-else class="max-w-md text-center text-2xs text-muted">
                    {{ opening ? t(`browsers.browsers.starting`) : t(`browsers.browsers.startCaption`) }}
                </p>
            </template>
            <LiveLauncher v-if="groups.length > 0" :groups="groups" variant="page" class="mt-2" @pick="(key) => emit(`launch`, key)" />
        </div>
    </div>
</template>
