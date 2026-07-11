<script setup lang="ts">
import { Card, cmp, CopyButton, Page, StatusBadge, type StatusVariant } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useChat } from "../composables/chat/useChat";
import { usePanels } from "../composables/extensions/usePanels";
import { useSandbox } from "../composables/useSandbox";
import { useSandboxVersion } from "../composables/sandbox/useSandboxVersion";
import { reveal } from "../composables/extensions/useSecrets";
import { useWorkspaceState } from "../composables/extensions/useWorkspaceState";
import { detectActivations } from "../extensions";
import DesktopSyncCard from "./sandbox/DesktopSyncCard.vue";
import EnvironmentCard from "./sandbox/EnvironmentCard.vue";
import SandboxUpdateCard from "./sandbox/SandboxUpdateCard.vue";

/* The sandbox workspace area. The platform holds only the user's binding to their sandbox; Claude
 * authorization and service credentials live inside that sandbox, so dependent capabilities are shown as part
 * of it rather than as peer platform connections. Presentational over useSandbox + useChat. */

const { claudeConnected, openAccountManage } = useChat();
const { capabilities } = useCapabilities();
const { panels } = usePanels();
const sandbox = useSandbox();
const router = useRouter();
const route = useRoute();

// The rail element that serves a repo (its claiming extension activation, fallback included), for deep-linking
// a running dev server's row to its UI; undefined when nothing serves it.
const activationRoute = (repo: string): string | undefined => {
    const found = detectActivations(panels.value, capabilities.value).find(({ activation }) => activation.repo === repo);
    return found === undefined ? undefined : `/ext/${found.extension.id}/${encodeURIComponent(found.activation.key)}`;
};

// Arriving from the Workspace "Open in local editor" shortcut (?enable=desktop-sync): scroll to + flash the card.
const highlightDesktopSync = ref(false);
const stateVariant = (state: string): StatusVariant =>
    state === `active` ? `success` : state === `error` ? `danger` : state === `pending` ? `warning` : `neutral`;

// Live things in the sandbox, split by class for the "Running" card: operator-panel dev servers that are up
// (with their assigned port + preview), and service-type capabilities reporting active. Panels are not
// capabilities, so this is the only at-a-glance view spanning both.
const runningPanels = computed(() => panels.value.filter((panel) => panel.running));
const activeServices = computed(() =>
    capabilities.value.filter((capability) => [`service`, `docker`, `vpn`, `ssh`].includes(capability.kind) && capability.status.state === `active`),
);

// What the sandbox reports about itself (name / image / installed + latest version), from the daemon's /info via
// the shared version composable — the same query that feeds the update card + banner. The URL is the directory's
// daemonUrl. The platform stores none of it.
const { info, installed, latest, updateAvailable } = useSandboxVersion();
const agentUrl = computed(() => sandbox.daemonUrl.value ?? undefined);

// Provisioned-services access (URLs + admin logins) from the last apply's status.json — value-free; a
// generated password's value is fetched on click through the daemon's owner-gated reveal.
const { state } = useWorkspaceState();
const access = computed(() => state.value?.access ?? []);
const revealedAccess = reactive(new Map<string, string>());
const accessError = ref<string | undefined>(undefined);
const toggleAccessReveal = async (key: string): Promise<void> => {
    accessError.value = undefined;
    if (revealedAccess.has(key)) {
        revealedAccess.delete(key);
        return;
    }
    try {
        revealedAccess.set(key, await reveal(key));
    } catch (err) {
        accessError.value = err instanceof Error ? err.message : `Could not reveal the password.`;
    }
};

onMounted(() => {
    if (route.query[`enable`] === `desktop-sync`) {
        highlightDesktopSync.value = true;
        // Let the card render, then bring it into view.
        setTimeout(() => document.getElementById(`desktop-sync`)?.scrollIntoView({ behavior: `smooth`, block: `center` }), 50);
    }
});

