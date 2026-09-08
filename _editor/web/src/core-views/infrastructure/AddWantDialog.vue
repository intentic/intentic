<script setup lang="ts">
import { BrandMark, Button, ui, Modal, Notice, type NoticeModel, Picker, type PickerOption, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { INVENTORY_SERVICES, type InventoryServiceDescriptor } from "@intentic/capability-catalog";
import { computed, ref, watch } from "vue";
import { useInventory } from "../../features/extensions/useInventory";
import { useWorkspaceApps } from "../../features/extensions/useWorkspaceApps";
import CloudflareConnect from "./CloudflareConnect.vue";
import ConnectHost from "./ConnectHost.vue";

// Add-a-want dialog. Step 1: catalog of workspace apps (i.want.app) and INVENTORY_SERVICES (i.want.service).
// Step 2: name plus zone-aware domain; host/Cloudflare bindings are derived, asked only when more than one
// is declared. Submits to deploy.config.ts via /inventory and emits `added`.

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

const visible = defineModel<boolean>(`visible`, { default: false });
const emit = defineEmits<{ added: [] }>();

const { entries, add, refetch } = useInventory();

// A pick is either a catalog service or a workspace monorepo app.
type Picked = { kind: `service`; service: InventoryServiceDescriptor } | { kind: `app`; repo: string; app: string };

const selected = ref<Picked | undefined>(undefined);
const submitting = ref(false);
const error = ref<NoticeModel | null>(null);

const name = ref(``);
const values = ref<Record<string, string>>({});
const on = ref(``);
const subdomain = ref(``);
const subdomainValid = computed(() => SUBDOMAIN_RE.test(subdomain.value.trim()));

// Apps in workspace monorepos; fetched only while the dialog is open, live against the repo list.
const { apps: workspaceApps, error: appsError } = useWorkspaceApps(visible);
const appsNotice = computed<NoticeModel | undefined>(() =>
    appsError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list the apps in this workspace.`, detail: appsError.value },
);

// Apps already declared in intent (by entry name); shown as added instead of addable.
const declaredApps = computed(() => new Set(entries.value.filter((entry) => entry.kind === `app`).map((entry) => entry.name)));

// Host / Cloudflare binding names already declared; a want references them by name.
const hostOptions = computed(() => entries.value.filter((entry) => entry.kind === `backend` && entry.provider === `host`).map((entry) => entry.name));
const hostPickerOptions = computed<PickerOption[]>(() => hostOptions.value.map((host) => ({ value: host, label: host, icon: `server`, mono: true })));
const cloudflareEntries = computed(() => entries.value.filter((entry) => entry.kind === `backend` && entry.provider === `cloudflare`));
// Exposure is derived: Cloudflare is the only mechanism, so the want binds to the one declared entry.
const expose = computed(() => cloudflareEntries.value[0]?.name ?? ``);
// The zone recorded on the cloudflare entry; drives `<subdomain>.<zone>`. Undefined if pre-seeded with none.
const zone = computed(() => {
    const recorded = cloudflareEntries.value[0]?.values[`zone`];
    return typeof recorded === `string` && recorded.length > 0 ? recorded : undefined;
});
// The full hostname exposed: `<subdomain>.<zone>` if the zone is known, else the free-text Domain value.
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

// A server registered while the dialog is open (inline ConnectHost) becomes the binding automatically.
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
        error.value = noticeFrom(err, `Could not add it.`);
    } finally {
        submitting.value = false;
    }
};
</script>

<template>
    <Modal v-model:open="visible" size="md" header="Add" @hide="reset">
        <!-- STEP 2: the picked want's form. -->
        <template v-if="selected">
            <button type="button" :class="ui.textAction(`mb-3 gap-1`)" @click="selected = undefined">
                <Icon name="arrow-left" class="text-2xs" /> Back
            </button>

            <div class="mb-4 flex items-center gap-3">
                <BrandMark
                    v-if="selected.kind === `service`"
                    :size="36"
                    :name="selected.service.label"
                    :logo="selected.service.logo"
                    :icon="selected.service.icon ?? `server`"
                />
                <BrandMark v-else :size="36" :name="selected.app" icon="code" />
                <div class="min-w-0">
                    <div class="font-medium text-content">{{ selected.kind === `service` ? selected.service.label : selected.app }}</div>
                    <div class="text-xs text-muted">
                        {{ selected.kind === `service` ? selected.service.description : `Your app from the ${selected.repo} monorepo.` }}
                    </div>
                </div>
            </div>

            <div class="mb-4 border-t border-line-subtle"></div>

            <Notice v-if="error" :of="error" class="mb-3" />

            <!-- A want needs Cloudflare and a server; both are collected inline rather than sending the user elsewhere. -->
            <CloudflareConnect v-if="cloudflareEntries.length === 0" />
            <ConnectHost v-else-if="hostOptions.length === 0">
                <template #reason>What you want needs a server to run on.</template>
            </ConnectHost>
            <form v-else class="flex flex-col gap-3" @submit.prevent="submit">
                <label class="ui-field">
                    <span class="ui-field-label">Name</span>
                    <input v-model="name" :placeholder="selected.kind === `service` ? selected.service.service : selected.app" :class="ui.input()" />
                </label>
                <!-- Domain is zone-aware whenever the cloudflare entry recorded its zone: a subdomain under it. -->
                <label v-if="zone !== undefined" class="ui-field">
                    <span class="ui-field-label">Domain</span>
                    <div class="flex items-center gap-2">
                        <input v-model="subdomain" :placeholder="name" :class="ui.input('flex-1')" />
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
                    <input v-model="values['domain']" :placeholder="`${name}.example.com`" :class="ui.input()" />
                </label>
                <template v-for="field in serviceFields" :key="field.key">
                    <label v-if="field.key !== `domain`" class="ui-field">
                        <span class="ui-field-label">{{ field.label }}</span>
                        <input v-model="values[field.key]" :class="ui.input()" />
                    </label>
                </template>
                <!-- Placement is derived (single host, single Cloudflare); only a genuine choice is asked. -->
                <label v-if="hostOptions.length > 1" class="ui-field">
                    <span class="ui-field-label">Server</span>
                    <!--
                        `on` holds `` for "none yet" (Picker's empty state), never undefined: explicit binding, not
                        v-model.
                    -->
                    <Picker
                        :model-value="on === `` ? undefined : on"
                        :options="hostPickerOptions"
                        placeholder="Pick a server"
                        class="w-full"
                        aria-label="Server"
                        @update:model-value="(value: string | undefined) => (on = value ?? ``)"
                    />
                </label>
                <div class="flex justify-end">
                    <Button type="submit" label="Add" :disabled="!canSubmit || submitting" :loading="submitting">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                </div>
            </form>
        </template>

        <!-- STEP 1: the catalog, your apps, then the self-hosted services. -->
        <template v-else>
            <p class="mb-4 text-sm text-muted">
                Pick what you want to run on your own server. It's declared in your intent (<span class="font-mono text-xs">deploy.config.ts</span>)
                and deployed on the next apply: the platform stores nothing.
            </p>

            <template v-if="workspaceApps.length > 0 || appsError">
                <span :class="ui.sectionLabel('mb-2 block')">Your apps</span>
                <Notice v-if="appsNotice" :of="appsNotice" class="mb-3" />
                <div class="mb-4 grid grid-cols-2 gap-3">
                    <button
                        v-for="candidate in workspaceApps"
                        :key="`${candidate.repo}--${candidate.app}`"
                        type="button"
                        class="ui-off flex items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay disabled:hover:border-line disabled:hover:bg-card"
                        :disabled="declaredApps.has(candidate.app)"
                        v-action="() => pick({ kind: `app`, ...candidate })"
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
                <span :class="ui.sectionLabel('mb-2 block')">Self-hosted services</span>
            </template>

            <div class="grid grid-cols-2 gap-3">
                <button
                    v-for="service in INVENTORY_SERVICES"
                    :key="service.service"
                    type="button"
                    class="flex items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay"
                    v-action="() => pick({ kind: `service`, service })"
                >
                    <BrandMark :size="32" :name="service.label" :logo="service.logo" :icon="service.icon ?? `server`" />
                    <div class="min-w-0">
                        <div class="font-medium text-content">{{ service.label }}</div>
                        <div class="mt-0.5 text-xs text-muted">{{ service.description }}</div>
                    </div>
                </button>
            </div>
        </template>
    </Modal>
</template>
