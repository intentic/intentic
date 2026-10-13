<script setup lang="ts">
import { Button, EmptyState, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { basename, parentDir } from "@intentic/ui/path";
import { computed, ref, watch } from "vue";
import { lookUpWorkspaceRef } from "../../features/workspace/files/refs/resolveFileRef";
import { useScopeTitle } from "../../features/workspace/health/scopeTitle";
import { searchInQuickOpen, useQuickOpen } from "../../workbench/commands/useQuickOpen";
import { FILE_SIDE_VIEW, fileSideInput, noteArrival } from "../../workbench/side/sideFileInput";
import { openBeside } from "../../workbench/side/sideTabs";

// A file tab with no file behind it, said in place rather than by closing the tab under the click that opened it. Two
// ways to get here: a reference nothing in its copy matched (`gone` false), or a file that was there and went while it
// was open or since (`gone` true). Either way the next step is on the card: what it may have meant, and a search.

const {
    reference,
    agent,
    gone = false,
    nearby,
    line,
} = defineProps<{
    // The reference as written, or the path that went.
    reference: string;
    agent?: string;
    gone?: boolean;
    // What the opener already learned it may have meant; asked again here when it did not (a restored tab, a file gone).
    nearby?: readonly string[];
    // Where the reference pointed, carried to whichever file is picked instead.
    line?: number;
}>();

const t = useT();
const { mounted: paletteHere } = useQuickOpen();
const name = computed(() => basename(reference));

const copyTitle = useScopeTitle(computed(() => agent));
const copy = computed(() => (agent === undefined ? t(`shell.sidePanel.sharedCopy`) : t(`shell.sidePanel.agentCopy`, { title: copyTitle.value })));

// Whatever answered last; a reference changing under the card drops a slower answer for the one before it.
const asked = ref<readonly string[] | undefined>(undefined);
let question = 0;
watch(
    () => [reference, agent, nearby] as const,
    async () => {
        const mine = ++question;
        asked.value = undefined;
        if (nearby !== undefined || reference === ``) {
            return;
        }
        const found = await lookUpWorkspaceRef(reference, { agent });
        if (mine !== question || found === undefined) {
            return;
        }
        // A file that went may be found again under its new name; one the reference never matched may exist by now.
        asked.value = found.path === undefined ? (found.nearby ?? []) : [found.path, ...(found.others ?? [])];
    },
    { immediate: true },
);
const suggestions = computed(() => (nearby ?? asked.value ?? []).filter((path) => path !== reference));

// Shows the picked file in this tab's place, remembering what was asked so its own card can say how it got there.
const pick = (path: string): void => {
    const input = fileSideInput(path, agent);
    noteArrival(input, undefined);
    openBeside(FILE_SIDE_VIEW, input, line === undefined ? {} : { line });
};
</script>

<template>
    <EmptyState
        icon="link-broken"
        :title="gone ? t(`shell.sidePanel.gone`, { name }) : t(`shell.sidePanel.notFound`, { name })"
        :line="gone ? t(`shell.sidePanel.goneNote`) : t(`shell.sidePanel.notFoundNote`, { path: reference, copy })"
        class="gap-4 py-8"
    >
        <template v-if="paletteHere && name !== ``" #actions>
            <Button tier="boring" @click="searchInQuickOpen(name)">
                <Icon name="search" />
                {{ t(`shell.sidePanel.searchFor`, { name }) }}
            </Button>
        </template>
        <div v-if="suggestions.length > 0" class="flex w-full max-w-sm flex-col gap-1 text-left">
            <p class="px-2 text-2xs text-subtle">{{ t(`shell.sidePanel.maybeMeant`) }}</p>
            <button
                v-for="path in suggestions"
                :key="path"
                type="button"
                class="flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-overlay focus-visible:bg-overlay"
                :title="path"
                @click="pick(path)"
            >
                <Icon name="file" class="shrink-0 self-center text-[0.7rem] text-subtle" />
                <span class="shrink-0 text-content">{{ basename(path) }}</span>
                <span class="min-w-0 truncate text-2xs text-subtle" dir="rtl">{{ parentDir(path) }}</span>
            </button>
        </div>
    </EmptyState>
</template>
