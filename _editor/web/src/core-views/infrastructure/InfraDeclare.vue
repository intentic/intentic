<script setup lang="ts">
import { INVENTORY_SERVICES } from "@intentic/capability-catalog";
import type { InventoryEntry } from "@intentic/api-contract";
import { Button, Card, ui, Code, ConfirmDialog, InfoHint, Notice, type NoticeModel, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, onMounted, ref, watch } from "vue";
import SecretField from "../../features/capabilities/connect/SecretField.vue";
import { bashCommand } from "../../app/environments/scriptCommand";
import { useCapabilities } from "../../features/capabilities/connect/useCapabilities";
import { useDeployments } from "../../features/extensions/useDeployments";
import { useInventory } from "../../features/extensions/useInventory";
import { usePanels } from "../../features/extensions/usePanels";
import { convergedBadge } from "../../features/extensions/reconcileStatus";
import { useSecrets } from "../../features/capabilities/connect/useSecrets";
import { useWorkspaceState } from "../../features/extensions/useWorkspaceState";
import { detectActivations, extensionPath } from "../registry";
import AddWantDialog from "./AddWantDialog.vue";
import ApplyProgress from "./ApplyProgress.vue";
import ChangePreview from "./ChangePreview.vue";
import CloudflareConnect from "./CloudflareConnect.vue";
import ConnectHost from "./ConnectHost.vue";
import { useApplyProgress } from "./useApplyProgress";
import { usePlanPreview } from "./usePlanPreview";
import { wantedApps } from "./wanted";

// Want-first authoring: declare apps/services via one Add dialog; haves (server, Cloudflare) are demoted to
// 'What you have' and pulled in just-in-time by a requirement card, never asked up front. Apply resolves in
// the sandbox, then runs as a detached tmux job whose terminal tab is the durable log.

const { entries, error: queryError, isLoading, add, remove } = useInventory();
const { set: setSecret } = useSecrets();
const { state } = useWorkspaceState();
const { deployments, komodoReachable } = useDeployments();

// The pre-apply preview and live apply progress, instantiated once and passed to ChangePreview / ApplyProgress.
const preview = usePlanPreview();
const progress = useApplyProgress();

// "Add server" in What-you-have opens the same ConnectHost flow the requirement card uses.
const showConnect = ref(false);
const addOpen = ref(false);

// Apps: declared i.want.app entries union resolved plan union live deployments; tools: declared i.want.service.
const apps = computed(() => wantedApps(entries.value, state.value?.resources ?? [], deployments.value));
const tools = computed(() => entries.value.filter((entry) => entry.kind === `service`));
// Apps with an i.want.app entry: the removable ones (a merely resolved/live app has no entry to delete).
const declaredApps = computed(() => new Set(entries.value.filter((entry) => entry.kind === `app`).map((entry) => entry.name)));

// Servers the services run on. Cloudflare, GitHub/GitLab and Stripe are credentials with their own cards
// below, so they're excluded from this list.
const backends = computed(() =>
    entries.value.filter(
        (entry): entry is Extract<InventoryEntry, { kind: `backend` }> =>
            entry.kind === `backend` &&
            entry.provider !== `cloudflare` &&
            entry.provider !== `stripe` &&
            entry.provider !== `github` &&
            entry.provider !== `gitlab`,
    ),
);

const hasHost = computed(() => backends.value.some((entry) => entry.provider === `host`));
const hasCloudflare = computed(() => entries.value.some((entry) => entry.kind === `backend` && entry.provider === `cloudflare`));
const hasGithub = computed(() => entries.value.some((entry) => entry.kind === `backend` && entry.provider === `github`));
const hasGitlab = computed(() => entries.value.some((entry) => entry.kind === `backend` && entry.provider === `gitlab`));
const hasStripe = computed(() => entries.value.some((entry) => entry.kind === `backend` && entry.provider === `stripe`));
const wantsSomething = computed(() => apps.value.length > 0 || tools.value.length > 0);
// Requirements a want pulls in: a server to run on, Cloudflare for exposure.
const needsHost = computed(() => wantsSomething.value && !hasHost.value);
const needsCloudflare = computed(() => wantsSomething.value && !hasCloudflare.value);
// The first apply (desired state still empty) stands up the deployment tooling; later runs just reconcile.
const isFirstProvision = computed(() => (state.value?.resources.length ?? 0) === 0);

