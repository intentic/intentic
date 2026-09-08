<script setup lang="ts">
import { Button, DisclosureRow, Notice, RowGroup, StatusBadge } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { useManifestProblems } from "../extensions/useManifestProblems";
import { openWorkspaceRef } from "../../workspace/files/openFileRef";
import { type ManifestRepairAction, manifestNotices } from "./manifestNotice";

// Reports problems in the sandbox's own state files (a value it couldn't read, an unknown key), unlike
// SandboxBehindCard, which compares this app's build against the daemon's. A collapsed row shows only a file name
// and a status tag; the diagnosis and any fix sit behind the row's chevron until asked for.

const { reports, hasProblems, repair } = useManifestProblems();

const notices = computed(() => manifestNotices(reports.value));

// Which rows are open, by path; none are open on arrival, so a row starts as just a name and a tag.
const opened = ref<Record<string, boolean>>({});
const toggle = (path: string, open: boolean): void => {
    opened.value = { ...opened.value, [path]: open };
};

// One busy flag and one notice for the whole card: no per-row state, and useAsyncAction ignores re-entry while busy.
const { busy, notice: repairNotice, run } = useAsyncAction();
// Path of the last press, so a refusal renders under that row instead of at the bottom of the list.
const acting = ref<string | undefined>(undefined);
const applyRepair = (path: string, action: ManifestRepairAction): Promise<void> => {
    acting.value = path;
    return run(
        () => repair({ path, key: action.key, ...(action.to === undefined ? {} : { to: action.to }) }),
        action.to === undefined ? `Couldn't remove "${action.key}".` : `Couldn't rename "${action.key}".`,
    );
};
</script>

<template>
    <RowGroup v-if="hasProblems" label="Some settings aren't being applied">
        <DisclosureRow
            v-for="notice in notices"
            :key="notice.path"
            icon="exclamation-triangle"
            tone="warning"
            hit="pair"
            :open="opened[notice.path] === true"
            @update:open="toggle(notice.path, $event)"
        >
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        class="cursor-pointer rounded-sm text-left font-mono text-xs hover:text-link hover:underline"
                        :title="notice.path"
                        @click="void openWorkspaceRef(notice.path)"
                    >
                        {{ notice.file }}
                    </button>
                    <!-- Beside the name, not the row's far edge, since it's a fact about this file. -->
                    <StatusBadge variant="neutral" size="xs" :label="notice.impact" />
                </span>
            </template>
            <template #below>
                <div class="flex flex-col gap-1 pb-1 text-2xs">
                    <!-- Buttons sit on the line they answer; collecting them at the bottom would force matching each to a row by position. -->
                    <div v-for="(line, index) in notice.lines" :key="index" class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <p class="text-muted">{{ line.text }}</p>
                        <!--
                            Nested, not inline, so a narrow panel can't split the two buttons across lines and risk misclicking a key's
                            repair. `spoken` gives a screen reader the sentence's subject, since the visible label just says the button text.
                        -->
                        <span v-if="line.repairs.length > 0" class="flex flex-wrap items-center gap-2">
                            <Button
                                v-for="action in line.repairs"
                                :key="action.label"
                                size="small"
                                severity="secondary"
                                :label="action.label"
                                :aria-label="action.spoken"
                                :title="action.spoken"
                                :disabled="busy"
                                @click="void applyRepair(notice.path, action)"
                            />
                        </span>
                    </div>
                    <!-- Outranks the diagnosis: the one line here that requires action. -->
                    <p v-if="notice.fix !== undefined" class="text-content">{{ notice.fix }}</p>
                    <!--
                        Only refusals show here; a successful repair makes the row disappear, so a banner would repeat what's already
                        visible.
                    -->
                    <Notice v-if="repairNotice && acting === notice.path" :of="repairNotice" />
                </div>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
