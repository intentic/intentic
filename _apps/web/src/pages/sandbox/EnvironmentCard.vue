<script setup lang="ts">
import { EnvironmentSchema } from "@intentic-app/api-contract";
import { Card, Code, StatusBadge } from "@intentic-app/ui";
import { useQueryClient } from "@tanstack/vue-query";
import Button from "primevue/button";
import { ref } from "vue";
import { sandboxJson } from "../../composables/sandboxClient";
import { ENVIRONMENT_KEY, useEnvironment } from "../../composables/sandbox/useEnvironment";
import DiffView from "../workspace/DiffView.vue";

/* The sandbox's environment (its composed overlay Dockerfile, on the /sandbox hub). The daemon composes it
 * from the enabled capabilities' fragments plus the custom section the agent proposes; the OWNER reviews the
 * custom-section diff here and approves/rejects (capability fragments recompose automatically). Approval pins
 * the content's hash; the rebuild itself runs OUTSIDE the container — locally via the copyable one-liner
 * (whose hash argument guarantees only the reviewed content is built), or on the next `intentic apply` for a
 * server-managed sandbox. Hidden until there is an overlay or a proposal. */

const queryClient = useQueryClient();
const actionError = ref<string | undefined>(undefined);
const busy = ref(false);

// The derived environment state (shared with the shell's rebuild banner via one vue-query fetch).
const { state, query, proposal, pending, applied, serverManaged, rebuildCommand } = useEnvironment();
const load = (): void => void query.refetch();

const decide = async (path: string, body?: object): Promise<void> => {
    busy.value = true;
    actionError.value = undefined;
    try {
        const next = EnvironmentSchema.parse(
            await sandboxJson(path, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body ?? {}) }),
        );
        queryClient.setQueryData(ENVIRONMENT_KEY, next);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        actionError.value = message === `not the sandbox owner` ? `Only the sandbox owner can decide on environment changes.` : message;
    } finally {
        busy.value = false;
    }
};
const approve = (): Promise<void> => decide(`/environment/approve`, { hash: proposal.value?.hash });
const reject = (): Promise<void> => decide(`/environment/reject`);
</script>

<template>
    <Card v-if="proposal || pending || applied" class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2.5">
                <Icon name="box" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">Environment</h2>
                    <p class="text-2xs text-subtle">
                        The sandbox image's overlay — composed from your capabilities plus anything the agent proposes; you approve proposals, a
                        rebuild applies the result.
                    </p>
                </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
                <StatusBadge v-if="applied && !proposal && !pending" variant="success" label="Applied" dot />
                <StatusBadge v-else-if="pending && !proposal" variant="warning" label="Pending rebuild" dot />
                <StatusBadge v-else variant="warning" label="Awaiting review" dot />
                <Button size="small" severity="secondary" :text="true" aria-label="Refresh" @click="load">
                    <template #icon><Icon name="refresh" /></template>
                </Button>
            </div>
        </div>

        <!-- A proposal awaiting the owner's decision: the diff against the approved custom section (capability
             fragments are daemon-owned and not up for review here). -->
        <template v-if="proposal">
            <div class="h-72 overflow-hidden rounded-lg border border-line">
                <DiffView
                    :key="proposal.hash"
                    :before="state?.custom?.content ?? ''"
                    :after="proposal.content"
                    path="environment.custom.Dockerfile"
                />
            </div>
            <div class="flex items-center justify-end gap-2">
                <Button label="Reject" size="small" severity="danger" :text="true" :loading="busy" @click="reject">
                    <template #icon><Icon name="times" /></template>
                </Button>
                <Button label="Approve" size="small" :loading="busy" @click="approve">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </div>
        </template>

        <!-- Approved, not yet built into the running container. The one-liner pins the approved content's
             hash, and the content is shown right here — what you paste is exactly what gets built. -->
        <template v-if="pending">
            <Code :code="pending.content" lang="dockerfile" label="Approved overlay (pending rebuild)" />
            <template v-if="serverManaged">
                <p class="text-2xs text-subtle">Applies on the next <span class="font-mono">intentic apply</span> against this sandbox's host.</p>
            </template>
            <template v-else>
                <p class="text-xs font-medium text-content">To finish, rebuild your sandbox:</p>
                <ol class="ml-4 list-decimal text-2xs text-subtle">
                    <li>Open a terminal on the computer that runs your sandbox.</li>
                    <li>Copy and run the command below. It takes a few minutes; your files (in /work) are kept.</li>
                </ol>
                <Code :code="rebuildCommand" lang="bash" label="Rebuild command" :wrap="true" />
            </template>
        </template>

        <!-- The active overlay the running container was built from. -->
        <Code v-if="applied && !proposal && !pending" :code="applied.content" lang="dockerfile" label="Active overlay" />

        <p v-if="actionError" class="text-2xs text-danger">{{ actionError }}</p>
    </Card>
</template>
