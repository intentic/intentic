<script setup lang="ts">
import { Await, Row, RowGroup, SkeletonRows } from "@intentic/ui";
import { useRepoChecks } from "../../../../models/sandbox/environment/useRepoChecks";
import RepoCheckRow from "../../../../components/RepoCheckRow.vue";
import { useT } from "@intentic/ui/i18n";
import RepoChecksExplainer from "./explainers/RepoChecksExplainer.vue";

const t = useT();

/* What each repository runs on its own code, as it declares it: on each file as it is written, and once as an isolated
   turn ends. None of it holds a turn, a land, a commit or a push. */

const { loaded, pending, adopt } = useRepoChecks();
</script>

<template>
    <!-- The whole group is what waits, drawn as it last looked in this sandbox: its rows sit straight in it. -->
    <Await :of="loaded" imprint="sandbox.agent.repo-checks" :label="t(`sandbox.agentRepoChecks.readingWhatWorkspacesRepositories`)">
        <template #default="{ data: repos, refreshError }">
            <RowGroup data-setting="agent-repo-checks" :label="t(`sandbox.agentRepoChecks.checksAfterEdits`)">
                <template #info><RepoChecksExplainer /></template>
                <Row
                    v-if="refreshError !== undefined"
                    icon="exclamation-triangle"
                    tone="danger"
                    :title="t(`sandbox.agentRepoChecks.couldntReadWhatRepositories`)"
                    :description="refreshError"
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
                </template>
            </RowGroup>
        </template>
        <template #fallback>
            <RowGroup :label="t(`sandbox.agentRepoChecks.checksAfterEdits`)">
                <div role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.agentRepoChecks.readingWhatWorkspacesRepositories`) }}</span>
                    <SkeletonRows :rows="2" description control />
                </div>
            </RowGroup>
        </template>
        <template #failed="{ error }">
            <RowGroup :label="t(`sandbox.agentRepoChecks.checksAfterEdits`)">
                <Row
                    icon="exclamation-triangle"
                    tone="danger"
                    :title="t(`sandbox.agentRepoChecks.couldntReadWhatRepositories`)"
                    :description="error"
                />
            </RowGroup>
        </template>
    </Await>
</template>
