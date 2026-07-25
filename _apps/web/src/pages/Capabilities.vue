<script setup lang="ts">
import {
    type AddCapabilityInput,
    CAPABILITY_CATALOG,
    CAPABILITY_CATEGORIES,
    type CapabilityCatalogEntry,
    type CapabilityField,
    connectorCard,
} from "@intentic-app/capability-catalog";
import { type CapabilitySummary, type Marketplace, type MarketplacePlugin } from "@intentic-app/api-contract";
import { cmp, type IconName, Page, PageHeader, RowGroup, Segmented } from "@intentic-app/ui";
import { type CapabilityEffect, capabilityEffects, type ForticlientConnection, isForticlientCiphertext } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import BrowserLoginDialog from "../components/BrowserLoginDialog.vue";
import CapabilityEffects from "../components/CapabilityEffects.vue";
import CredentialGuide from "../components/CredentialGuide.vue";
import { devFillGet, devFillSet } from "../composables/devFill";
import { sandboxJson } from "../composables/sandbox/sandboxClient";
import { errorMessage } from "../composables/useAsyncAction";
import { browseMarketplace, useCapabilities } from "../composables/extensions/useCapabilities";
import { useExtensions } from "../composables/extensions/useExtensions";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { importForticlient, useVpn } from "../composables/sandbox/useVpn";

/* The rail's "+" → the /capabilities page. Capabilities give the agent tools (GitHub, MCP servers, SSH hosts,
 * Stripe…), plus a few that scaffold managed repos (DevOps → intent + desired-state, each its own operator
 * panel). Cards are grouped into sections by CAPABILITY_CATEGORIES. Core cards are static catalog data; cli
 * cards DERIVE from the installed extensions' contributes.connectors (connectorCard), so a cli card exists iff
 * its capability is actually addable. Pick a card → fill its config → apply STREAMS its progress live. The
 * manifest is the source of truth; nothing is stored on the platform. */

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const URL_RE = /^https?:\/\/.+/i;

const { hasCapability, capabilities, error: listError, add, remove, refetch } = useCapabilities();
const { connectorOf, extensions, settled: extensionsSettled } = useExtensions();
// VPN instances get live link state and connect/disconnect here too — the same daemon routes the Sandbox ▸
// Status card drives, so a tunnel dialled from either place reads identically in both.
const { links: vpnLinks } = useVpn();

// The full card list: connector cards derived from the installed extensions' contributions (one card per
// provider, first declaration wins — the daemon connectorRegistry's precedent) + the static core cards.
const allCards = computed<CapabilityCatalogEntry[]>(() => {
    const seen = new Set<string>();
    const derived: CapabilityCatalogEntry[] = [];
    for (const extension of extensions.value) {
        for (const connector of extension.manifest.contributes?.connectors ?? []) {
            if (!seen.has(connector.provider)) {
                seen.add(connector.provider);
                derived.push(connectorCard(connector));
            }
        }
    }
    return [...derived, ...CAPABILITY_CATALOG];
});

const route = useRoute();
const router = useRouter();

// The picked card is URL-driven (/capabilities/<id>); an absent or unknown slug → undefined → the catalog grid.
const selected = computed<CapabilityCatalogEntry | undefined>(() => allCards.value.find((entry) => entry.id === route.params[`card`]));
const name = ref(``);
// Whether the user (or a marketplace pick) chose the name. Until then the field holds a suggestion, and the
// suggestion must track the LIVE list: pick() may run against a stale-hydrated or still-fetching list, and a
// frozen snapshot then collides ("already exists") — or worse, mints a stale-bumped id — once fresh data lands.
const nameEdited = ref(false);

// Cards that share a `kind` are told apart by a discriminator field the card fixes — `provider` for the cli cards,
// `platform` for the browser cards (both map straight to the capability's config). The value is a single fixed
// value, or the options for a multi-provider card (the SQL card owns postgres + mysql). Single-card kinds
// (mcp/plugin/ssh/…) have no such field → undefined → every instance of the kind matches. Used to find a
// card's live instances.
const cardDiscriminator = (entry: CapabilityCatalogEntry): { key: string; values: string[] } | undefined => {
    const field = entry.fields.find((f) => f.key === `provider` || f.key === `platform`);
    if (field === undefined) {
        return undefined;
    }
    const values = field.value !== undefined ? [field.value] : (field.options ?? []).map((option) => option.value);
    return { key: field.key, values };
};
const instancesOf = (entry: CapabilityCatalogEntry): CapabilitySummary[] => {
    const disc = cardDiscriminator(entry);
    return capabilities.value.filter(
        (capability) => capability.kind === entry.kind && (disc === undefined || disc.values.includes(String(capability.config[disc.key]))),
    );
};
const selectedInstances = computed<CapabilitySummary[]>(() => (selected.value ? instancesOf(selected.value) : []));

