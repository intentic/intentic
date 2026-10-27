<script setup lang="ts">
import { Icon, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { useRepos } from "../../../../models/workspace/tree/useRepos";
import { useT } from "@intentic/ui/i18n";
import { changelogLanes } from "./agentChangelog";
import ChangelogExplainer from "./explainers/ChangelogExplainer.vue";

// Per-repo choice of whether a commit gets a release note; the only place this feature turns on. A commit
// message's style is learned from repo history, but a release note has nothing to learn from, so it needs an
// explicit per-repo choice. Off by default: no repo changes until picked here.
//
// One setting, said once, with every repository a chip under it: the only fact per repo is on or off, so a row
// each (same icon, same sentence, a switch) spent a screen on a single bit of eleven.

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();
const { options: repos } = useRepos();

const enabled = computed<readonly string[]>(() => settings.value?.changelogRepos ?? []);

// Computed from the current list, not a delta, so quick toggles on two different repos don't clobber each other.
const setRepo = (repo: string, on: boolean): void => {
    const next = on ? [...enabled.value, repo] : enabled.value.filter((name) => name !== repo);
    patch({ changelogRepos: [...new Set(next)] });
};

// `root` names the workspace repository itself, which has no path to show.
const lanes = computed(() => changelogLanes(repos.value, t(`sandbox.agentChangelog.workspaceRepository`)));

// Only repos that still exist count, so a stale name left in settings can't read as "on in 3 of 2".
const onCount = computed(() => repos.value.filter((repo) => enabled.value.includes(repo)).length);
const summary = computed(() => {
    if (onCount.value === 0) {return t(`sandbox.agentChangelog.offEverywhere`);}
    if (onCount.value === repos.value.length) {return t(`sandbox.agentChangelog.onEverywhere`);}
    return t(`sandbox.agentChangelog.onInSome`, { on: onCount.value, total: repos.value.length });
});
</script>

<template>
    <RowGroup data-setting="agent-changelog" :label="t(`sandbox.agentChangelog.changelog`)">
        <template #info><ChangelogExplainer /></template>
        <Row :title="t(`sandbox.agentChangelog.releaseNoteWithEachCommit`)" :description="summary">
            <template #below>
                <div class="flex flex-col gap-3 pt-1">
                    <div v-for="lane in lanes" :key="lane.folder ?? ``" class="flex flex-col gap-1.5">
                        <span v-if="lane.folder !== undefined" class="font-mono text-2xs text-subtle">{{ lane.folder }}</span>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="chip in lane.chips"
                                :key="chip.repo"
                                type="button"
                                :title="chip.repo === `root` ? undefined : chip.repo"
                                :aria-pressed="enabled.includes(chip.repo)"
                                :disabled="settings === undefined"
                                :class="ui.chip({ on: enabled.includes(chip.repo) }, enabled.includes(chip.repo) && `font-medium`)"
                                @click="setRepo(chip.repo, !enabled.includes(chip.repo))"
                            >
                                <Icon v-if="enabled.includes(chip.repo)" name="check" class="text-2xs" aria-hidden="true" />
                                {{ chip.name }}
                            </button>
                        </div>
                    </div>
                </div>
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
