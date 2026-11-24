<script setup lang="ts">
import type { ProjectClaim } from "@intentic/api-contract";
import { errorMessage } from "@intentic/base/errors";
import { Button, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { sandboxRaw } from "../../client/sandbox/sandboxRaw";
import { supportsRoute } from "../../client/sandbox/useDaemonRoutes";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { PROJECT_SUGGESTIONS } from "../../lib/queryKeys";
import { apiClient } from "../../lib/useApi";
import FactsHint, { type HintFact, type HintStep } from "../../components/FactsHint.vue";

// Which of this account's sandboxes answers for which project: the directory behind account-level report routing
// (api projects/). A sandbox reports a problem about a project with `projects report`; it lands in the issues inbox of
// the sandbox named here. One sandbox per project, so claiming a project for another sandbox moves it.

const t = useT();
const client = useQueryClient();
const KEY = [`account`, `projects`];

const claims = useQuery({ queryKey: KEY, queryFn: async (): Promise<ProjectClaim[]> => (await apiClient.projects.list()).claims });
const { sandboxes, active } = useSandbox();
const owned = computed(() => sandboxes.value.filter((sandbox) => sandbox.tier === `owner`));

// What the open sandbox's repos could claim, from their remotes, less what the account claims already: one press each.
// Read only from a sandbox the reader owns and whose daemon serves the route; anything else offers none.
const suggestible = computed(() => active.value?.tier === `owner` && supportsRoute(`GET /account/projects/suggest`));
const { query: suggestionsQuery } = useSandboxQuery({
    queryKey: PROJECT_SUGGESTIONS.of(),
    queryFn: async () => (await sandboxRaw(`GET /account/projects/suggest`)).projects,
    enabled: suggestible,
});
const suggestions = computed(() => {
    const claimed = new Set((claims.data.value ?? []).map((row) => row.project));
    return (suggestionsQuery.data.value ?? []).filter((name) => !claimed.has(name));
});

const project = ref(``);
// The sandbox a claim goes to: the one picked, else the first the reader owns. The picker shows that default rather than
// a blank field that a claim then quietly filled in.
const picked = ref(``);
const sandboxId = computed({
    get: () => (owned.value.some((sandbox) => sandbox.id === picked.value) ? picked.value : (owned.value[0]?.id ?? ``)),
    set: (id: string) => {
        picked.value = id;
    },
});
const busy = ref(false);
const failure = ref<string | undefined>();

const nameOf = (claim: ProjectClaim): string => owned.value.find((sandbox) => sandbox.id === claim.sandboxId)?.name ?? claim.sandboxName;

const run = async (task: () => Promise<{ claims: ProjectClaim[] }>): Promise<void> => {
    busy.value = true;
    failure.value = undefined;
    try {
        client.setQueryData(KEY, (await task()).claims);
    } catch (error) {
        failure.value = errorMessage(error);
    } finally {
        busy.value = false;
    }
};

const claim = async (): Promise<void> => {
    const chosen = sandboxId.value;
    if (busy.value || project.value.trim() === `` || chosen === ``) {
        return;
    }
    await run(() => apiClient.projects.claim({ sandboxId: chosen, project: project.value.trim() }));
    if (failure.value === undefined) {
        project.value = ``;
    }
};

const release = (name: string): Promise<void> => run(() => apiClient.projects.release({ project: name }));

// A suggestion claimed for the sandbox it came from, the open one.
const claimSuggested = (name: string): Promise<void> => {
    const here = active.value?.id;
    return here === undefined || busy.value ? Promise.resolve() : run(() => apiClient.projects.claim({ sandboxId: here, project: name }));
};

// The (i) beside the group's name: where a report travels, then what a project is and the rules a claim follows.
const hintSteps = computed<readonly HintStep[]>(() => [
    { icon: `box`, label: t(`settings.settingsProjects.hint.anySandbox`) },
    // The command itself, which no language translates.
    { icon: `terminal`, label: `projects report`, code: true },
    { icon: `exclamation-circle`, label: t(`settings.settingsProjects.hint.claimedInbox`), good: true },
]);
const hintFacts = computed<readonly HintFact[]>(() => [
    { icon: `clone`, text: t(`settings.settingsProjects.hint.grouped`) },
    { icon: `github`, text: t(`settings.settingsProjects.hint.isRepository`, { example: `github.com/acme/app` }) },
    { icon: `arrow-right`, text: t(`settings.settingsProjects.hint.onePerProject`) },
]);
const notice = computed(() => (failure.value === undefined ? undefined : { tone: `danger` as const, title: t(`settings.settingsProjects.failed`), detail: failure.value }));
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup :label="t(`settings.section.projects`)">
            <!-- What a claim does is the (i)'s headline, with where a report travels and the rules a claim follows under
                 it; the list itself starts with the list. An empty one says what it is for, the one time that helps. -->
            <template #info>
                <FactsHint
                    :label="t(`settings.explainers.about`, { name: t(`settings.section.projects`) })"
                    :title="t(`settings.settingsProjects.whatFor`)"
                    :lane="t(`settings.settingsProjects.hint.lane`)"
                    :steps="hintSteps"
                    :facts="hintFacts"
                />
            </template>
            <RowNote v-if="claims.isSuccess.value && (claims.data.value ?? []).length === 0 && suggestions.length === 0" variant="empty">{{
                t(`settings.settingsProjects.none`)
            }}</RowNote>
            <div v-if="(claims.data.value ?? []).length > 0" class="divide-y divide-line-subtle">
                <Row
                    v-for="row in claims.data.value"
                    :key="row.project"
                    icon="folder"
                    :title="row.project"
                    :description="t(`settings.settingsProjects.reportsLandIn`, { sandbox: nameOf(row) })"
                >
                    <template #control>
                        <Button :label="t(`settings.settingsProjects.release`)" size="small" tier="quiet" tone="danger" :disabled="busy" @click="release(row.project)" />
                    </template>
                </Row>
            </div>
            <div v-if="suggestions.length > 0" class="divide-y divide-line-subtle" data-project-suggestions>
                <Row
                    v-for="name in suggestions"
                    :key="name"
                    icon="folder"
                    :title="name"
                    :description="t(`settings.settingsProjects.suggested`, { sandbox: active?.name ?? `` })"
                >
                    <template #control>
                        <Button :label="t(`settings.settingsProjects.claim`)" size="small" tier="quiet" :disabled="busy" @click="claimSuggested(name)" />
                    </template>
                </Row>
            </div>
            <RowNote variant="block">
                <div class="flex flex-col gap-3">
                    <Notice v-if="notice" :of="notice" />
                    <form class="flex flex-wrap items-center gap-2" @submit.prevent="claim">
                        <input
                            v-model="project"
                            type="text"
                            autocomplete="off"
                            :aria-label="t(`settings.settingsProjects.project`)"
                            :placeholder="t(`settings.settingsProjects.projectPlaceholder`)"
                            :class="ui.input({ size: `sm` }, `min-w-56 flex-1`)"
                        />
                        <select v-model="sandboxId" :aria-label="t(`settings.settingsProjects.sandbox`)" :class="ui.input({ size: `sm` }, `w-auto`)">
                            <option v-for="sandbox in owned" :key="sandbox.id" :value="sandbox.id">{{ sandbox.name }}</option>
                        </select>
                        <Button
                            tier="accent"
                            type="submit"
                            size="small"
                            :label="t(`settings.settingsProjects.claim`)"
                            :loading="busy"
                            :disabled="busy || owned.length === 0"
                            class="shrink-0"
                        />
                    </form>
                </div>
            </RowNote>
        </RowGroup>
    </div>
</template>