// A free instance name: the provider id if unused, else the first `<id>-2`, `-3`, … so repeat adds create
// distinct connections instead of upserting the same id (the silent-overwrite trap).
const suggestName = (entry: CapabilityCatalogEntry): string => {
    const taken = new Set(instancesOf(entry).map((instance) => instance.id));
    if (!taken.has(entry.id)) {
        return entry.id;
    }
    let n = 2;
    while (taken.has(`${entry.id}-${n}`)) {
        n += 1;
    }
    return `${entry.id}-${n}`;
};
// The typed name already exists → saving updates that connection rather than adding a new one.
const nameCollision = computed(() => selectedInstances.value.some((instance) => instance.id === name.value.trim()));

// The catalog grouped into its display sections, in category order; empty sections are dropped. Derived
// connector cards render before the static ones within a section (allCards order).
const groupedCatalog = computed(() =>
    CAPABILITY_CATEGORIES.map((category) => ({
        label: category.label,
        hint: category.hint,
        entries: allCards.value.filter((entry) => entry.category === category.id),
    })).filter((group) => group.entries.length > 0),
);

watch(capabilities, () => {
    if (selected.value !== undefined && !nameEdited.value) {
        name.value = suggestName(selected.value);
    }
});
const values = reactive<Record<string, string>>({});
const submitting = ref(false);
const error = ref<string | null>(null);
const log = ref<string[]>([]);
// undefined = the confirm dialog is closed; a string = the capability id awaiting a confirmed removal.
const confirmRemoveId = ref<string>();
// Catalog logos that failed to load (bad/absent simple-icons slug) → fall back to a per-kind icon.
const logoFailed = reactive(new Set<string>());

// --- inline validation (touched-on-blur) ---
// A field key appears here after the user has interacted with it (blur), so errors show only after they leave.
const touched = reactive(new Set<string>());
const shaking = ref(false);
const markTouched = (key: string): void => {
    touched.add(key);
};

// Field-level error messages — undefined means the field is valid.
const nameError = computed<string | undefined>(() => {
    const trimmed = name.value.trim();
    if (trimmed.length === 0) return `Name is required.`;
    if (!NAME_RE.test(trimmed)) return `Use letters, digits, hyphens and underscores; must start with a letter or digit.`;
    return undefined;
});

const fieldError = (field: CapabilityField): string | undefined => {
    const val = (values[field.key] ?? ``).trim();
    if (field.optional !== true && val.length === 0) return `This field is required.`;
    if (val.length > 0 && !field.secret && field.key.toLowerCase().includes(`url`) && !URL_RE.test(val)) return `Enter a valid URL (e.g. https://…).`;
    // A value lifted straight out of a FortiClient config is ciphertext, not a credential — the daemon rejects
    // it, so say so here rather than after a round-trip.
    if (val.length > 0 && isForticlientCiphertext(val)) {
        return `FortiClient encrypted this with a key tied to the machine that exported it — it can't be used. Enter the real value.`;
    }
    if (val.length > 0 && field.key === `port`) {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return `Enter a valid port number (1–65535).`;
    }
    return undefined;
};

const logoUrl = (entry: CapabilityCatalogEntry): string | undefined =>
    entry.logo !== undefined ? `https://cdn.simpleicons.org/${entry.logo}` : undefined;
const kindIcon = (kind: string): IconName =>
    kind === `devops`
        ? `server`
        : kind === `monorepo`
          ? `sitemap`
          : kind === `service`
            ? `box`
            : kind === `integration`
              ? `link`
              : kind === `plugin`
                ? `th-large`
                : kind === `browser`
                  ? `globe`
                  : kind === `agent`
                    ? `sparkles`
                    : `bolt`;
// The glyph shown when a card has no simple-icons logo (or it failed to load): the card's explicit `icon`,
// else the generic per-kind fallback.
const entryIcon = (entry: CapabilityCatalogEntry): IconName => (entry.icon as IconName | undefined) ?? kindIcon(entry.kind);

// Guided browser-login dialog state (browser-kind capabilities: the session is a real logged-in browser, not a
// pasted token, so it's connected out-of-band over the /system/browser-login WebSocket).
const loginVisible = ref(false);
const loginPlatform = ref(``);
const loginLabel = ref(``);
// An ACP agent's interactive sign-in: the daemon starts its loginCommand in the capability's job session and
// the terminal panel opens focused on it (user-clicked action → openFocused, the add-stream precedent).
const startAgentLogin = async (id: string): Promise<void> => {
    try {
        const { session } = await sandboxJson<{ session: string }>(`/capabilities/${encodeURIComponent(id)}/login`, { method: `POST` });
        useTerminalPanel().openFocused(session);
    } catch (caught) {
        error.value = errorMessage(caught, `Sign-in could not start.`);
    }
};