// The collapsed "What you have" one-liner: servers plus the connected accounts.
const haveSummary = computed(() => {
    const parts = [`${backends.value.length} ${backends.value.length === 1 ? `server` : `servers`}`];
    if (hasCloudflare.value) {
        parts.push(`Cloudflare`);
    }
    if (hasGithub.value) {
        parts.push(`GitHub`);
    }
    if (hasGitlab.value) {
        parts.push(`GitLab`);
    }
    if (hasStripe.value) {
        parts.push(`Stripe`);
    }
    return parts.join(` · `);
});

// Add/remove failures (useInventory.error only covers the read query); surfaced alongside it at the top.
const actionError = ref<NoticeModel | null>(null);
const topError = computed<NoticeModel | undefined>(
    () =>
        actionError.value ??
        (queryError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read your inventory.`, detail: queryError.value }),
);

// The display chip for an entry: the service label for i.want.service, "App" for i.want.app, else "Server"
// (backends excludes every credential provider).
const entryLabel = (entry: InventoryEntry): string => {
    if (entry.kind === `service`) {
        return INVENTORY_SERVICES.find((service) => service.service === entry.service)?.label ?? entry.service;
    }
    if (entry.kind === `app`) {
        return `App`;
    }
    return `Server`;
};

const summary = (entry: InventoryEntry): string =>
    Object.entries(entry.values)
        .map(([key, value]) => `${key}=${value}`)
        .join(` · `);

const removeEntry = async (entryName: string): Promise<void> => {
    actionError.value = null;
    try {
        await remove.mutateAsync(entryName);
        // Removing a want stages a pending change like adding one: refresh the preview, never auto-apply.
        if (hasHost.value) {
            void preview.run();
        }
    } catch (err) {
        actionError.value = noticeFrom(err, `Could not remove the entry.`);
    }
};

// Removing a server is two acts: forgetting it here, or wiping the machine via the on-host cleanup command.
const removingServer = ref<string | undefined>();
// Computed, not constant: the command must track scriptSource's currently selected delivery form.
const cleanupHostCommand = computed(() => bashCommand(`cleanupHost`, `sudo `, ``));
const confirmRemoveServer = async (): Promise<void> => {
    const name = removingServer.value;
    if (name === undefined) {
        return;
    }
    removingServer.value = undefined;
    await removeEntry(name);
};

// Source control: link GitHub as an alternative to self-hosted Forgejo. PAT goes to the sandbox's .env,
// then i.have.github is declared.
const showGithub = ref(false);
const ghToken = ref(``);
const ghSubmitting = ref(false);
const submitGithub = async (): Promise<void> => {
    if (ghToken.value.trim().length === 0 || ghSubmitting.value) {
        return;
    }
    ghSubmitting.value = true;
    actionError.value = null;
    try {
        await setSecret.mutateAsync({ key: `GITHUB_TOKEN`, value: ghToken.value.trim() });
        await add.mutateAsync({ kind: `backend`, provider: `github`, name: `gh`, values: {} });
        showGithub.value = false;
        ghToken.value = ``;
    } catch (err) {
        actionError.value = noticeFrom(err, `Could not link GitHub.`);
    } finally {
        ghSubmitting.value = false;
    }
};

// GitLab: same shape as GitHub. PAT goes to .env as GITLAB_TOKEN; the optional URL defaults to gitlab.com.
const showGitlab = ref(false);
const glToken = ref(``);
const glUrl = ref(``);
const glSubmitting = ref(false);
const submitGitlab = async (): Promise<void> => {
    if (glToken.value.trim().length === 0 || glSubmitting.value) {
        return;
    }
    glSubmitting.value = true;
    actionError.value = null;
    try {
        await setSecret.mutateAsync({ key: `GITLAB_TOKEN`, value: glToken.value.trim() });
        const url = glUrl.value.trim();
        await add.mutateAsync({ kind: `backend`, provider: `gitlab`, name: `gl`, values: url.length > 0 ? { url } : {} });
        showGitlab.value = false;
        glToken.value = ``;
        glUrl.value = ``;
    } catch (err) {
        actionError.value = noticeFrom(err, `Could not link GitLab.`);
    } finally {
        glSubmitting.value = false;
    }
};

// Stripe: same shape as GitHub; the API key goes to .env, then i.have.stripe lets the resolver inject it.
const showStripe = ref(false);
const stripeKey = ref(``);
const stripeSubmitting = ref(false);
const submitStripe = async (): Promise<void> => {
    if (stripeKey.value.trim().length === 0 || stripeSubmitting.value) {
        return;
    }
    stripeSubmitting.value = true;
    actionError.value = null;
    try {
        await setSecret.mutateAsync({ key: `STRIPE_API_KEY`, value: stripeKey.value.trim() });
        await add.mutateAsync({ kind: `backend`, provider: `stripe`, name: `stripe`, values: {} });
        showStripe.value = false;
        stripeKey.value = ``;
    } catch (err) {
        actionError.value = noticeFrom(err, `Could not connect Stripe.`);
    } finally {
        stripeSubmitting.value = false;
    }
};

// Cloudflare needs a token + zone, so it's added via the shared CloudflareConnect step, not inline here.
const showCloudflare = ref(false);
const onCloudflareConnected = (): void => {
    showCloudflare.value = false;
};

// Folds the Live-status "up to date / changes pending" pill onto this page, beside the wants.
const convergence = computed(() => convergedBadge(state.value?.converged));
// True only once a previous apply recorded state and komodo is unreachable now: "it was up and now isn't",
// not first-run noise.
const komodoDown = computed(() => komodoReachable.value === false && state.value?.converged !== undefined);
// Links to the full Live-status board, resolved the same way the rail resolves its own route.
const { panels } = usePanels();
const { capabilities } = useCapabilities();
const liveStatusRoute = computed(() => {
    const found = detectActivations(panels.value, capabilities.value).find(({ extension }) => extension.id === `live-status`);
    return found === undefined ? undefined : extensionPath(found.extension, found.activation);
});

// Apply is gated on a fresh, non-stale preview with its required secrets set: "review before it changes".
const applying = computed(() => progress.applying.value);
const canApply = computed(() => preview.ran.value && !preview.stale.value && !preview.awaitingSecrets.value && !progress.applying.value);
const needsPreview = computed(() => !preview.ran.value || preview.stale.value);
const showApplyProgress = computed(() => progress.applying.value || progress.error.value !== undefined || progress.applyPhaseDone.value);

// Any inventory change invalidates a shown preview.
watch(entries, () => preview.markStale());

// A want was just added: refresh the preview when a server exists (otherwise the requirement card takes
// over). Never deploys; Add only stages.
const onAdded = (): void => {
    if (hasHost.value) {
        void preview.run();
    }
};

// A refresh mid-run recovers "Applying…" from the surviving tmux job and resumes watching it.
onMounted(progress.recover);
</script>

<template>
    <Notice v-if="topError" :of="topError" class="mb-6" />

    <!-- The deployment engine on the host is down: the single most load-bearing health fact of this page. -->
    <div v-if="komodoDown" class="mb-6 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        <Icon name="exclamation-triangle" class="shrink-0" />
        <span>
            Your deployment engine (Komodo) is unreachable on your server: deployments can't go live until it's back.
            <b>Apply changes</b> below repairs it.
        </span>
    </div>

    <!-- What you want, the center of the page: apps + self-hosted services, declared through one Add entry point. -->
    <section class="@container mb-6">
        <div class="mb-3 flex items-end justify-between gap-3">
            <div class="flex items-center gap-2">
                <h2 class="text-base font-semibold text-content">What you want</h2>
                <InfoHint label="What you want">
                    <span class="block text-sm font-medium text-content">What you want</span>
                    <span class="mt-1 block text-xs text-muted">
                        What runs on your server: your <b>apps</b> (from your monorepos) and <b>self-hosted services</b> like Outline or SigNoz. Pick
                        either from the catalog with <b>Add</b>: anything it needs (a server, Cloudflare) is asked for right when it's needed.
                    </span>
                </InfoHint>
                <StatusBadge v-if="convergence" :variant="convergence.variant" :label="convergence.label" size="xs" dot />
                <RouterLink v-if="liveStatusRoute" :to="liveStatusRoute" class="text-2xs text-link hover:underline">Live status →</RouterLink>
            </div>
            <Button label="Add" size="small" @click="addOpen = true">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </div>

        <div class="grid grid-cols-1 gap-4 @lg:grid-cols-2">
            <!-- Apps: declared i.want.app entries union resolved plan union live deployments (see wanted.ts). -->
            <div class="flex flex-col gap-2">
                <span :class="ui.sectionLabel()">Apps</span>
                <Card v-for="app in apps" :key="app.name" class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <span class="truncate font-medium text-content">{{ app.name }}</span>
                        <p v-if="app.domain" class="mt-0.5 truncate font-mono text-2xs text-subtle">{{ app.domain }}</p>
                    </div>
                    <div class="flex shrink-0 items-center gap-1">
                        <StatusBadge
                            :variant="app.status === 'live' ? 'success' : app.status === 'planned' ? 'info' : 'neutral'"
                            :label="app.status === 'live' ? 'Live' : app.status === 'planned' ? 'Planned' : 'Declared'"
                            size="xs"
                            dot
                        />
                        <Button
                            v-if="declaredApps.has(app.name)"
                            size="small"
                            severity="danger"
                            :text="true"
                            aria-label="Remove app"
                            @click="removeEntry(app.name)"
                        >
                            <template #icon><Icon name="trash" /></template>
                        </Button>
                    </div>
                </Card>
                <Card v-if="apps.length === 0" :dashed="true" class="text-center text-xs text-muted">
                    No app yet. <b>Add</b>: the apps in your monorepos are in the catalog.
                </Card>
            </div>

            <!-- Self-hosted services = i.want.service entries (removable here). -->
            <div class="flex flex-col gap-2">
                <span :class="ui.sectionLabel()">Self-hosted services</span>
                <Card v-for="tool in tools" :key="tool.name" class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="truncate font-medium text-content">{{ tool.name }}</span>
                            <StatusBadge variant="neutral" :label="entryLabel(tool)" size="xs" />
                        </div>
                        <p v-if="summary(tool)" class="mt-0.5 truncate font-mono text-2xs text-subtle">{{ summary(tool) }}</p>
                    </div>
                    <Button size="small" severity="danger" :text="true" aria-label="Remove service" @click="removeEntry(tool.name)">
                        <template #icon><Icon name="trash" /></template>
                    </Button>
                </Card>
                <Card v-if="tools.length === 0" :dashed="true" class="text-center text-xs text-muted">
                    No services yet. <b>Add</b>: Outline, Paperless-ngx, OpenProject, SigNoz and more.
                </Card>
            </div>
        </div>
    </section>

    <!-- Requirements: the haves declared wants pull in, defined inline right where they block the apply. -->
    <section v-if="needsHost || needsCloudflare" class="mb-6 flex flex-col gap-3">
        <Card v-if="needsHost" class="flex flex-col gap-3">
            <ConnectHost>
                <template #reason>What you want needs a server to run on.</template>
            </ConnectHost>
        </Card>
        <Card v-if="needsCloudflare" class="flex flex-col gap-3">
            <div class="min-w-0">
                <span class="font-medium text-content">Connect Cloudflare</span>
                <p class="mt-0.5 text-xs text-muted">What you want needs a domain: Cloudflare puts it on one, reachable through a tunnel.</p>
            </div>
            <CloudflareConnect />
        </Card>
    </section>

    <!-- What you have, optional, collapsed: the servers + accounts the wants run on. Never asked for up-front. -->
    <details class="group mb-6">
        <summary class="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <Icon name="chevron-right" aria-hidden="true" class="text-xs text-subtle transition-transform group-open:rotate-90" />
            <h2 class="text-base font-semibold text-content">What you have</h2>
            <span class="text-xs text-muted">{{ haveSummary }}</span>
        </summary>
        <div class="mt-3">
            <div class="mb-3 flex items-center justify-end">
                <Button v-if="!showConnect" label="Add server" size="small" severity="secondary" @click="showConnect = true">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </div>

            <!-- Source control: self-hosted Forgejo by default, or link GitHub/GitLab to skip it. -->
            <Card class="mb-3 flex flex-col gap-3">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="font-medium text-content">Source control</span>
                            <StatusBadge v-if="hasGithub" variant="success" size="xs"><Icon name="check" class="text-2xs" /> GitHub</StatusBadge>
                            <StatusBadge v-else-if="hasGitlab" variant="success" size="xs"><Icon name="check" class="text-2xs" /> GitLab</StatusBadge>
                        </div>
                        <p class="mt-0.5 text-xs text-muted">
                            <template v-if="hasGithub">Your DevOps repos live on GitHub: no Forgejo to run.</template>
                            <template v-else-if="hasGitlab">Your DevOps repos live on GitLab: no Forgejo to run.</template>
                            <template v-else
                                >Default is self-hosted <b>Forgejo</b> (provisioned for you). Link <b>GitHub</b> or <b>GitLab</b> to use one
                                instead.</template
                            >
                        </p>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                        <Button v-if="hasGithub" label="Unlink" size="small" severity="secondary" :text="true" @click="removeEntry('gh')" />
                        <Button v-else-if="hasGitlab" label="Unlink" size="small" severity="secondary" :text="true" @click="removeEntry('gl')" />
                        <template v-else-if="!showGithub && !showGitlab">
                            <Button label="Link GitHub" size="small" severity="secondary" @click="showGithub = true">
                                <template #icon><Icon name="github" /></template>
                            </Button>
                            <Button label="Link GitLab" size="small" severity="secondary" @click="showGitlab = true">
                                <template #icon><Icon name="gitlab" /></template>
                            </Button>
                        </template>
                    </div>
                </div>
                <form v-if="showGithub && !hasGithub" class="flex flex-col gap-2" @submit.prevent="submitGithub">
                    <Notice tone="info" class="text-2xs">
                        GitHub source control doesn't yet support managed databases/caches. Use the self-hosted default if your app needs one.
                    </Notice>
                    <label class="ui-field">
                        <span class="ui-field-label">GitHub personal access token</span>
                        <SecretField v-model="ghToken" secret-key="GITHUB_TOKEN" collect placeholder="ghp_…" />
                        <span class="text-2xs text-subtle"
                            >Stored in your sandbox's .env as <span class="font-mono">GITHUB_TOKEN</span>: never on the platform.</span
                        >
                    </label>
                    <div class="flex justify-end gap-2">
                        <Button type="button" label="Cancel" severity="secondary" :text="true" @click="showGithub = false" />
                        <Button type="submit" label="Link GitHub" :disabled="ghToken.trim().length === 0 || ghSubmitting" :loading="ghSubmitting">
                            <template #icon><Icon name="github" /></template>
                        </Button>
                    </div>
                </form>
                <form v-if="showGitlab && !hasGitlab" class="flex flex-col gap-2" @submit.prevent="submitGitlab">
                    <Notice tone="info" class="text-2xs">
                        GitLab source control doesn't yet support managed databases/caches. Use the self-hosted default if your app needs one.
                    </Notice>
                    <label class="ui-field">
                        <span class="ui-field-label">GitLab personal access token</span>
                        <SecretField v-model="glToken" secret-key="GITLAB_TOKEN" collect placeholder="glpat-…" />
                        <span class="text-2xs text-subtle"
                            >Stored in your sandbox's .env as <span class="font-mono">GITLAB_TOKEN</span>: never on the platform.</span
                        >
                    </label>
                    <label class="ui-field">
                        <span class="ui-field-label">GitLab URL <span class="text-subtle">(optional: self-hosted)</span></span>
                        <input v-model="glUrl" type="text" autocomplete="off" placeholder="https://gitlab.com" :class="ui.input()" />
                        <span class="text-2xs text-subtle">Leave blank for gitlab.com.</span>
                    </label>
                    <div class="flex justify-end gap-2">
                        <Button type="button" label="Cancel" severity="secondary" :text="true" @click="showGitlab = false" />
                        <Button type="submit" label="Link GitLab" :disabled="glToken.trim().length === 0 || glSubmitting" :loading="glSubmitting">
                            <template #icon><Icon name="gitlab" /></template>
                        </Button>
                    </div>
                </form>
            </Card>

            <!-- Stripe: a third-party credential, declared as i.have.stripe and injected into consuming apps. -->
            <Card class="mb-3 flex flex-col gap-3">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="font-medium text-content">Stripe</span>
                            <StatusBadge v-if="hasStripe" variant="success" size="xs"><Icon name="check" class="text-2xs" /> Connected</StatusBadge>
                        </div>
                        <p class="mt-0.5 text-xs text-muted">
                            <template v-if="hasStripe">Your apps get the Stripe API key on deploy.</template>
                            <template v-else>Connect your Stripe account so your apps can take payments.</template>
                        </p>
                    </div>
                    <Button v-if="hasStripe" label="Disconnect" size="small" severity="secondary" :text="true" @click="removeEntry('stripe')" />
                    <Button v-else-if="!showStripe" label="Connect Stripe" size="small" severity="secondary" @click="showStripe = true">
                        <template #icon><Icon name="credit-card" /></template>
                    </Button>
                </div>
                <form v-if="showStripe && !hasStripe" class="flex flex-col gap-2" @submit.prevent="submitStripe">
                    <label class="ui-field">
                        <span class="ui-field-label">Stripe API key</span>
                        <SecretField v-model="stripeKey" secret-key="STRIPE_API_KEY" collect placeholder="sk_…" />
                        <span class="text-2xs text-subtle"
                            >Stored in your sandbox's .env as <span class="font-mono">STRIPE_API_KEY</span>: never on the platform.</span
                        >
                    </label>
                    <div class="flex justify-end gap-2">
                        <Button type="button" label="Cancel" severity="secondary" :text="true" @click="showStripe = false" />
                        <Button
                            type="submit"
                            label="Connect Stripe"
                            :disabled="stripeKey.trim().length === 0 || stripeSubmitting"
                            :loading="stripeSubmitting"
                        >
                            <template #icon><Icon name="credit-card" /></template>
                        </Button>
                    </div>
                </form>
            </Card>

            <!-- Cloudflare needs a token + zone, so it's connected inline via the shared CloudflareConnect step. -->
            <Card class="mb-3 flex flex-col gap-3">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="font-medium text-content">Cloudflare</span>
                            <StatusBadge v-if="hasCloudflare" variant="success" size="xs"
                                ><Icon name="check" class="text-2xs" /> Connected</StatusBadge
                            >
                        </div>
                        <p class="mt-0.5 text-xs text-muted">
                            <template v-if="hasCloudflare">Your services can be put on a domain, reachable through a Cloudflare tunnel.</template>
                            <template v-else>Connect Cloudflare so your services can be reached on a domain.</template>
                        </p>
                    </div>
                    <Button v-if="hasCloudflare" label="Disconnect" size="small" severity="secondary" :text="true" @click="removeEntry('cf')" />
                    <Button v-else-if="!showCloudflare" label="Connect Cloudflare" size="small" severity="secondary" @click="showCloudflare = true">
                        <template #icon><Icon name="cloud" /></template>
                    </Button>
                </div>
                <CloudflareConnect v-if="showCloudflare && !hasCloudflare" @connected="onCloudflareConnected" />
            </Card>

            <Card v-if="showConnect" class="mb-3 flex flex-col gap-3">
                <ConnectHost />
                <div class="flex justify-end">
                    <Button type="button" label="Close" severity="secondary" :text="true" @click="showConnect = false" />
                </div>
            </Card>

            <div class="flex flex-col gap-2.5">
                <Card v-for="entry in backends" :key="entry.name" class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <Icon name="check-circle" aria-hidden="true" class="text-xs text-success" />
                            <span class="truncate font-medium text-content">{{ entry.name }}</span>
                            <StatusBadge variant="neutral" :label="entryLabel(entry)" size="xs" />
                        </div>
                        <p v-if="summary(entry)" class="mt-0.5 truncate font-mono text-2xs text-subtle">{{ summary(entry) }}</p>
                    </div>
                    <Button size="small" severity="danger" :text="true" aria-label="Remove server" @click="removingServer = entry.name">
                        <template #icon><Icon name="trash" /></template>
                    </Button>
                </Card>

                <Card
                    v-if="backends.length === 0 && !showConnect && !isLoading"
                    :dashed="true"
                    class="flex flex-col items-center gap-3 py-8 text-center"
                >
                    <Icon name="box" class="text-2xl text-subtle" />
                    <p class="text-sm text-muted">No server yet. One is asked for when something you want needs it.</p>
                </Card>
            </div>
        </div>
    </details>

    <!--
        Review the plan, then apply. The first run also installs the deployment tooling (Komodo + Forgejo);
        later runs reconcile. Adding a want only stages a change: this is where it becomes real.
    -->
    <div class="mb-8 flex flex-col items-center gap-3 border-y border-line py-6">
        <template v-if="hasHost && wantsSomething">
            <!-- What applying will do, before anything changes (resolve to plan, read-only). -->
            <ChangePreview :preview="preview" />

            <Button
                :label="isFirstProvision ? 'Set up & deploy' : 'Apply changes'"
                :disabled="!canApply"
                :loading="applying"
                @click="progress.launch()"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="max-w-lg text-center text-xs text-subtle">
                <template v-if="needsPreview">Preview your changes above, then apply.</template>
                <template v-else-if="isFirstProvision">
                    Installs Komodo{{ hasGithub || hasGitlab ? "" : " and Forgejo" }} on your server to run deployments, then deploys what you
                    configured. Takes a few minutes.
                </template>
                <template v-else>Builds what you configured on your server.</template>
            </p>

            <!--
                Live apply progress from the durable event stream; survives a refresh and keeps the terminal reachable
                via "View logs".
            -->
            <ApplyProgress v-if="showApplyProgress" :progress="progress" />
        </template>
        <p v-else-if="!wantsSomething" class="max-w-lg text-center text-sm text-muted">
            <b>Add</b> an app or a service above: the first apply then sets up your server to run it.
        </p>
        <p v-else class="max-w-lg text-center text-sm text-muted">Connect a server above: then apply builds what you want on it.</p>
    </div>

    <AddWantDialog v-model:visible="addOpen" @added="onAdded" />

    <!--
        Server removal is two separate acts: forgetting it here vs wiping the machine, spelled out with the
        cleanup command front and center before the entry disappears.
    -->
    <ConfirmDialog
        :open="removingServer !== undefined"
        header="Remove server"
        confirm-label="Remove server"
        size="md"
        @cancel="removingServer = undefined"
        @confirm="confirmRemoveServer"
    >
        <div class="flex flex-col gap-3">
            <p class="text-sm text-muted">
                This forgets <b class="text-content">{{ removingServer }}</b> from your inventory: its entry and stored SSH key. The machine itself is
                not touched: <b>everything already deployed keeps running on it</b> until you clean it up.
            </p>
            <Code :code="cleanupHostCommand" lang="bash" label="Run on the server (as root) to wipe everything intentic put there" :wrap="true" />
            <p class="text-xs text-subtle">
                The script lists exactly what it found and asks before removing anything: the deployed containers and their volumes (databases
                included), the deployment state under /opt/intentic: <b>including the on-host backup repo</b>, the tunnel connector service, and the
                intentic service user. Docker itself stays. This host's Cloudflare tunnel + DNS records are cleaned up from here on the next apply,
                not by the script.
            </p>
        </div>
    </ConfirmDialog>
</template>
