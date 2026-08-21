<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { useRepos } from "../../../composables/workspace/useRepos";

/* WHICH REPOS KEEP A CHANGELOG: one switch per repo, and the only place this feature is ever turned on.
 *
 * IT IS A SWITCH RATHER THAN A DEFAULT because of who this daemon runs for. Everything else about a drafted
 * commit is inferred from the repo's own history: the assistant reads the last handful of subjects and matches
 * whatever convention it finds, so a repo that spells its commits some other way is never argued with. A
 * release note is the one thing that cannot be learned that way: a repo that has never written one gives it
 * nothing to copy, so asking for it has to be somebody's decision, made here, per repo.
 *
 * PER REPO rather than per sandbox, because a workspace holds several and they do not answer to the same
 * audience: the product you ship has users waiting to hear what changed, and the scratch repo beside it has
 * none. A commit spanning both is written for the first.
 *
 * All off is the default and needs no explanation on screen: nothing about any repo changes until one is
 * switched on here, which is exactly how the sandbox behaved before this existed.
 */

const { settings, patch } = useSandboxSettings();
const { options: repos } = useRepos();

const enabled = computed<readonly string[]>(() => settings.value?.changelogRepos ?? []);

// Written as a whole list rather than a delta: the settings patch takes the field's new value, and computing it
// from the CURRENT list is what keeps two quick clicks on two different repos from each overwriting the other.
const setRepo = (repo: string, on: boolean): void => {
    const next = on ? [...enabled.value, repo] : enabled.value.filter((name) => name !== repo);
    patch({ changelogRepos: [...new Set(next)] });
};

// "root" is the workspace repo itself and has no path to show, so it is named for what it is. Everything else
// is already a root-relative dir, which is the name it goes by everywhere else in the app.
const repoLabel = (repo: string): string => (repo === `root` ? `Workspace repository` : repo);
</script>

<template>
    <RowGroup label="Changelog">
        <!-- One row per repo, "root" first (useRepos orders them). A workspace with no nested repos shows the
             single row, which is the common case and reads as a plain on/off. -->
        <Row
            v-for="repo in repos"
            :key="repo"
            icon="book"
            :title="repoLabel(repo)"
            description="Have each commit carry a one-line note about what changed for the people who use it, ready to publish when you release."
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
