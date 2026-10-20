<script setup lang="ts">
import { BrandMark, Button, Modal, Notice, type NoticeModel, Picker, type PickerOption, Section, ui, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { INVENTORY_SERVICES, type InventoryServiceDescriptor } from "@intentic/capability-catalog";
import { INVENTORY_NAME_MAX, INVENTORY_NAME_RE, inventoryIdentifier } from "@intentic/sandbox-contract/schemas/inventory";
import { computed, ref, useId, watch } from "vue";
import { useInventory } from "../../features/extensions/useInventory";
import { useWorkspaceApps } from "../../features/extensions/useWorkspaceApps";
import CloudflareConnect from "./CloudflareConnect.vue";
import ConnectHost from "./ConnectHost.vue";
import { serviceDescription } from "./serviceWords";
import { useT } from "@intentic/ui/i18n";

// Add-a-want dialog. Step 1: catalog of workspace apps (i.want.app) and INVENTORY_SERVICES (i.want.service).
// Step 2: name plus zone-aware domain; host/Cloudflare bindings are derived, asked only when more than one
// is declared. Submits to deploy.config.ts via /inventory and emits `added`.

// A DNS label: the 63 is the protocol's, not a preference, and without it an over-long name fails at Cloudflare
// instead of here.
const t = useT();

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
const SUBDOMAIN_MAX = 63;
// Repairs a name into a DNS label the same way `inventoryIdentifier` repairs one into a binding.
const subdomainLabel = (raw: string): string =>
    raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/gu, `-`)
        .replace(/-{2,}/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .slice(0, SUBDOMAIN_MAX)
        .replace(/-+$/, ``);

const visible = defineModel<boolean>(`visible`, { default: false });
const emit = defineEmits<{ added: [] }>();

const { entries, add, refetch } = useInventory();

// A pick is either a catalog service or a workspace monorepo app.
type Picked = { kind: `service`; service: InventoryServiceDescriptor } | { kind: `app`; repo: string; app: string };

const selected = ref<Picked | undefined>(undefined);
// Add sits in the footer, outside the form, and submits it by id so Enter in a field still does.
const formId = useId();
const submitting = ref(false);
const error = ref<NoticeModel | null>(null);

const name = ref(``);
const values = ref<Record<string, string>>({});
const on = ref(``);
const subdomain = ref(``);
const subdomainValid = computed(() => {
    const label = subdomain.value.trim();
    return SUBDOMAIN_RE.test(label) && label.length <= SUBDOMAIN_MAX;
});
// Why the button is off, in the field's own words; a rule the user cannot see is a dead button with no reason.
const subdomainError = computed<string | undefined>(() => {
    const label = subdomain.value.trim();
    if (label.length === 0 || subdomainValid.value) {
        return undefined;
    }
    return label.length > SUBDOMAIN_MAX ? t(`views.addWantDialog.domainLabelTooLong`, { max: SUBDOMAIN_MAX, length: label.length }) : undefined;
});
const nameError = computed<string | undefined>(() => {
    const typed = name.value.trim();
    if (typed.length === 0 || (INVENTORY_NAME_RE.test(typed) && typed.length <= INVENTORY_NAME_MAX)) {
        return undefined;
    }
    return typed.length > INVENTORY_NAME_MAX
        ? t(`views.addWantDialog.nameTooLong`, { max: INVENTORY_NAME_MAX, length: typed.length })
        : t(`views.addWantDialog.nameRule`);
});
// Offered rather than applied: the box is the user's, and a name silently rewritten under the cursor is worse than one
// refused out loud.
const useRepairedName = (): void => {
    name.value = inventoryIdentifier(name.value);
};

// Apps in workspace monorepos; fetched only while the dialog is open, live against the repo list.
const { apps: workspaceApps, error: appsError } = useWorkspaceApps(visible);
const appsNotice = computed<NoticeModel | undefined>(() =>
    appsError.value === undefined ? undefined : { tone: `danger`, title: t(`views.addWantDialog.couldntListAppsIn`), detail: appsError.value },
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
        INVENTORY_NAME_RE.test(name.value.trim()) &&
        name.value.trim().length <= INVENTORY_NAME_MAX &&
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
    // Repaired on the way in: app directories are `web-app`, and offering one the form then refuses is the worst way
    // to start.
    name.value = inventoryIdentifier(picked.kind === `service` ? picked.service.service : picked.app);
    subdomain.value = picked.kind === `app` ? subdomainLabel(picked.app) : ``;
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
        error.value = noticeFrom(err, t(`views.addWantDialog.couldNotAdd`));
    } finally {
        submitting.value = false;
    }
};
</script>

