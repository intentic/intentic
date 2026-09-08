<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useRepos } from "../../../workspace/explorer/useRepos";

// Per-repo switch for whether a commit gets a release note; the only place this feature turns on. A commit
// message's style is learned from repo history, but a release note has nothing to learn from, so it needs an
// explicit per-repo choice. Off by default: no repo changes until switched on here.

const { settings, patch } = useSandboxSettings();
const { options: repos } = useRepos();

const enabled = computed<readonly string[]>(() => settings.value?.changelogRepos ?? []);

// Computed from the current list, not a delta, so quick toggles on two different repos don't clobber each other.
const setRepo = (repo: string, on: boolean): void => {
    const next = on ? [...enabled.value, repo] : enabled.value.filter((name) => name !== repo);
    patch({ changelogRepos: [...new Set(next)] });
};

// `root` names the workspace repository itself, which has no path to show.
const repoLabel = (repo: string): string => (repo === `root` ? `Workspace repository` : repo);
</script>

<template>
    <RowGroup label="Changelog">
        <!-- One row per repo, `root` first (ordered by useRepos). -->
        <Row
            v-for="repo in repos"
            :key="repo"
            icon="book"
            :title="repoLabel(repo)"
            description="Include a release note with each commit."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="enabled.includes(repo)"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => setRepo(repo, value)"
                />
            </template>
        </Row>
    </RowGroup>
</template>