const openClaudeInChat = (): void => {
    openAccountManage();
};
</script>

<template>
    <Page>
        <header class="mb-6">
            <h1 class="text-2xl font-semibold">Sandbox</h1>
            <p class="mt-1 text-sm text-muted">
                Your sandbox is the workspace AI operates from. The platform keeps only its address; accounts and credentials stay inside it.
            </p>
        </header>

        <div class="flex flex-col gap-2.5">
            <!-- The one top-level platform binding: this user's sandbox workspace. -->
            <Card class="flex flex-col gap-4">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div class="flex items-center gap-2.5">
                        <Icon name="server" class="text-lg text-muted" />
                        <div>
                            <h2 class="font-semibold leading-tight">Sandbox workspace</h2>
                            <p class="text-xs text-muted">
                                <template v-if="sandbox.reachable.value">Online - the workspace Claude Code and your tools operate from.</template>
                                <template v-else>Offline - reconnecting to the workspace.</template>
                            </p>
                        </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                        <StatusBadge
                            :variant="sandbox.reachable.value ? 'success' : 'neutral'"
                            :label="sandbox.reachable.value ? 'Online' : 'Offline'"
                            dot
                        />
                    </div>
                </div>

                <!-- What the sandbox reports about itself (relayed via /info, never stored by the platform). Shown
                     while reachable; a newer released version, when the daemon reports one, is hinted inline. -->
                <dl
                    v-if="sandbox.reachable.value && info && (info.name || info.image || installed || agentUrl)"
                    class="flex flex-col gap-1.5 rounded-lg border border-line bg-overlay/40 px-3 py-2.5 text-2xs"
                >
                    <div v-if="info.name" class="flex items-center justify-between gap-3">
                        <dt class="text-subtle">Name</dt>
                        <dd class="font-mono text-content">{{ info.name }}</dd>
                    </div>
                    <div v-if="info.image" class="flex items-start justify-between gap-3">
                        <dt class="text-subtle">Image</dt>
                        <dd class="min-w-0 text-right">
                            <div class="truncate font-mono text-content">{{ info.image }}</div>
                            <div v-if="installed" class="mt-0.5 font-mono text-subtle">
                                installed version {{ installed }}
                                <span v-if="updateAvailable" class="text-warning">→ {{ latest }} available</span>
                            </div>
                        </dd>
                    </div>
                    <div v-else-if="installed" class="flex items-center justify-between gap-3">
                        <dt class="text-subtle">Installed version</dt>
                        <dd class="font-mono text-content">
                            {{ installed }}
                            <span v-if="updateAvailable" class="text-warning">→ {{ latest }} available</span>
                        </dd>
                    </div>
                    <div v-if="agentUrl" class="flex items-center justify-between gap-3">
                        <dt class="text-subtle">Sandbox URL</dt>
                        <dd class="min-w-0">
                            <a
                                :href="agentUrl"
                                target="_blank"
                                rel="noopener"
                                class="inline-flex items-center gap-1 truncate font-mono text-link hover:underline"
                            >
                                {{ agentUrl }}<Icon name="external-link" class="text-2xs" />
                            </a>
                        </dd>
                    </div>
                </dl>

                <!-- Capabilities that belong inside the sandbox, not platform-level connections. -->
                <section class="border-t border-line pt-3">
                    <h3 class="text-2xs font-semibold uppercase tracking-wide text-subtle/80">Inside this sandbox</h3>
                    <div class="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div class="flex min-w-0 items-center gap-2.5">
                            <Icon name="sparkles" class="text-lg text-link" />
                            <div class="min-w-0">
                                <h4 class="font-medium leading-tight">Claude account</h4>
                                <p class="text-xs text-muted">Used by Claude Code in the chat panel. Authorization is stored in your sandbox.</p>
                            </div>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                            <StatusBadge
                                :variant="claudeConnected ? 'success' : 'warning'"
                                :label="claudeConnected ? 'Ready' : 'Needs authorization'"
                                dot
                            />
                            <Button
                                :label="claudeConnected ? 'Manage in chat' : 'Connect in chat'"
                                size="small"
                                severity="secondary"
                                @click="openClaudeInChat"
                            >
                                <template #icon><Icon name="comments" /></template>
                            </Button>
                        </div>
                    </div>
                </section>
            </Card>

            <!-- Desktop sync: edit the sandbox's files locally (two-way, block-delta via Mutagen over the tunnel). -->
            <DesktopSyncCard :highlight="highlightDesktopSync" />

            <!-- A newer sandbox image has shipped: the non-blocking, host-run update prompt. Hidden until the
                 daemon reports an available update. -->
            <SandboxUpdateCard />

            <!-- The sandbox image's overlay Dockerfile: agent-proposed, owner-approved, applied by a rebuild.
                 Hidden until the agent proposes an environment change. -->
            <EnvironmentCard />

            <!-- Running: live things across both classes — operator-panel dev servers (with port + preview) and
                 active services. The only at-a-glance view of what is actually up right now. -->
            <Card class="flex flex-col gap-3">
                <div class="flex items-center gap-2.5">
                    <Icon name="bolt" class="text-lg text-muted" />
                    <div>
                        <h2 class="font-semibold leading-tight">Running in this sandbox</h2>
                        <p class="text-xs text-muted">Live operator panels and active services — where they are and whether they're healthy.</p>
                    </div>
                </div>
                <div
                    v-if="runningPanels.length === 0 && activeServices.length === 0"
                    :class="cmp.emptyState('py-6')"
                >
                    Nothing running — open a panel from the sidebar.
                </div>
                <template v-else>
                    <!-- Operator-panel dev servers that are up: link to the panel page for controls; port + preview here. -->
                    <div
                        v-for="panel in runningPanels"
                        :key="panel.repo"
                        class="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2"
                    >
                        <div class="flex min-w-0 items-center gap-2.5">
                            <Icon name="window-maximize" class="text-muted" />
                            <router-link
                                v-if="activationRoute(panel.repo) !== undefined"
                                :to="activationRoute(panel.repo)!"
                                class="truncate font-medium text-content hover:text-link hover:underline"
                                >{{ panel.repo }}</router-link
                            >
                            <span v-else class="truncate font-medium text-content">{{ panel.repo }}</span>
                            <span v-if="panel.port" class="font-mono text-2xs text-subtle">:{{ panel.port }}</span>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                            <a
                                v-if="panel.previewUrl && panel.healthy"
                                :href="panel.previewUrl"
                                target="_blank"
                                rel="noopener"
                                class="inline-flex items-center gap-1 text-2xs text-link hover:underline"
                            >
                                Preview<Icon name="external-link" class="text-2xs" />
                            </a>
                            <StatusBadge
                                :variant="panel.healthy ? 'success' : 'warning'"
                                :label="panel.healthy ? 'Healthy' : 'Starting'"
                                size="xs"
                                dot
                            />
                        </div>
                    </div>
                    <!-- Service-type capabilities reporting active (self-hosted stacks, docker, vpn, ssh). URLs live in access.md below. -->
                    <div
                        v-for="service in activeServices"
                        :key="service.id"
                        class="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2"
                    >
                        <div class="min-w-0">
                            <span class="truncate font-medium text-content">{{ service.id }}</span>
                            <span class="ml-2 text-2xs text-subtle">{{ service.kind }}</span>
                        </div>
                        <StatusBadge
                            :variant="stateVariant(service.status.state)"
                            :label="service.status.state"
                            size="xs"
                            dot
                            v-tooltip.top="service.status.detail"
                        />
                    </div>
                </template>
            </Card>

            <!-- Capabilities: everything added to this sandbox (DevOps, MCP tools, services, integrations) + status. -->
            <Card class="flex flex-col gap-3">
                <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2.5">
                        <Icon name="sparkles" class="text-lg text-muted" />
                        <div>
                            <h2 class="font-semibold leading-tight">Capabilities</h2>
                            <p class="text-xs text-muted">
                                Add <b>DevOps</b> to self-host and deploy, or an <b>MCP server</b> to give the agent tools.
                            </p>
                        </div>
                    </div>
                    <Button label="Add capability" size="small" @click="router.push('/capabilities')">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </div>
                <div v-if="capabilities.length === 0" :class="cmp.emptyState('py-6')">
                    Your sandbox is empty — a dropbox for files. <b>Add a capability</b> to grow what it can do.
                </div>
                <div v-else class="flex flex-col gap-2">
                    <div
                        v-for="capability in capabilities"
                        :key="capability.id"
                        class="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2"
                    >
                        <div class="min-w-0">
                            <span class="truncate font-medium text-content">{{ capability.id }}</span>
                            <span class="ml-2 text-2xs text-subtle">{{ capability.kind }}</span>
                        </div>
                        <StatusBadge
                            :variant="stateVariant(capability.status.state)"
                            :label="capability.status.state"
                            size="xs"
                            dot
                            v-tooltip.top="capability.status.detail"
                        />
                    </div>
                </div>
            </Card>

            <!-- Provisioned services — URLs + admin logins from the last apply (status.json, value-free);
                 generated passwords reveal on click through the daemon (owner only). -->
            <Card v-if="access.length > 0" class="flex flex-col gap-2">
                <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2.5">
                        <Icon name="cloud" class="text-lg text-muted" />
                        <div>
                            <h2 class="font-semibold leading-tight">Provisioned services</h2>
                            <p class="text-xs text-muted">Your provisioned services — Forgejo, Komodo, and your app. Open them directly.</p>
                        </div>
                    </div>
                    <RouterLink to="/secrets"><Button label="Manage secrets" size="small" severity="secondary" :text="true" /></RouterLink>
                </div>
                <div v-if="accessError" :class="cmp.alertDanger()">{{ accessError }}</div>
                <div v-for="entry in access" :key="entry.id" class="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="font-medium text-content">{{ entry.label }}</span>
                        <a
                            :href="entry.url"
                            target="_blank"
                            rel="noreferrer"
                            class="inline-flex items-center gap-1 font-mono text-xs text-link hover:underline"
                        >
                            {{ entry.url }} <Icon name="external-link" class="text-2xs" />
                        </a>
                    </div>
                    <div
                        v-if="entry.username !== undefined || entry.password !== undefined"
                        class="flex flex-wrap items-center gap-3 text-xs text-muted"
                    >
                        <span v-if="entry.username !== undefined"
                            >user: <span class="font-mono text-content">{{ entry.username }}</span></span
                        >
                        <template v-if="entry.password !== undefined">
                            <template v-if="entry.password.source === `generated`">
                                <span v-if="revealedAccess.has(entry.password.key)" class="inline-flex items-center gap-1">
                                    password: <span class="font-mono text-content">{{ revealedAccess.get(entry.password.key) }}</span>
                                    <CopyButton :text="revealedAccess.get(entry.password.key) ?? ``" />
                                </span>
                                <Button
                                    :label="revealedAccess.has(entry.password.key) ? `Hide password` : `Reveal password`"
                                    size="small"
                                    severity="secondary"
                                    :text="true"
                                    @click="toggleAccessReveal(entry.password.key)"
                                >
                                    <template #icon><Icon :name="revealedAccess.has(entry.password.key) ? `eye-slash` : `eye`" /></template>
                                </Button>
                            </template>
                            <span v-else
                                >password: your <span class="font-mono text-content">{{ entry.password.key }}</span> secret</span
                            >
                        </template>
                    </div>
                </div>
            </Card>
        </div>
    </Page>
</template>