<template>
    <!-- Step 2 is titled by what was picked: its mark, its name and what it is, where step 1 asks what to add. -->
    <Modal
        v-model:open="visible"
        size="md"
        :header="selected === undefined ? t(`ui.action.add`) : selected.kind === `service` ? selected.service.label : selected.app"
        @hide="reset"
    >
        <template v-if="selected" #icon>
            <BrandMark
                v-if="selected.kind === `service`"
                :size="36"
                :name="selected.service.label"
                :logo="selected.service.logo"
                :icon="selected.service.icon ?? `server`"
            />
            <BrandMark v-else :size="36" :name="selected.app" icon="code" />
        </template>
        <template #description>
            <template v-if="selected">{{
                selected.kind === `service` ? serviceDescription(selected.service) : t(`views.addWantDialog.appMonorepo`, { repo: selected.repo })
            }}</template>
            <template v-else
                >{{ t(`views.addWantDialog.pickWhatWantTo`) }}<span class="font-mono text-xs">deploy.config.ts</span
                >{{ t(`views.addWantDialog.deployedOnNextApply`) }}</template
            >
        </template>

        <!-- STEP 2: the picked want's form. -->
        <div v-if="selected" class="flex flex-col gap-4">
            <Notice v-if="error" :of="error" />

            <!-- A want needs Cloudflare and a server; both are collected inline rather than sending the user elsewhere. -->
            <CloudflareConnect v-if="cloudflareEntries.length === 0" />
            <ConnectHost v-else-if="hostOptions.length === 0">
                <template #reason>{{ t(`views.words.whatWantNeedsServer`) }}</template>
            </ConnectHost>
            <form v-else :id="formId" class="flex flex-col gap-3" @submit.prevent="submit">
                <label class="ui-field">
                    <span class="ui-field-label">{{ t(`shared.name`) }}</span>
                    <input v-model="name" :placeholder="selected.kind === `service` ? selected.service.service : selected.app" :class="ui.input()" />
                    <!-- Names the rule and offers the repair, rather than leaving Add greyed out with nothing said. -->
                    <span v-if="nameError" class="text-xs text-warning">
                        {{ nameError }}
                        <button v-if="inventoryIdentifier(name)" type="button" :class="ui.textButton({ tone: `quiet` })" @click="useRepairedName">
                            {{ t(`views.addWantDialog.use`, { name: inventoryIdentifier(name) }) }}
                        </button>
                    </span>
                </label>
                <!-- Domain is zone-aware whenever the cloudflare entry recorded its zone: a subdomain under it. -->
                <label v-if="zone !== undefined" class="ui-field">
                    <span class="ui-field-label">{{ t(`shared.domain`) }}</span>
                    <div class="flex items-center gap-2">
                        <input v-model="subdomain" :placeholder="name" :class="ui.input('flex-1')" />
                        <span class="whitespace-nowrap font-mono text-sm text-subtle">.{{ zone }}</span>
                    </div>
                    <span v-if="subdomain.trim().length > 0 && !subdomainValid" class="text-xs text-warning">{{
                        subdomainError ?? t(`setup.words.useLettersNumbersHyphens`)
                    }}</span>
                    <span v-else-if="subdomainValid" class="text-xs text-success"
                        >{{ t(`views.addWantDialog.reachableAt`) }} <span class="font-mono">{{ subdomain.trim() }}.{{ zone }}</span></span
                    >
                </label>
                <label v-else class="ui-field">
                    <span class="ui-field-label">{{ t(`shared.domain`) }}</span>
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
                    <span class="ui-field-label">{{ t(`views.addWantDialog.server`) }}</span>
                    <!-- `on` holds `` for "none yet" (Picker's empty state), never undefined: explicit binding, not v-model. -->
                    <Picker
                        :model-value="on === `` ? undefined : on"
                        :options="hostPickerOptions"
                        :placeholder="t(`views.addWantDialog.pickServer`)"
                        class="w-full"
                        :aria-label="t(`views.addWantDialog.server`)"
                        @update:model-value="(value: string | undefined) => (on = value ?? ``)"
                    />
                </label>
            </form>
        </div>

        <!-- STEP 1: the catalog, your apps, then the self-hosted services. -->
        <div v-else class="flex flex-col gap-4">
            <Section v-if="workspaceApps.length > 0 || appsError" :label="t(`views.addWantDialog.apps`)">
                <Notice v-if="appsNotice" :of="appsNotice" class="mb-2" />
                <!-- Choices are rows on the dialog's ground, not cards on it: the wash under the pointer is the affordance, and the
                     grid reaches out by the rows' padding so the marks line up with the label above. -->
                <div class="-mx-2.5 grid grid-cols-2 gap-x-1 gap-y-0.5">
                    <button
                        v-for="candidate in workspaceApps"
                        :key="`${candidate.repo}--${candidate.app}`"
                        type="button"
                        class="ui-off ui-row-select flex items-start gap-3 rounded-lg p-2.5 text-left"
                        :disabled="declaredApps.has(candidate.app)"
                        v-action="() => pick({ kind: `app`, ...candidate })"
                    >
                        <BrandMark :size="32" :name="candidate.app" icon="code" />
                        <div class="min-w-0">
                            <div class="flex items-center gap-2 font-medium text-content">
                                {{ candidate.app }}
                                <Icon name="check" v-if="declaredApps.has(candidate.app)" aria-hidden="true" class="text-2xs text-success" />
                            </div>
                            <div class="mt-0.5 text-xs text-muted">{{ candidate.repo }}</div>
                        </div>
                    </button>
                </div>
            </Section>

            <!-- Headed only when the apps above are: alone, the services are the whole step. -->
            <Section :label="workspaceApps.length > 0 || appsError ? t(`views.words.selfHostedServices`) : undefined">
                <div class="-mx-2.5 grid grid-cols-2 gap-x-1 gap-y-0.5">
                    <button
                        v-for="service in INVENTORY_SERVICES"
                        :key="service.service"
                        type="button"
                        class="ui-row-select flex items-start gap-3 rounded-lg p-2.5 text-left"
                        v-action="() => pick({ kind: `service`, service })"
                    >
                        <BrandMark :size="32" :name="service.label" :logo="service.logo" :icon="service.icon ?? `server`" />
                        <div class="min-w-0">
                            <div class="font-medium text-content">{{ service.label }}</div>
                            <div class="mt-0.5 text-xs text-muted">{{ serviceDescription(service) }}</div>
                        </div>
                    </button>
                </div>
            </Section>
        </div>

        <template v-if="selected" #footer>
            <Button :label="t(`ui.action.back`)" tier="quiet" class="mr-auto" @click="selected = undefined">
                <template #icon><Icon name="arrow-left" /></template>
            </Button>
            <Button
                v-if="cloudflareEntries.length > 0 && hostOptions.length > 0"
                type="submit"
                :form="formId"
                :label="t(`ui.action.add`)"
                :disabled="!canSubmit || submitting"
                :loading="submitting"
            >
                <template #icon><Icon name="check" /></template>
            </Button>
        </template>
    </Modal>
</template>
