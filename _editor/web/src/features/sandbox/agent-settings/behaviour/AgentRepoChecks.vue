<script setup lang="ts">
import { Row, RowGroup, SkeletonRows } from "@intentic/ui";
import { computed } from "vue";
import { useRepoChecks } from "../../environment/useRepoChecks";
import { useSandboxOutline } from "../../overview/useSandboxOutline";
import RepoCheckRow from "./RepoCheckRow.vue";
import RepoChecksInfo from "./RepoChecksInfo.vue";

/* Repository checks appear above the sandbox-wide checks. */

const { repos, pending, error, adopt } = useRepoChecks();
const outline = useSandboxOutline(computed(() => repos.value === undefined));

// Repositories waiting on the owner, for the one line this group says about itself.
const waiting = computed(() => (repos.value ?? []).filter((entry) => !entry.adopted && entry.checks.length > 0).length);
</script>

<template>
    <RowGroup label="Repository checks">
        <template #info><RepoChecksInfo /></template>

        <div v-if="repos === undefined" role="status" aria-busy="true">
            <template v-if="outline">
                <span class="sr-only">Reading what this workspace's repositories declare…</span>
                <SkeletonRows :rows="2" description control />
            </template>
        </div>

        <Row
            v-else-if="error !== undefined"
            icon="exclamation-triangle"
            tone="danger"
            title="Couldn't read what the repositories declare."
            :description="error"
        />

<!-- The empty state carries the whole feature for a workspace that has never used it: what the file is called and what it is for. -->
        <Row
            v-else-if="repos.length === 0"
            icon="shield"
            title="No repository declares its own checks"
            description="A repository can carry its own check command in .intentic/checks.json, beside the scripts it names, instead of one command here standing in for all of them."
        />

        <template v-else>
            <RepoCheckRow
                v-for="entry in repos"
                :key="entry.repo"
                :entry="entry"
                :busy="pending === entry.repo"
                @switch="(on: boolean) => adopt(entry.repo, on)"
            />
            <!-- Said once at the foot rather than on every row: the rows already say it individually. -->
            <Row
                v-if="waiting > 0"
                icon="info-circle"
                :description="
                    waiting === 1
                        ? `One repository is waiting on you. Until you switch it on, its own checks do not run.`
                        : `${waiting} repositories are waiting on you. Until you switch them on, their own checks do not run.`
                "
            />
        </template>
    </RowGroup>
</template>
