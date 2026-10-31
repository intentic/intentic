<script setup lang="ts">
import { Button, Icon, ResponsiveOverlay, type Tip, toneInk, ui, useDevice } from "@intentic/ui";
import { computed, ref } from "vue";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { useScopeTitle } from "../health/scopeTitle";
import { useWorkspaceTree } from "../../../models/workspace/tree/useWorkspaceTree";
import { useChanges } from "../../../models/changes/useChanges";
import { draftFromBranch } from "../../../models/fleet/branches/branchStart";
import { draftFreshSession } from "../../../models/fleet/freshSession";
import { useAgents } from "../../../models/fleet/useAgents";
import { isShared, type ViewScope, workspaceView } from "../../../app/workspaceScope";
import { useT } from "@intentic/ui/i18n";
import WorkspaceScopePicker from "../../../parts/workspace/scope/WorkspaceScopePicker.vue";

const t = useT();

// Shows which copy of the workspace is open, the shared one included: the tree and files look the same whichever it is.
// A control in the existing bar, since the scope is a persistent mode. On the shared tree it names the main line the
// shared checkout stays on ("main"), quietly; on anything else it is accented. A press
// opens the switcher (WorkspaceScopePicker): a searchable list of branches and conversations' copies, not a menu, since a
// busy sandbox has dozens. A per-person view: nothing changes on disk, and nobody else's Workspace moves.
// Scoped, it is joined by the way to change what is on screen: a new agent started from that copy or that branch.

const { error } = useWorkspaceTree();
const title = useScopeTitle();
const { mobile } = useDevice();
const { repos } = useChanges();
const { agentById } = useAgents();

const open = ref(false);
const anchor = ref<HTMLElement>();

const shared = computed(() => isShared(workspaceView.value));
const branch = computed(() => workspaceView.value.branch);
// The workspace's own repository's main line, else the first repository's: what the shared checkout stands on.
const mainLine = computed(() => {
    const row = repos.value.find((repo) => repo.repo === `root`) ?? repos.value[0];
    return row?.mainBranch ?? row?.branch;
});
// True when the copy on screen cannot be read: an archived agent's lost checkout, a branch gone since.
const broken = computed(() => !shared.value && error.value !== undefined);

const words = useVocabulary();
const branchWord = computed(() => t(`agents.sessionIdentity.branch`));
// Whose copy, and what a press does: the name is the fact, the rest one short line.
const tip = computed((): Tip => {
    if (broken.value) {
        return { title: t(`workspace.workspaceScopeChip.copyUnreadable`), tone: `warning`, rows: [{ label: words.value.Agent, value: title.value }], note: t(`workspace.workspaceScopeChip.clickForShared`) };
    }
    if (shared.value) {
        const rows = mainLine.value === undefined ? undefined : [{ label: branchWord.value, value: mainLine.value }];
        return { title: t(`workspace.workspaceScopeChip.sharedWorkspace`), rows, note: t(`workspace.workspaceScopeChip.clickToLook`) };
    }
    const label = branch.value === undefined ? words.value.Agent : branchWord.value;
    const heading = branch.value === undefined ? t(`workspace.words.privateCopy`) : t(`workspace.words.branchView`);
    return { title: heading, rows: [{ label, value: title.value }], note: t(`workspace.workspaceScopeChip.readOnlyClickToSwitch`) };
});
const label = computed(() => (shared.value ? (mainLine.value ?? t(`workspace.workspaceScopeChip.sharedWorkspace`)) : title.value));
const icon = computed(() => (broken.value ? `exclamation-triangle` : shared.value ? `folder` : branch.value === undefined ? `robot` : `git-branch`));
const ariaLabel = computed(() => {
    if (broken.value) {
        return t(`workspace.workspaceScopeChip.brokenAria`, { name: title.value });
    }
    if (shared.value) {
        return t(`workspace.workspaceScopeChip.sharedAria`, { name: label.value });
    }
    return branch.value === undefined ? t(`workspace.workspaceScopeChip.copyAria`, { name: title.value }) : t(`workspace.workspaceScopeChip.branchAria`, { name: title.value });
});

const pick = (scope: ViewScope): void => {
    open.value = false;
    workspaceView.value = scope;
};

// A new agent on what is on screen: a branch's own start, or a fresh session on a conversation's copy with the reader's
// own ask. Either opens a composer; nothing runs until Send.
const origin = computed(() => (workspaceView.value.agent === undefined ? undefined : agentById(workspaceView.value.agent)));
const startable = computed(() => !broken.value && (branch.value !== undefined || origin.value !== undefined));
const startHere = (): void => {
    const { agent, repo, branch: from } = workspaceView.value;
    if (from !== undefined) {
        draftFromBranch({ repo, branch: from });
    } else if (agent !== undefined && origin.value !== undefined) {
        void draftFreshSession(origin.value, `ask`);
    }
};
</script>

<template>
    <button
        ref="anchor"
        type="button"
        :class="ui.textButton({ tone: `quiet`, size: `xs` }, `shrink-0 px-2`, broken ? toneInk(`warning`) : !shared && toneInk(`primary`))"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-label="ariaLabel"
        v-tooltip.bottom="open ? undefined : tip"
        @click="open = !open"
    >
        <Icon :name="icon" class="shrink-0 text-[0.7rem]" />
        <!-- Name truncates first on narrow panes; icon and tint alone still mark a non-shared scope, tooltip has the rest. -->
        <span class="max-w-40 truncate max-lg:hidden" :class="{ 'font-mono': shared || branch !== undefined }">{{ label }}</span>
        <Icon name="chevron-down" class="shrink-0 text-[0.6rem] opacity-70 transition-transform" :class="{ 'rotate-180': open }" />
    </button>
    <!-- Its words on a desktop's bar, its glyph alone on a phone's, where the chip beside it already takes the width. -->
    <Button
        v-if="startable"
        size="small"
        tier="boring"
        class="shrink-0 whitespace-nowrap"
        :label="mobile ? undefined : t(`workspace.workspaceScopeChip.newAgentFromHere`)"
        :aria-label="t(`workspace.workspaceScopeChip.newAgentFromHere`)"
        v-tooltip.bottom="{ title: t(`workspace.workspaceScopeChip.newAgentTip`), note: t(`workspace.workspaceScopeChip.newAgentFromHereNote`) }"
        @click="startHere"
    >
        <template #icon><Icon name="plus" /></template>
    </Button>
    <ResponsiveOverlay
        v-model="open"
        :anchor="anchor"
        side="bottom"
        cross="end"
        :header="t(`workspace.workspaceScopeChip.showFilesFrom`)"
        panel-class="w-[23rem] max-w-[calc(100vw-1rem)]"
    >
        <WorkspaceScopePicker :current="workspaceView" :main-line="mainLine" :autofocus="!mobile" @pick="pick" @close="open = false" />
    </ResponsiveOverlay>
</template>