const openLogin = (platform: string, label: string): void => {
    loginPlatform.value = platform;
    loginLabel.value = label;
    loginVisible.value = true;
};
// A completed login flips the capability's status pending → active; refresh the list so it shows.
const onLoginDone = (): void => {
    void refetch();
};
// A `when`-gated field applies only while its referenced field holds the given value (e.g. the SSH credential
// matching the chosen auth mode). Read from reactive `values`, so it re-evaluates as the user toggles.
const whenMet = (field: CapabilityField): boolean => field.when === undefined || values[field.when.key] === field.when.value;
// The fields shown as inputs (const-valued ones are baked into config, not rendered; when-gated ones only
// while their condition holds).
const visibleFields = (entry: CapabilityCatalogEntry): CapabilityCatalogEntry["fields"] =>
    entry.fields.filter((field) => field.value === undefined && whenMet(field));

const touchAll = (): void => {
    touched.add(`name`);
    if (selected.value) {
        for (const field of visibleFields(selected.value)) {
            touched.add(field.key);
        }
    }
};
const requiresMet = computed(() => (selected.value ? (selected.value.requires ?? []).every((kind) => hasCapability(kind)) : false));

// --- effect derivation (the "This will add to your sandbox" disclosure) ---
// The config as capabilityEffects sees it: fixed fields baked in (like buildInput), the rest from a source —
// the live form values, the card's declared defaults (grid badges), or an instance's echoed config.
const effectConfig = (entry: CapabilityCatalogEntry, source: (field: CapabilityField) => string | undefined): Record<string, string> => {
    const config: Record<string, string> = {};
    for (const field of entry.fields) {
        const value = field.value ?? source(field);
        if (value !== undefined) {
            config[field.key] = value;
        }
    }
    return config;
};
// Live over the form state, so the plugin clone URL tracks as the user types. A selected cli card exists only
// because its connector is installed (allCards derives it), so connectorOf always resolves here — the effects
// panel is complete by construction.
const liveEffects = computed<readonly CapabilityEffect[]>(() => {
    const entry = selected.value;
    if (entry === undefined) {
        return [];
    }
    const config = effectConfig(entry, (field) => (values[field.key] ?? ``).trim());
    return capabilityEffects({ kind: entry.kind, id: name.value.trim() || undefined, config, connector: connectorOf(config[`provider`] ?? ``) });
});
// The consequential effects a card statically implies, badged on its grid tile — image/runtime/trusted-code
// only (the full list is one click away). Defaults decide config-dependent ones (the SQL card's default engine).
const badgeEffects = (entry: CapabilityCatalogEntry): readonly CapabilityEffect[] => {
    const config = effectConfig(entry, (field) => field.default);
    return capabilityEffects({ kind: entry.kind, config, connector: connectorOf(config[`provider`] ?? ``) }).filter(
        (effect) => effect.kind === `image` || effect.kind === `runtime` || effect.kind === `trusted-code`,
    );
};
// A connected instance's effects from its secret-stripped config echo; an installed extension also resolves
// its manifest so process/image contributions show.
const instanceEffects = (instance: CapabilitySummary): readonly CapabilityEffect[] =>
    capabilityEffects({
        kind: instance.kind,
        id: instance.id,
        config: instance.config,
        connector: connectorOf(String(instance.config[`provider`] ?? ``)),
        manifest: instance.kind === `extension` ? extensions.value.find((extension) => extension.id === instance.id)?.manifest : undefined,
    });

const canSubmit = computed(() => {
    const entry = selected.value;
    if (entry === undefined || !requiresMet.value) {
        return false;
    }
    if (!NAME_RE.test(name.value.trim())) {
        return false;
    }
    return visibleFields(entry).every((field) => field.optional === true || (values[field.key] ?? ``).trim().length > 0);
});

// Marketplace browse (plugin card only): resolve a marketplace repo into entries; picking one pre-fills the
// plugin form below (install stays the ordinary plugin apply).
const marketUrl = ref(``);
const marketToken = ref(``);
const market = ref<Marketplace | null>(null);
const browsing = ref(false);

const browse = async (): Promise<void> => {
    if (marketUrl.value.trim().length === 0 || browsing.value) {
        return;
    }
    browsing.value = true;
    error.value = null;
    market.value = null;
    try {
        market.value = await browseMarketplace(marketUrl.value.trim(), marketToken.value.trim() || undefined);
    } catch (err) {
        error.value = errorMessage(err, `Could not browse the marketplace.`);
    } finally {
        browsing.value = false;
    }
};

