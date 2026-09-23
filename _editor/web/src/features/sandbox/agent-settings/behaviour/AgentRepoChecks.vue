<script setup lang="ts">
import { Row, RowGroup, SkeletonRows } from "@intentic/ui";
import { computed } from "vue";
import { useRepoChecks } from "../../environment/useRepoChecks";
import { useSandboxOutline } from "../../overview/useSandboxOutline";
import RepoCheckRow from "./RepoCheckRow.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* What each repository runs on its own code: what it declares, and its package script after a land. */

const { repos, pending, error, adopt } = useRepoChecks();
const outline = useSandboxOutline(computed(() => repos.value === undefined));

// Repositories waiting on the owner, for the one line this group says about itself.
const waiting = computed(() => (repos.value ?? []).filter((entry) => !entry.adopted && entry.checks.length > 0).length);
</script>

<template>
    <RowGroup :label="t(`sandbox.agentRepoChecks.repositoryChecks`)">
        <div v-if="repos === undefined" role="status" aria-busy="true">
            <template v-if="outline">
                <span class="sr-only">{{ t(`sandbox.agentRepoChecks.readingWhatWorkspacesRepositories`) }}</span>
                <SkeletonRows :rows="2" description control />
            </template>
        </div>

        <Row
            v-else-if="error !== undefined"
            icon="exclamation-triangle"
            tone="danger"
            :title="t(`sandbox.agentRepoChecks.couldntReadWhatRepositories`)"
            :description="error"
        />

        <!-- The empty state carries the whole feature for a workspace that has never used it: what the file is called and what it is for. -->
        <Row
            v-else-if="repos.length === 0"
            icon="shield"
            :title="t(`sandbox.agentRepoChecks.noRepositoryDeclaresOwn`)"
            :description="t(`sandbox.agentRepoChecks.repositoryDeclaresOwnChecks`)"
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
                        ? t(`sandbox.agentRepoChecks.oneRepositoryWaitingOn`)
                        : t(`sandbox.agentRepoChecks.repositoriesWaitingOnUntil`, { waiting })
                "
            />
        </template>
    </RowGroup>
</template>
