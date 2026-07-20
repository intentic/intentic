<script setup lang="ts">
import { cmp, type IconName } from "@intentic-app/ui";
import { INVENTORY_SERVICES, type InventoryServiceDescriptor } from "@intentic-app/capability-catalog";
import { AppsListSchema } from "@intentic-app/api-contract";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import Select from "primevue/select";
import { computed, reactive, ref, watch } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { errorMessage } from "../../composables/useAsyncAction";
import { useInventory } from "../../composables/extensions/useInventory";
import { usePanels } from "../../composables/extensions/usePanels";
import CloudflareConnect from "./CloudflareConnect.vue";
import ConnectHost from "./ConnectHost.vue";

/* The Infra "Add" dialog — the single entry point for declaring a want. Step 1 is a catalog with two groups:
 * YOUR APPS (the apps present in workspace monorepos, via the daemon's per-repo apps routes — each addable as
 * i.want.app) and SELF-HOSTED SERVICES (INVENTORY_SERVICES → i.want.service). Step 2 is a minimal form — name
 * and zone-aware domain; host/Cloudflare bindings are derived (exposure is the single Cloudflare entry, the
 * server is asked for only when several are declared). Submitting writes the entry into deploy.config.ts
 * through the sandbox's /inventory routes and emits `added`, so the page can run its Apply-changes stream. */

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

const visible = defineModel<boolean>(`visible`, { default: false });
const emit = defineEmits<{ added: [] }>();

const { entries, add, refetch } = useInventory();
const { panels } = usePanels();

// A pick is either a catalog service or a workspace monorepo app.
type Picked = { kind: `service`; service: InventoryServiceDescriptor } | { kind: `app`; repo: string; app: string };

const selected = ref<Picked | undefined>(undefined);
const submitting = ref(false);
const error = ref<string | null>(null);

const name = ref(``);
const values = ref<Record<string, string>>({});
const on = ref(``);
const subdomain = ref(``);
const subdomainValid = computed(() => SUBDOMAIN_RE.test(subdomain.value.trim()));

const logoFailed = reactive(new Set<string>());
const logoUrl = (service: InventoryServiceDescriptor): string => `https://cdn.simpleicons.org/${service.logo}`;

// The apps living in workspace monorepos, fetched when the dialog opens (one round-trip per monorepo).
const workspaceApps = ref<{ repo: string; app: string }[]>([]);
const appsError = ref<string | null>(null);
watch(visible, async (open) => {
    if (!open) {
        return;
    }
    appsError.value = null;
    try {
        const lists = await Promise.all(
            panels.value
                .filter((panel) => panel.monorepo)
                .map(async ({ repo }) => {
                    const { apps } = AppsListSchema.parse(await sandboxJson(`/workspace/repos/${encodeURIComponent(repo)}/apps`));
                    return apps.map(({ app }) => ({ repo, app }));
                }),
        );
        workspaceApps.value = lists.flat();
    } catch (err) {
        appsError.value = errorMessage(err, `Could not list your apps.`);
    }
});

// Apps already declared in intent (by entry name) — shown as added instead of addable.
const declaredApps = computed(() => new Set(entries.value.filter((entry) => entry.kind === `app`).map((entry) => entry.name)));

// Host / Cloudflare binding names the user already declared (a want references them by name).
const hostOptions = computed(() => entries.value.filter((entry) => entry.kind === `backend` && entry.provider === `host`).map((entry) => entry.name));
const cloudflareEntries = computed(() => entries.value.filter((entry) => entry.kind === `backend` && entry.provider === `cloudflare`));
// Exposure is derived, never asked: Cloudflare is the single exposure mechanism, so the want binds to the
// (only) declared cloudflare entry.
const expose = computed(() => cloudflareEntries.value[0]?.name ?? ``);
// The zone recorded on the cloudflare entry when it was connected — drives the `<subdomain>.<zone>` domain
// field in every session. Undefined (free-text full-domain fallback) only when the token was pre-seeded, so
// no zone could be listed at connect time.
const zone = computed(() => {
    const recorded = cloudflareEntries.value[0]?.values[`zone`];
    return typeof recorded === `string` && recorded.length > 0 ? recorded : undefined;
});
// The full hostname the want is exposed on: `<subdomain>.<zone>` when the zone is known, else the raw
// value the user typed into the free-text Domain field.
const domainValue = computed(() => (zone.value !== undefined ? `${subdomain.value.trim()}.${zone.value}` : (values.value[`domain`] ?? ``).trim()));
const domainValid = computed(() => (zone.value !== undefined ? subdomainValid.value : domainValue.value.length > 0));