// A connected VPN instance's live facts, compactly: the assigned address and what it routes. Undefined while
// the tunnel is down — the capability row's own status already says that.
const vpnFacts = (id: string): string | undefined => {
    const link = vpnLinks.value.find((candidate) => candidate.id === id);
    if (link === undefined || link.state !== `connected`) {
        return undefined;
    }
    return [link.address, link.routes.includes(`0.0.0.0/0`) ? `all traffic` : link.routes.join(`, `)].filter((fact) => fact !== undefined && fact !== ``).join(` · `);
};

// --- FortiClient import (vpn card only) ---
// A user with an exported FortiClient config pastes it and picks a connection instead of re-keying its host,
// port and protocol per tunnel. The daemon parses it; nothing is stored until the ordinary add below runs.
const forticlientXml = ref(``);
const forticlientConnections = ref<ForticlientConnection[]>([]);
const importing = ref(false);
const imported = ref(false);

const importForticlientConfig = async (): Promise<void> => {
    if (forticlientXml.value.trim().length === 0 || importing.value) {
        return;
    }
    importing.value = true;
    error.value = null;
    try {
        forticlientConnections.value = await importForticlient(forticlientXml.value);
        imported.value = true;
    } catch (err) {
        error.value = errorMessage(err, `Could not read that FortiClient configuration.`);
    } finally {
        importing.value = false;
    }
};

// Fill the form from a parsed connection. Credentials are never among them (FortiClient encrypts them), so the
// user still types the secret — `needs` is what tells them which fields are waiting.
const pickForticlient = (connection: ForticlientConnection): void => {
    name.value = connection.id;
    nameEdited.value = true;
    // Blank every secret first. FortiClient encrypts credentials, so none can be imported — and anything
    // already in those fields belongs to a DIFFERENT connection (or to dev autofill, which remembers the last
    // value pasted for this card). Carrying it over silently submits the wrong credential, which is exactly
    // how an EncX blob reached the daemon and got rejected.
    for (const field of selected.value?.fields ?? []) {
        if (field.secret === true) {
            values[field.key] = ``;
        }
    }
    values[`provider`] = connection.provider;
    values[`server`] = connection.server;
    values[`port`] = String(connection.port);
    values[`username`] = connection.username ?? ``;
    if (connection.provider === `ipsec`) {
        values[`localId`] = connection.localId ?? ``;
        values[`aggressive`] = connection.aggressive === true ? `on` : `off`;
        values[`ikeVersion`] = `1`;
        // Phase 2 decides whether quick mode can succeed at all — carry both across from the export.
        values[`pfs`] = connection.pfs === false ? `off` : `on`;
        if (connection.dhGroup !== undefined) {
            values[`dhGroup`] = connection.dhGroup;
        }
    }
    // The fields still needed are the ones to land on, not the top of the form.
    touched.clear();
};

const pickPlugin = (plugin: MarketplacePlugin): void => {
    if (plugin.install === undefined) {
        return;
    }
    name.value = plugin.name.replace(/[^a-zA-Z0-9_-]/g, `-`);
    nameEdited.value = true;
    values[`url`] = plugin.install.url;
    values[`ref`] = plugin.install.ref ?? ``;
    values[`path`] = plugin.install.path ?? ``;
    // A plugin hosted inside a private marketplace repo needs the same token to clone.
    values[`token`] = plugin.install.url === marketUrl.value.trim() ? marketToken.value.trim() : ``;
};

const clearForm = (): void => {
    name.value = ``;
    nameEdited.value = false;
    for (const key of Object.keys(values)) {
        delete values[key];
    }
    error.value = null;
    log.value = [];
    marketUrl.value = ``;
    marketToken.value = ``;
    market.value = null;
    touched.clear();
    shaking.value = false;
};

// One init path for both a click and a deep link: (re)seed the form whenever the URL selects a card.
watch(
    selected,
    (entry) => {
        if (entry === undefined) {
            return;
        }
        clearForm();
        // Pre-fill a free name: the provider id for the first connection, `<id>-2` etc. for the next — so re-adding
        // creates another connection by default instead of overwriting the first.
        name.value = suggestName(entry);
        // Seed every editable field (ignoring `when`) so toggling a mode reveals an already-initialized field.
        for (const field of entry.fields) {
            if (field.value === undefined) {
                values[field.key] = field.default ?? ``;
            }
        }
        // Dev autofill (inert in prod): prefill secret fields with the values the last successful add used.
        // A remembered value that the daemon would now reject is skipped — it was saved before the check
        // existed, and silently re-offering it turns a convenience into a confusing 400 on submit.
        for (const field of entry.fields) {
            if (field.secret === true && field.value === undefined) {
                const remembered = devFillGet(`capability.${entry.id}.${field.key}`);
                if (remembered !== undefined && !isForticlientCiphertext(remembered)) {
                    values[field.key] = remembered;
                }
            }
        }
    },
    { immediate: true },
);

