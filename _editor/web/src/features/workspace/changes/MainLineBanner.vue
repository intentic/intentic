<script setup lang="ts">
import type { RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { queryClient } from "../../../lib/queryPersistence";
import { changesKey } from "../../../models/changes/useChanges";
import { useOperations } from "../../../workbench/operations/operations";
import { offMainLine, repoNameOf, type OffMainLine } from "./mainLine";

// A strip along the Changes panel's top edge for each shared repository something moved off its main line (mainLine.ts):
// while it stands there every agent's work waits, so the strip names where it is and offers the one way back. The move
// back is the daemon's (`git.returnToMainLine`), which reports uncommitted work in the way rather than trampling it; that
// refusal is said under the sentence, and the list is read again either way.

const { repos } = defineProps<{ repos: readonly RepoChanges[] }>();
const t = useT();

const off = computed(() => offMainLine(repos));
// Keyed per repository, so two strips each answer for their own press, and a press survives the panel closing.
const back = useOperations(`changes/main-line`);

const sentence = (row: OffMainLine): string => {
    const repo = repoNameOf(row.repo, t(`workspace.mainLineBanner.workspace`));
    return row.branch === undefined
        ? t(`workspace.mainLineBanner.offMain`, { repo, main: row.main })
        : t(`workspace.mainLineBanner.offBranch`, { repo, branch: row.branch, main: row.main });
};
const pressing = (row: OffMainLine): boolean => back.at(row.repo)?.state === `running`;
// The daemon's own words for a refusal when it gave some, else the app's sentence for it.
const refusal = (row: OffMainLine): string | undefined => {
    const failure = back.at(row.repo)?.failure;
    return failure === undefined ? undefined : (failure.detail ?? failure.title);
};

const goBack = (row: OffMainLine): void =>
    void back.run(row.repo, {
        what: t(`workspace.mainLineBanner.returning`, { main: row.main }),
        failed: t(`workspace.mainLineBanner.couldntReturn`, { main: row.main }),
        // The strip leaving is the answer, and a refusal stays on it.
        quiet: true,
        task: async () => {
            try {
                const result = await sandboxRpc.git.returnToMainLine({ repo: row.repo });
                if (!result.ok) {
                    throw new Error(result.reason ?? ``);
                }
            } finally {
                await queryClient.invalidateQueries({ queryKey: changesKey() });
            }
        },
    });
</script>

<template>
    <Notice v-for="row in off" :key="row.repo" tone="warning" size="sm" strip>
        <span class="block break-words">{{ sentence(row) }}</span>
        <span v-if="refusal(row)" class="mt-0.5 block whitespace-pre-line break-words text-2xs text-danger">{{ refusal(row) }}</span>
        <template #actions>
            <Button tier="accent" size="small" :loading="pressing(row)" @click="() => goBack(row)">
                {{ t(`workspace.mainLineBanner.back`, { main: row.main }) }}
            </Button>
        </template>
    </Notice>
</template>