const serviceFields = computed(() => (selected.value?.kind === `service` ? selected.value.service.fields : []));

const canSubmit = computed(
    () =>
        NAME_RE.test(name.value.trim()) &&
        (selected.value?.kind === `app`
            ? domainValid.value
            : serviceFields.value.every((field) =>
                  field.key === `domain` ? domainValid.value : (values.value[field.key] ?? ``).trim().length > 0,
              )) &&
        on.value.length > 0 &&
        expose.value.length > 0,
);

const reset = (): void => {
    selected.value = undefined;
    error.value = null;
    name.value = ``;
    values.value = {};
    on.value = ``;
    subdomain.value = ``;
};

const close = (): void => {
    visible.value = false;
    reset();
};

const pick = async (picked: Picked): Promise<void> => {
    selected.value = picked;
    error.value = null;
    name.value = picked.kind === `service` ? picked.service.service : picked.app;
    subdomain.value = picked.kind === `app` ? picked.app : ``;
    // Need the declared host/cloudflare bindings to wire the want's on/expose.
    await refetch();
    on.value = hostOptions.value.includes(`self`) ? `self` : (hostOptions.value[0] ?? ``);
};

// A server that registers while the dialog is open (the inline ConnectHost flow) becomes the binding —
// the form appears with `on` already wired, no re-pick needed.
watch(hostOptions, (hosts) => {
    if (on.value === ``) {
        on.value = hosts.includes(`self`) ? `self` : (hosts[0] ?? ``);
    }
});

const submit = async (): Promise<void> => {
    if (!canSubmit.value || submitting.value || selected.value === undefined) {
        return;
    }
    submitting.value = true;
    error.value = null;
    try {
        await add.mutateAsync(
            selected.value.kind === `app`
                ? { kind: `app`, name: name.value.trim(), on: on.value, expose: expose.value, values: { domain: domainValue.value } }
                : {
                      kind: `service`,
                      service: selected.value.service.service,
                      name: name.value.trim(),
                      on: on.value,
                      expose: expose.value,
                      values: Object.fromEntries(
                          selected.value.service.fields.map((field) => [
                              field.key,
                              field.key === `domain` ? domainValue.value : (values.value[field.key] ?? ``).trim(),
                          ]),
                      ),
                  },
        );
        emit(`added`);
        close();
    } catch (err) {
        error.value = errorMessage(err, `Could not add it.`);
    } finally {
        submitting.value = false;
    }
};
</script>