// An unknown slug (/capabilities/nonsense) resolves to no card → clean the URL back to the grid. Gated on the
// extensions query having settled: a deep-linked connector card (/capabilities/github) is unknown until
// /extensions delivers its contribution, and bouncing early would eat the link.
watch(
    [() => route.params[`card`], extensionsSettled],
    ([card]) => {
        if (typeof card === `string` && card.length > 0 && extensionsSettled.value && selected.value === undefined) {
            void router.replace({ name: `capabilities` });
        }
    },
    { immediate: true },
);

// Picking a card / going back is a navigation now — the URL is the source of truth for what's shown.
const pick = (entry: CapabilityCatalogEntry): void => {
    void router.push({ name: `capabilities`, params: { card: entry.id } });
};

const back = (): void => {
    void router.push({ name: `capabilities` });
};

const buildInput = (entry: CapabilityCatalogEntry): AddCapabilityInput => {
    const config: Record<string, string> = {};
    for (const field of entry.fields) {
        if (field.value !== undefined) {
            config[field.key] = field.value;
            continue;
        }
        // Skip fields gated out by the current mode — e.g. the SSH credential of the unchosen auth branch.
        if (!whenMet(field)) {
            continue;
        }
        const value = (values[field.key] ?? ``).trim();
        if (value.length > 0) {
            config[field.key] = value;
        }
    }
    return { id: name.value.trim(), kind: entry.kind, config };
};

const submit = async (): Promise<void> => {
    const entry = selected.value;
    if (entry === undefined || submitting.value) {
        return;
    }
    // Mark every field touched so validation errors become visible on a premature submit.
    touchAll();
    if (!canSubmit.value) {
        shaking.value = false;
        void nextTick(() => {
            shaking.value = true;
        });
        return;
    }
    submitting.value = true;
    error.value = null;
    log.value = [];
    try {
        await add(buildInput(entry), (line) => {
            // The handler's shell runs in a real tmux session — open its terminal tab so the user watches the
            // actual commands (user-clicked action → openFocused, the apply/vitest/add-apps precedent). The
            // inline log below stays as the structured summary.
            if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                useTerminalPanel().openFocused(line[`session`]);
                return;
            }
            const message = line[`message`];
            if (typeof message === `string`) {
                log.value = [...log.value, message];
            }
        });
        // Dev autofill persist (inert in prod): remember the secret fields that just worked, per card.
        for (const field of entry.fields) {
            if (field.secret === true && field.value === undefined) {
                devFillSet(`capability.${entry.id}.${field.key}`, (values[field.key] ?? ``).trim());
            }
        }
        back();
    } catch (err) {
        error.value = errorMessage(err, `Could not add the capability.`);
    } finally {
        submitting.value = false;
    }
};

const removeCapability = async (id: string): Promise<void> => {
    error.value = null;
    try {
        await remove.mutateAsync(id);
    } catch (err) {
        error.value = errorMessage(err, `Could not remove the capability.`);
    }
};

const askRemove = (id: string): void => {
    confirmRemoveId.value = id;
};
const confirmRemove = async (): Promise<void> => {
    const id = confirmRemoveId.value;
    if (id === undefined) {
        return;
    }
    await removeCapability(id);
    confirmRemoveId.value = undefined;
};

const topError = computed(() => error.value ?? listError.value);
const submitLabel = computed(() =>
    selected.value?.kind === `devops` ? `Activate` : nameCollision.value ? `Update` : selected.value?.kind === `service` ? `Add & provision` : `Add`,
);
</script>

