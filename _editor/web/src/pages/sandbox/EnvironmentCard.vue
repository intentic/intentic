<script setup lang="ts">
import { EnvironmentSchema } from "@intentic-app/api-contract";
import { Button, Card, Code, Notice, type NoticeModel, Row, SegmentedControl, StatusBadge, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { jsonBody } from "../../composables/sandbox/jsonBody";
import { ENVIRONMENT_KEY, useEnvironment } from "../../composables/sandbox/useEnvironment";
import { useEnvironmentContents } from "../../composables/sandbox/useEnvironmentContents";
import { useRole } from "../../composables/sandbox/useRole";
import HostRecreate from "../../components/HostRecreate.vue";
import EnvironmentContents from "./EnvironmentContents.vue";
import DiffToolbar from "../workspace/viewers/DiffToolbar.vue";
import DiffView from "../workspace/viewers/DiffView.vue";

/* The sandbox's environment (on the /sandbox hub), read two ways.
 *
 * CONTENTS LEADS. The daemon composes an overlay Dockerfile from the enabled capabilities' fragments plus the
 * custom section the agent proposes, and that file is what this card used to be: a recipe. But approval is the
 * one moment somebody who does not read Dockerfiles is asked to read one, so the plain-language inventory is
 * not a nicety here: it is the better approval surface, and the diff becomes the "show me exactly" escape
 * hatch behind a pill. The decision itself (and the rebuild that applies it) sits below BOTH views, because it
 * is about the state of the environment rather than about how the environment is being displayed.
 *
 * The operating tier approves or rejects; capability fragments recompose automatically and are not up for review.
 * Approval pins the content's hash; the rebuild itself runs OUTSIDE the container (see HostRecreate): a button
 * in the desktop app or a copyable one-liner in a browser, whose hash argument guarantees only the reviewed
 * content is built, or the next `intentic deploy apply` for a server-managed sandbox. Hidden until there is an
 * overlay or a proposal. */

const queryClient = useQueryClient();
const { busy, notice, run } = useAsyncAction();
/* A role-gate refusal is not a fault, so it is not reported as one. */
const actionNotice = computed<NoticeModel | undefined>(() =>
    notice.value?.detail === `not a sandbox maintainer`
        ? { tone: `warning`, title: `Only a sandbox maintainer can decide on environment changes.` }
        : notice.value,
);

const { canShip: canOperate } = useRole();

// The derived environment state (shared with the shell's rebuild banner via one vue-query fetch).
const { state, query, proposal, pending, applied, recurring, serverManaged, slug } = useEnvironment();

/* Which of the two reads is on screen. "Recipe" rather than "Source" because it says what you are switching TO,
 * and "Contents" rather than "Simplified" because the plain view is not the lesser one: naming it that way
 * would tell the reader who needs it most that they are on the beginner's setting. */
const view = ref<`contents` | `recipe`>(`contents`);
const VIEWS = [
    { label: `Contents`, value: `contents`, title: `What this sandbox has installed` },
    { label: `Recipe`, value: `recipe`, title: `The overlay Dockerfile it is built from` },
] as const;

// Probing every tool for its version costs process spawns, so it only runs while the contents view is open.
// Gated on the SELECTION rather than on what ends up drawn: asking is how the card finds out whether this daemon
// can answer at all, so a fallback derived from the answer must not also decide whether to ask.
const { groups, awaiting, loading, error: contentsError, unsupported, refresh: reprobe } = useEnvironmentContents(() => view.value === `contents`);

/* WHAT IS ACTUALLY DRAWN, as opposed to what is selected. A sandbox whose daemon predates the contents route
 * cannot answer for it, so the card stops offering it: the pill row disappears and the recipe, which every
 * daemon that has an overlay at all can show: takes over. The alternative was leaving a tab that greets its
 * only visitor with a 404, which is how a missing feature comes to read as a broken one. */
const shown = computed(() => (unsupported.value ? `recipe` : view.value));

// One refresh for both reads, and it forces a re-probe, so "it says missing but I just installed it" is a click
// rather than a restart.
const load = async (): Promise<void> => {
    reprobe();
    await query.refetch();
};

const decide = (path: string, body?: object): Promise<void> =>
    run(async () => {
        const next = EnvironmentSchema.parse(await sandboxJson(path, jsonBody(`POST`, body ?? {})));
        queryClient.setQueryData(ENVIRONMENT_KEY, next);
    }, `Could not update the environment.`);
const approve = (): Promise<void> => decide(`/environment/approve`, { hash: proposal.value?.hash });
const reject = (): Promise<void> => decide(`/environment/reject`);
</script>

<template>
    <Card v-if="proposal || pending || applied || recurring.length" class="flex flex-col gap-4">
        <Row flush :heading="2" icon="box" title="Environment">
            <template #control>
                <SegmentedControl v-if="!unsupported" v-model="view" :options="VIEWS" />
                <StatusBadge v-if="applied && !proposal && !pending" variant="success" label="Applied" dot />
                <StatusBadge v-else-if="pending && !proposal" variant="warning" label="Pending rebuild" dot />
                <StatusBadge v-else variant="warning" label="Awaiting review" dot />
                <button type="button" :class="ui.iconButton()" aria-label="Refresh" v-tooltip.top="'Refresh'" @click="load">
                    <Icon name="refresh" class="text-sm" :spin="query.isFetching" />
                </button>
            </template>
        </Row>

        <!-- What the sandbox has, in plain language. Leads in every state: including a pending proposal, whose
             incoming entries appear here marked as awaiting approval, above the buttons that decide them. -->
        <EnvironmentContents v-if="shown === `contents`" :groups="groups" :awaiting="awaiting" :loading="loading" :error="contentsError" />

        <!-- A proposal awaiting the owner's decision: the diff against the approved custom section (capability
             fragments are daemon-owned and not up for review here). -->
        <template v-else-if="proposal">
            <div class="flex h-72 flex-col overflow-hidden rounded-lg border border-line">
                <DiffToolbar path="environment.custom.Dockerfile" />
                <DiffView
                    :key="proposal.hash"
                    :before="state?.custom?.content ?? ''"
                    :after="proposal.content"
                    path="environment.custom.Dockerfile"
                    class="min-h-0 flex-1"
                />
            </div>
        </template>

        <!-- Approved, not yet built into the running container. What you paste to rebuild pins this content's
             hash, so what is shown here is exactly what gets built. -->
        <Code v-else-if="pending" :code="pending.content" lang="docker" label="Approved overlay (pending rebuild)" />

        <!-- The active overlay the running container was built from. -->
        <Code v-else-if="applied" :code="applied.content" lang="docker" label="Active overlay" />

        <!-- Said once, quietly, and only to somebody whose sandbox could show more than it is showing: the reason
             there is no contents list is the sandbox's age, not a fault. It names an UPDATE rather than a rebuild
             deliberately: an environment rebuild builds on top of the image this sandbox already runs, so it is
             the one action that would NOT bring this, and sending someone to it would waste a whole rebuild. -->
        <p v-if="unsupported" class="text-2xs text-subtle">
            This sandbox's image is older than the plain-language contents list. Update the sandbox and the list appears beside the recipe.
        </p>

        <!-- What sessions keep installing at RUNTIME — the daemon's cross-session memory, drift-corroborated.
             The mechanically fixable entries are usually already drafted into the proposal above ("proposed");
             the rest wait for a person: a pip package that belongs in a venv or a Debian package, a shell
             installer whose replay could carry anything. Lives under both views because it is a fact about the
             environment's state, like the decision below. -->
        <div v-if="recurring.length" class="flex flex-col gap-1">
            <p class="text-xs font-medium text-content">Installed at runtime, not in the image</p>
            <ul class="flex flex-col gap-0.5">
                <li v-for="entry in recurring" :key="`${entry.kind}:${entry.tool}`" class="text-2xs text-subtle">
                    <span class="font-mono text-content">{{ entry.tool }}</span>
                    · {{ entry.sessions === 1 ? `1 session` : `${entry.sessions} sessions` }}
                    <template v-if="entry.live"> · present now, lost on rebuild</template>
                    <template v-if="entry.drafted"> · proposed</template>
                    <template v-if="entry.declined"> · declined</template>
                </li>
            </ul>
        </div>

        <!-- THE DECISION, under both views: it is about the environment's state, not about how it is displayed. -->
        <template v-if="proposal">
            <div v-if="canOperate" class="flex items-center justify-end gap-2">
                <Button label="Reject" size="small" severity="danger" :text="true" :loading="busy" @click="reject">
                    <template #icon><Icon name="times" /></template>
                </Button>
                <Button label="Approve" size="small" :loading="busy" @click="approve">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </div>
            <p v-else class="text-2xs text-subtle">Only the sandbox owner can approve or reject this change.</p>
        </template>

        <template v-if="pending">
            <template v-if="serverManaged">
                <p class="text-2xs text-subtle">
                    Applies on the next <span class="font-mono">intentic deploy apply</span> against this sandbox's host.
                </p>
            </template>
            <template v-else-if="slug">
                <p class="text-xs font-medium text-content">To finish, rebuild your sandbox:</p>
                <HostRecreate :slug="slug" :hash="pending.hash" action="Rebuild" />
            </template>
        </template>

        <Notice v-if="actionNotice" :of="actionNotice" />
    </Card>
</template>