<template>
    <Dialog
        v-model:visible="visible"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :style="{ width: '34rem' }"
        header="Add"
        @hide="reset"
    >
        <!-- STEP 2: the picked want's form. -->
        <template v-if="selected">
            <button type="button" class="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-content" @click="selected = undefined">
                <Icon name="arrow-left" class="text-2xs" /> Back
            </button>

            <div class="mb-4 flex items-center gap-3">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas">
                    <template v-if="selected.kind === `service`">
                        <img
                            v-if="selected.service.logo !== undefined && !logoFailed.has(selected.service.service)"
                            :src="logoUrl(selected.service)"
                            :alt="selected.service.label"
                            class="h-5 w-5 object-contain"
                            @error="logoFailed.add(selected.service.service)"
                        />
                        <Icon :name="(selected.service.icon as IconName) ?? `server`" v-else class="text-sm text-link" />
                    </template>
                    <Icon name="code" v-else class="text-sm text-link" />
                </span>
                <div class="min-w-0">
                    <div class="font-medium text-content">{{ selected.kind === `service` ? selected.service.label : selected.app }}</div>
                    <div class="text-xs text-muted">
                        {{ selected.kind === `service` ? selected.service.description : `Your app from the ${selected.repo} monorepo.` }}
                    </div>
                </div>
            </div>

            <div class="mb-4 border-t border-line"></div>

            <div v-if="error" :class="cmp.alertDanger('mb-3')">{{ error }}</div>

            <!-- A want needs Cloudflare for its domain and a server to run on. Rather than send the user off,
                 collect each missing one right here; the created entries then flip this into the form below. -->
            <CloudflareConnect v-if="cloudflareEntries.length === 0" />
            <ConnectHost v-else-if="hostOptions.length === 0">
                <template #reason>What you want needs a server to run on.</template>
            </ConnectHost>
            <form v-else class="flex flex-col gap-3" @submit.prevent="submit">
                <label class="ui-field">
                    <span class="ui-field-label">Name</span>
                    <input v-model="name" :placeholder="selected.kind === `service` ? selected.service.service : selected.app" :class="cmp.input()" />
                </label>
                <!-- Domain, zone-aware whenever the cloudflare entry recorded its zone: a subdomain under it. -->
                <label v-if="zone !== undefined" class="ui-field">
                    <span class="ui-field-label">Domain</span>
                    <div class="flex items-center gap-2">
                        <input v-model="subdomain" :placeholder="name" :class="cmp.input('flex-1')" />
                        <span class="whitespace-nowrap font-mono text-sm text-subtle">.{{ zone }}</span>
                    </div>
                    <span v-if="subdomain.trim().length > 0 && !subdomainValid" class="text-xs text-warning"
                        >Use letters, numbers and hyphens only.</span
                    >
                    <span v-else-if="subdomainValid" class="text-xs text-success"
                        >✓ Reachable at <span class="font-mono">{{ subdomain.trim() }}.{{ zone }}</span></span
                    >
                </label>
                <label v-else class="ui-field">
                    <span class="ui-field-label">Domain</span>
                    <input v-model="values['domain']" :placeholder="`${name}.example.com`" :class="cmp.input()" />
                </label>
                <template v-for="field in serviceFields" :key="field.key">
                    <label v-if="field.key !== `domain`" class="ui-field">
                        <span class="ui-field-label">{{ field.label }}</span>
                        <input v-model="values[field.key]" :class="cmp.input()" />
                    </label>
                </template>
                <!-- Placement is derived (single host, single Cloudflare); only a genuine choice is asked. -->
                <label v-if="hostOptions.length > 1" class="ui-field">
                    <span class="ui-field-label">Server</span>
                    <Select v-model="on" :options="hostOptions" placeholder="Pick a server" />
                </label>
                <div class="flex justify-end">
                    <Button type="submit" label="Add" :disabled="!canSubmit || submitting" :loading="submitting">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                </div>
            </form>
        </template>

        <!-- STEP 1: the catalog — your apps, then the self-hosted services. -->
        <template v-else>
            <p class="mb-4 text-sm text-muted">
                Pick what you want to run on your own server. It's declared in your intent (<span class="font-mono text-xs">deploy.config.ts</span>)
                and deployed on the next apply — the platform stores nothing.
            </p>

            <template v-if="workspaceApps.length > 0 || appsError">
                <span :class="cmp.sectionLabel('mb-2 block')">Your apps</span>
                <div v-if="appsError" :class="cmp.alertDanger('mb-3')">{{ appsError }}</div>
                <div class="mb-4 grid grid-cols-2 gap-3">
                    <button
                        v-for="candidate in workspaceApps"
                        :key="`${candidate.repo}--${candidate.app}`"
                        type="button"
                        class="flex items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay disabled:cursor-default disabled:opacity-60 disabled:hover:border-line disabled:hover:bg-card"
                        :disabled="declaredApps.has(candidate.app)"
                        @click="pick({ kind: `app`, ...candidate })"
                    >
                        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas">
                            <Icon name="code" class="text-sm text-link" />
                        </span>
                        <div class="min-w-0">
                            <div class="flex items-center gap-2 font-medium text-content">
                                {{ candidate.app }}
                                <Icon name="check" v-if="declaredApps.has(candidate.app)" aria-hidden="true" class="text-2xs text-success" />
                            </div>
                            <div class="mt-0.5 text-xs text-muted">{{ candidate.repo }}</div>
                        </div>
                    </button>
                </div>
                <span :class="cmp.sectionLabel('mb-2 block')">Self-hosted services</span>
            </template>

            <div class="grid grid-cols-2 gap-3">
                <button
                    v-for="service in INVENTORY_SERVICES"
                    :key="service.service"
                    type="button"
                    class="flex items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay"
                    @click="pick({ kind: `service`, service })"
                >
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas">
                        <img
                            v-if="service.logo !== undefined && !logoFailed.has(service.service)"
                            :src="logoUrl(service)"
                            :alt="service.label"
                            class="h-5 w-5 object-contain"
                            @error="logoFailed.add(service.service)"
                        />
                        <Icon :name="(service.icon as IconName) ?? `server`" v-else class="text-sm text-link" />
                    </span>
                    <div class="min-w-0">
                        <div class="font-medium text-content">{{ service.label }}</div>
                        <div class="mt-0.5 text-xs text-muted">{{ service.description }}</div>
                    </div>
                </button>
            </div>
        </template>
    </Dialog>
</template>