<template>
    <Page width="wide">
        <div v-if="topError" :class="cmp.alertDanger('mb-4')">{{ topError }}</div>

        <!-- STEP 2: configure + apply the picked capability. Centered so a short form doesn't stretch the page. -->
        <div v-if="selected" class="mx-auto max-w-xl">
            <button type="button" class="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-content" @click="back">
                <Icon name="arrow-left" class="text-2xs" /> All capabilities
            </button>

            <div class="mb-4 flex items-center gap-3">
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-card">
                    <img
                        v-if="logoUrl(selected) && !logoFailed.has(selected.id)"
                        :src="logoUrl(selected)"
                        :alt="selected.name"
                        class="h-5 w-5 object-contain"
                        @error="logoFailed.add(selected.id)"
                    />
                    <Icon v-else :name="entryIcon(selected)" class="text-sm text-link" />
                </span>
                <div class="min-w-0">
                    <div class="font-medium text-content">{{ selected.name }}</div>
                    <div class="text-xs text-muted">{{ selected.description }}</div>
                </div>
            </div>

            <!-- Precondition gate: a service/integration needs DevOps first. -->
            <div v-if="!requiresMet" class="rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-xs text-info">
                This needs <b>DevOps</b> active first. Go back and activate the DevOps capability, then add this.
            </div>

            <form v-else class="flex flex-col gap-3" @submit.prevent="submit">
                <!-- The connectors already added for this card — each instance removable here (the only place a
                     custom-named instance can be torn down). -->
                <RowGroup v-if="selectedInstances.length > 0" label="Connected">
                    <div v-for="instance in selectedInstances" :key="instance.id" class="flex flex-col gap-1 px-4 py-3">
                        <div class="flex items-center gap-2 text-xs">
                            <span class="font-medium text-content">{{ instance.id }}</span>
                            <span class="text-2xs text-muted">{{ instance.status.state }}</span>
                            <!-- A VPN's live link says more than "active": the address it was assigned and what
                                 it routes are what tell you whether your internal host is reachable through it. -->
                            <span v-if="selected.kind === 'vpn' && vpnFacts(instance.id)" class="font-mono text-2xs text-subtle">{{
                                vpnFacts(instance.id)
                            }}</span>
                            <div class="ml-auto flex items-center gap-1">
                                <!-- A browser capability connects via a live login window, not a form — offer it here
                                         (also the way to re-log-in once a session expires). -->
                                <Button
                                    v-if="selected.kind === 'browser'"
                                    :label="instance.status.state === 'active' ? 'Re-log in' : 'Log in'"
                                    size="small"
                                    :text="true"
                                    @click="openLogin(String(instance.config[`platform`]), selected.name)"
                                >
                                    <template #icon><Icon name="sign-in" /></template>
                                </Button>
                                <!-- An ACP agent with a declared loginCommand signs in interactively: the daemon
                                         starts it in the capability's job session and the terminal panel opens on it. -->
                                <Button
                                    v-if="selected.kind === 'agent' && instance.config[`loginCommand`] !== undefined"
                                    label="Sign in"
                                    size="small"
                                    :text="true"
                                    @click="startAgentLogin(instance.id)"
                                >
                                    <template #icon><Icon name="sign-in" /></template>
                                </Button>
                                <!-- A VPN is dialled from the Status card, which owns the whole flow (progress,
                                     the gateway's own error text, a one-time code field). Linking there beats a
                                     second, thinner set of controls that would handle 2FA worse. -->
                                <RouterLink
                                    v-if="selected.kind === 'vpn'"
                                    to="/sandbox/status"
                                    class="inline-flex items-center gap-1 px-2 text-2xs text-link hover:underline"
                                >
                                    Connect / disconnect <Icon name="arrow-right" class="text-2xs" />
                                </RouterLink>
                                <Button
                                    v-if="selected.kind !== 'devops'"
                                    size="small"
                                    severity="danger"
                                    :text="true"
                                    :rounded="true"
                                    aria-label="Remove instance"
                                    @click="askRemove(instance.id)"
                                >
                                    <template #icon><Icon name="trash" /></template>
                                </Button>
                            </div>
                        </div>
                        <CapabilityEffects :effects="instanceEffects(instance)" :compact="true" />
                        <!-- A browser capability that's installed but not signed in is pending on the LOGIN, not a
                                 rebuild — make the hint open the login window (same action as the button above), never
                                 the /sandbox rebuild hub. Keyed off the daemon's "rebuild" detail (see handlers/browser.ts). -->
                        <button
                            v-if="
                                instance.status.state === 'pending' &&
                                selected.kind === 'browser' &&
                                !String(instance.status.detail ?? '').includes('rebuild')
                            "
                            type="button"
                            class="inline-flex w-fit items-center gap-1 text-2xs text-warning hover:underline"
                            @click="openLogin(String(instance.config[`platform`]), selected.name)"
                        >
                            <Icon name="exclamation-triangle" />
                            {{ instance.status.detail ?? "Not connected" }} — Log in →
                        </button>
                        <!-- A capability that needs a sandbox rebuild (Discord voice / a DB client / a browser whose
                                 Chromium isn't installed yet) is otherwise a dead-end "pending" — point at the Sandbox ▸
                                 Environment tab where the rebuild command lives. -->
                        <RouterLink
                            v-else-if="instance.status.state === 'pending'"
                            to="/sandbox/environment"
                            class="inline-flex items-center gap-1 text-2xs text-warning hover:underline"
                        >
                            <Icon name="exclamation-triangle" />
                            {{ instance.status.detail ?? "Needs a sandbox rebuild" }} — Finish setup →
                        </RouterLink>
                    </div>
                </RowGroup>

                <!-- FortiClient import (vpn only): paste an exported config and pick a connection to pre-fill
                     the form. FortiClient encrypts stored credentials with a machine-bound key, so the secret
                     is never importable — each connection says which fields are still waiting. -->
                <RowGroup v-if="selected.kind === 'vpn'" label="Import from FortiClient (optional)">
                    <div class="flex flex-col gap-2 px-4 py-3">
                        <p class="text-2xs text-muted">
                            Paste an exported FortiClient configuration (File ▸ Settings ▸ Backup) to fill the form from one of its
                            connections. Passwords in that file are encrypted by FortiClient and can't be read — you'll still type those.
                        </p>
                        <textarea
                            v-model="forticlientXml"
                            rows="4"
                            spellcheck="false"
                            placeholder="<?xml version=&quot;1.0&quot;?><forticlient_configuration> …"
                            :class="cmp.input('font-mono resize-y')"
                        />
                        <div class="flex justify-end">
                            <Button
                                label="Read connections"
                                size="small"
                                :disabled="forticlientXml.trim().length === 0 || importing"
                                :loading="importing"
                                @click="importForticlientConfig"
                            />
                        </div>
                        <p v-if="imported && forticlientConnections.length === 0" class="text-2xs text-warning">
                            No VPN connections found in that file.
                        </p>
                        <div v-if="forticlientConnections.length > 0" class="scrollbar-thin flex max-h-48 flex-col gap-0.5 overflow-auto">
                            <button
                                v-for="connection in forticlientConnections"
                                :key="`${connection.provider}-${connection.id}`"
                                type="button"
                                class="flex flex-col gap-0.5 rounded-md bg-canvas px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-overlay"
                                @click="pickForticlient(connection)"
                            >
                                <span class="flex items-baseline gap-2">
                                    <span class="font-medium text-content">{{ connection.label }}</span>
                                    <span class="text-2xs text-subtle">{{ connection.provider === "fortinet" ? "SSL-VPN" : "IPsec" }}</span>
                                    <span class="min-w-0 truncate font-mono text-2xs text-muted">{{ connection.server }}:{{ connection.port }}</span>
                                </span>
                                <span class="text-2xs text-subtle">You'll need to enter: {{ connection.needs.join(", ") }}</span>
                            </button>
                        </div>
                    </div>
                </RowGroup>

                <!-- Marketplace browse (plugin only): resolve a marketplace repo and pre-fill the form below. -->
                <RowGroup v-if="selected.kind === 'plugin'" label="From a marketplace (optional)">
                    <div class="flex flex-col gap-2 px-4 py-3">
                        <div class="flex gap-2">
                            <input v-model="marketUrl" placeholder="https://github.com/owner/marketplace" :class="cmp.input('min-w-0 flex-1')" />
                            <input v-model="marketToken" type="password" autocomplete="off" placeholder="Token" :class="cmp.input('w-28')" />
                            <Button
                                label="Browse"
                                size="small"
                                :disabled="marketUrl.trim().length === 0 || browsing"
                                :loading="browsing"
                                @click="browse"
                            />
                        </div>
                        <div v-if="market" class="scrollbar-thin flex max-h-40 flex-col gap-0.5 overflow-auto">
                            <button
                                v-for="plugin in market.plugins"
                                :key="plugin.name"
                                type="button"
                                class="flex items-baseline gap-2 rounded-md bg-canvas px-2.5 py-1.5 text-left text-xs transition-colors enabled:hover:bg-overlay disabled:opacity-50"
                                :disabled="plugin.install === undefined"
                                @click="pickPlugin(plugin)"
                            >
                                <span class="font-medium text-content">{{ plugin.name }}</span>
                                <span v-if="plugin.version" class="text-2xs text-subtle">{{ plugin.version }}</span>
                                <span class="min-w-0 truncate text-2xs text-muted">{{ plugin.description }}</span>
                                <span v-if="plugin.install === undefined" class="ml-auto shrink-0 text-2xs text-subtle">not installable</span>
                            </button>
                        </div>
                    </div>
                </RowGroup>

                <label class="ui-field">
                    <span class="ui-field-label">Name</span>
                    <input
                        v-model="name"
                        placeholder="my-tool"
                        :class="[cmp.input(), touched.has('name') && nameError ? 'ui-field-input-error' : '']"
                        @input="nameEdited = true"
                        @blur="markTouched('name')"
                    />
                    <span v-if="touched.has('name') && nameError" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ nameError }}
                    </span>
                    <span v-else-if="nameCollision" class="mt-1 inline-flex items-center gap-1 text-2xs text-warning">
                        <Icon name="exclamation-triangle" />
                        A connection named "{{ name.trim() }}" already exists — saving will update it.
                    </span>
                    <span v-else-if="selectedInstances.length > 0" class="mt-1 text-2xs text-subtle">
                        Give this one a new name to add another connection, or reuse a name to update it.
                    </span>
                </label>
                <CredentialGuide :entry="selected" :values="values" />
                <label v-for="field in visibleFields(selected)" :key="field.key" class="ui-field">
                    <span class="ui-field-label">{{ field.label }}{{ field.optional ? " (optional)" : "" }}</span>
                    <Segmented
                        v-if="field.options"
                        :model-value="values[field.key] ?? ''"
                        :options="[...field.options]"
                        @update:model-value="values[field.key] = $event"
                    />
                    <textarea
                        v-else-if="field.multiline"
                        v-model="values[field.key]"
                        :placeholder="field.placeholder"
                        rows="6"
                        spellcheck="false"
                        :class="[cmp.input('font-mono resize-y'), touched.has(field.key) && fieldError(field) ? 'ui-field-input-error' : '']"
                        @blur="markTouched(field.key)"
                    />
                    <input
                        v-else
                        v-model="values[field.key]"
                        :type="field.secret ? 'password' : 'text'"
                        :autocomplete="field.secret ? 'off' : undefined"
                        :placeholder="field.placeholder"
                        :class="[cmp.input(), touched.has(field.key) && fieldError(field) ? 'ui-field-input-error' : '']"
                        @blur="markTouched(field.key)"
                    />
                    <span v-if="touched.has(field.key) && fieldError(field)" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ fieldError(field) }}
                    </span>
                </label>
                <CapabilityEffects :effects="liveEffects" />
                <p v-if="selected.hint" class="text-xs text-muted">{{ selected.hint }}</p>

                <!-- Streamed apply progress (devops scaffolding, service provisioning). -->
                <pre
                    v-if="log.length > 0"
                    class="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-canvas px-3 py-2 font-mono text-2xs text-subtle"
                    >{{ log.slice(-12).join("\n") }}</pre>

                <div :class="['flex justify-end', shaking ? 'ui-shake' : '']" @animationend="shaking = false">
                    <Button type="submit" :label="submitLabel" :loading="submitting">
                        <template #icon><Icon name="check" /></template>
                    </Button>
                </div>
            </form>
        </div>

        <!-- STEP 1: the catalog, grouped into sections. -->
        <template v-else>
            <PageHeader
                title="Add a capability"
                description="Grow your sandbox — each capability gives your agent new tools or connects your accounts. Everything is stored only in your sandbox."
            />

            <div class="flex flex-col gap-6">
                <div v-for="group in groupedCatalog" :key="group.label" class="flex flex-col gap-3">
                    <div>
                        <div :class="cmp.sectionLabel()">{{ group.label }}</div>
                        <div class="mt-0.5 text-xs text-muted">{{ group.hint }}</div>
                    </div>
                    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div v-for="entry in group.entries" :key="entry.id" class="group relative">
                            <button
                                type="button"
                                class="flex h-full w-full items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay"
                                @click="pick(entry)"
                            >
                                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-canvas">
                                    <img
                                        v-if="logoUrl(entry) && !logoFailed.has(entry.id)"
                                        :src="logoUrl(entry)"
                                        :alt="entry.name"
                                        class="h-5 w-5 object-contain"
                                        @error="logoFailed.add(entry.id)"
                                    />
                                    <Icon v-else :name="entryIcon(entry)" class="text-sm text-link" />
                                </span>
                                <div class="min-w-0">
                                    <div class="flex items-center gap-1.5">
                                        <span class="font-medium text-content">{{ entry.name }}</span>
                                        <span
                                            v-if="instancesOf(entry).length > 0"
                                            class="inline-flex items-center gap-1 text-2xs text-success"
                                            :aria-label="`${instancesOf(entry).length} connected`"
                                        >
                                            <Icon name="check-circle" />
                                            {{ instancesOf(entry).length }} connected
                                        </span>
                                        <CapabilityEffects :effects="badgeEffects(entry)" :compact="true" />
                                    </div>
                                    <div class="mt-0.5 text-xs text-muted">{{ entry.description }}</div>
                                    <div v-if="entry.requires?.includes('devops') && !hasCapability('devops')" class="mt-1 text-xs text-muted">
                                        Requires DevOps
                                    </div>
                                </div>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </template>

        <!-- Removal runs a real teardown in the sandbox (MCP config, SSH host, service provisioning) — confirm first. -->
        <Dialog
            :visible="confirmRemoveId !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :style="{ width: '24rem' }"
            header="Remove capability"
            @update:visible="confirmRemoveId = undefined"
        >
            <p class="text-sm text-content">
                Remove <b>{{ confirmRemoveId }}</b> from your sandbox? This tears down its configuration and can't be undone.
            </p>
            <template #footer>
                <Button label="Cancel" severity="secondary" :text="true" @click="confirmRemoveId = undefined" />
                <Button label="Remove" severity="danger" :loading="remove.isPending.value" @click="confirmRemove">
                    <template #icon><Icon name="trash" /></template>
                </Button>
            </template>
        </Dialog>

        <!-- Guided browser login for browser-kind capabilities (screencast a live Chromium the user signs into). -->
        <BrowserLoginDialog v-model:visible="loginVisible" :platform="loginPlatform" :label="loginLabel" @done="onLoginDone" />
    </Page>
</template>
