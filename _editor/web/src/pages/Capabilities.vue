<script setup lang="ts">
import {
    type AddCapabilityInput,
    CAPABILITY_CATALOG,
    CAPABILITY_CATEGORIES,
    type CapabilityCatalogEntry,
    type CapabilityCategory,
    type CapabilityEffect,
    capabilityEffects,
    contributionCard,
} from "@intentic-app/capability-catalog";
import { type CapabilitySummary, type Marketplace } from "@intentic-app/api-contract";
import { BrandMark, cmp, ConfirmDialog, FilterBar, type IconName, RowGroup, Segmented, SplitView, StatusBadge } from "@intentic/ui";
import { type CapabilityField, contributionDiscriminator } from "@intentic/extension-api";
import { isShaPinned, OFFICIAL_REGISTRY_URL, type RegistryEntry } from "@intentic/registry";
import { type CapabilityKind, type ForticlientConnection, isForticlientCiphertext } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import BrowserLoginDialog from "../components/BrowserLoginDialog.vue";
import HostConnectDialog from "../components/HostConnectDialog.vue";
import CapabilityEffects from "../components/CapabilityEffects.vue";
import CapabilityRail, { type CapabilityScope } from "../components/CapabilityRail.vue";
import CredentialGuide from "../components/CredentialGuide.vue";
import { devFillGet, devFillSet } from "../composables/devFill";
import { sandboxJson } from "../composables/sandbox/sandboxClient";
import { errorMessage } from "../composables/useAsyncAction";
import { browseMarketplace, useCapabilities } from "../composables/extensions/useCapabilities";
import { useExtensions } from "../composables/extensions/useExtensions";
import { type BackgroundProcessRow, useBackgroundProcesses, viewProcessLogs } from "../composables/terminal/useBackgroundProcesses";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { useHostConnect } from "../composables/sandbox/useHostConnect";
import { importForticlient, useVpn } from "../composables/sandbox/useVpn";

/* The rail's "+" → the /capabilities page. Capabilities give the agent tools (GitHub, MCP servers, SSH hosts,
 * Stripe…), plus a few that scaffold managed repos (DevOps → intent + desired-state, each its own operator
 * panel). Core cards are static catalog data; cli cards DERIVE from the ENABLED extensions'
 * contributes.capabilities (contributionCard), so such a card exists iff its capability is actually addable.
 * What survives as a static card is what is one-to-one with a core handler it can't be separated from. Pick a
 * card → fill its config → apply STREAMS its progress live. The manifest is the source of truth; nothing is
 * stored on the platform.
 *
 * AN INDEX BESIDE A GRID (<SplitView>), which is the shape Documentation, Activity and Maintenance already use.
 * It was one page-length scroll with every category stacked down it, and that scroll is the thing this catalog
 * grows: cards arrive with every extension anyone enables, so the page got taller with no way to reach a part of
 * it. The rail is bounded by CATEGORIES instead — see <CapabilityRail> for why that is the axis, and for the two
 * slices that cut across all of them.
 *
 * TWO THINGS NARROW THE GRID, AND EACH SITS ON WHAT IT NARROWS: the slice (the rail) and free text (the bar over
 * the grid, per <FilterBar>'s rule that the bar spans the list under it). Both live in the URL, so "the SQL cards"
 * and "everything I have connected" are links somebody can be sent. Picking a card is not a third filter but a
 * navigation: the config form takes the grid's place and the rail stays put, so abandoning a half-filled form for
 * another category is one click rather than a trip back out through the catalog. */

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const URL_RE = /^https?:\/\/.+/i;

const { hasCapability, recommendationFor, capabilities, error: listError, add, remove, refetch } = useCapabilities();
const { contributionOf, enabled: enabledExtensions, extensions, settled: extensionsSettled } = useExtensions();
// VPN instances get live link state and connect/disconnect here too — the same daemon routes the Sandbox ▸
// Status card drives, so a tunnel dialled from either place reads identically in both.
const { links: vpnLinks } = useVpn();

// The full card list: cards derived from the ENABLED extensions' contributions (first declaration of a
// kind+id wins — the daemon contributionRegistry's precedent) + the static core cards. Enabled, not installed:
// a switched-off extension stays listed so its switch is reachable, but the daemon wires none of its
// contributions up, so a card from one would fail the add it advertises.
const allCards = computed<CapabilityCatalogEntry[]>(() => {
    const seen = new Set<string>();
    const derived: CapabilityCatalogEntry[] = [];
    for (const extension of enabledExtensions.value) {
        for (const contribution of extension.manifest.contributes?.capabilities ?? []) {
            const key = `${contribution.kind}:${contribution.id}`;
            if (!seen.has(key)) {
                seen.add(key);
                derived.push(contributionCard(contribution));
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

// --- the connection's background process (a gateway's liveness, where the user forms the intent) ---
// A connector that relays events (Discord, IMAP) only works while its extension's gateway runs, and "my bot
// went quiet" sends people to the connector — not to a process list behind the terminal panel. So the same
// rows the panel's popover shows render here too, scoped to the extension serving THIS card.
const { rows: processRows, busy: processBusy, start: startProcess, stop: stopProcess } = useBackgroundProcesses();

// The extension that runs an instance's processes: an extension-kind capability IS the extension; a connector
// instance is served by whichever extension declares its provider (resolved per INSTANCE, not per card — the
// SQL card owns two providers, and they need not come from the same extension).
const ownerExtensionId = (instance: CapabilitySummary): string | undefined =>
    instance.kind === `extension`
        ? instance.id
        : enabledExtensions.value.find((extension) =>
              (extension.manifest.contributes?.capabilities ?? []).some(
                  (contribution) =>
                      contribution.kind === instance.kind &&
                      contribution.id === String(instance.config[contributionDiscriminator(instance.kind) ?? ``]),
              ),
          )?.id;

// Empty until something is actually connected: a declared-but-idle gateway on a card you never configured is
// noise, not health. Several instances of one provider share a single gateway, hence the owner set.
const cardProcesses = computed<BackgroundProcessRow[]>(() => {
    const owners = new Set(selectedInstances.value.map(ownerExtensionId).filter((id) => id !== undefined));
    return processRows.value.filter((row) => row.extensionId !== undefined && owners.has(row.extensionId));
});

// A free instance name: the provider id if unused, else the first `<id>-2`, `-3`, … so repeat adds create
// distinct connections instead of upserting the same id (the silent-overwrite trap).
const suggestName = (entry: CapabilityCatalogEntry): string => {
    const taken = new Set(instancesOf(entry).map((instance) => instance.id));
    // A one-per-sandbox card never bumps: the id IS the instance, so re-picking the card lands on the entry
    // that exists and the submit reads "Update" instead of quietly minting a second one.
    if (entry.singleton === true || !taken.has(entry.id)) {
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

/* --- what the rail slices the catalog by, and what the grid then shows ---
 * Every card with the two facts both panes read off it. Computed once here rather than per tile per render: the
 * grid used to call instancesOf() three times per card while drawing it, which is a scan of every capability in
 * the sandbox per call. */
const cards = computed(() =>
    allCards.value.map((entry) => ({ entry, connected: instancesOf(entry).length, recommendation: recommendationFor(entry.kind) })),
);
const connectedCards = computed(() => cards.value.filter((card) => card.connected > 0));
const recommendedCards = computed(() => cards.value.filter((card) => card.recommendation !== undefined));

// The two slices that cut across every category. Constants because both the URL and the branches below name them.
const CONNECTED = `connected`;
const RECOMMENDED = `recommended`;

/* A category's glyph. It is not in CAPABILITY_CATEGORIES because a category is a fact about the catalog and this
 * is a fact about this rail — the same list is rendered as plain headings elsewhere. A contribution declaring an
 * unknown category lands under `extend` (contributionCard), so the record stays total. */
const CATEGORY_ICONS: Readonly<Record<CapabilityCategory, IconName>> = {
    platform: `sitemap`,
    code: `code`,
    observability: `wave-pulse`,
    data: `database`,
    communication: `comments`,
    business: `credit-card`,
    machines: `desktop`,
    servers: `server`,
    deploy: `cloud-upload`,
    extend: `th-large`,
};

const scopeOf = (key: string, label: string, icon: IconName, subset: readonly { connected: number }[]): CapabilityScope => ({
    key,
    label,
    icon,
    total: subset.length,
    connected: subset.filter((card) => card.connected > 0).length,
});

const allScope = computed<CapabilityScope>(() => scopeOf(``, `All capabilities`, `bolt`, cards.value));
// Each cross-cutting row exists only while it has something in it: "Connected 0" on a fresh sandbox promises a
// page that turns out to be empty, and "Recommended 0" reads as the workspace scan having failed.
const pinnedScopes = computed<CapabilityScope[]>(() => [
    allScope.value,
    ...(connectedCards.value.length === 0 ? [] : [scopeOf(CONNECTED, `Connected`, `check-circle`, connectedCards.value)]),
    ...(recommendedCards.value.length === 0 ? [] : [scopeOf(RECOMMENDED, `Recommended`, `sparkles`, recommendedCards.value)]),
]);
// A category with no cards is not a row: several of them are empty until the extension that fills them is enabled.
const categoryScopes = computed<CapabilityScope[]>(() =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const subset = cards.value.filter((card) => card.entry.category === category.id);
        return subset.length === 0 ? [] : [scopeOf(category.id, category.label, CATEGORY_ICONS[category.id], subset)];
    }),
);

/* THE SLICE AND THE SEARCH LIVE IN THE URL, replaced rather than pushed — Back should undo opening a card, not
 * each letter of a filter. Derived from the query rather than mirrored into refs, so there is one direction of
 * flow and no watcher pair to fight over what is shown. Writing either drops the `card` param: picking a category
 * while a form is open means "show me that category", not "keep me here". */
const scope = computed<string>({
    get: () => (typeof route.query[`category`] === `string` ? route.query[`category`] : ``),
    set: (value) => void router.replace({ name: `capabilities`, query: { ...route.query, category: value === `` ? undefined : value } }),
});
const search = computed<string>({
    get: () => (typeof route.query[`q`] === `string` ? route.query[`q`] : ``),
    set: (value) => void router.replace({ name: `capabilities`, query: { ...route.query, q: value === `` ? undefined : value } }),
});

// An unknown slice — a stale link, or Connected after the last capability was removed — falls back to everything
// rather than to a blank grid, which the rail offers no row to get back from.
const activeScope = computed<CapabilityScope>(
    () => [...pinnedScopes.value, ...categoryScopes.value].find((entry) => entry.key === scope.value) ?? allScope.value,
);
const railScope = computed<string>({ get: () => activeScope.value.key, set: (value) => (scope.value = value) });
const inCategory = computed(() => categoryScopes.value.some((entry) => entry.key === activeScope.value.key));

const inScope = computed(() => {
    if (activeScope.value.key === ``) {
        return cards.value;
    }
    if (activeScope.value.key === CONNECTED) {
        return connectedCards.value;
    }
    if (activeScope.value.key === RECOMMENDED) {
        return recommendedCards.value;
    }
    return cards.value.filter((card) => card.entry.category === activeScope.value.key);
});

// The kind is searched alongside the words a reader can see, because it is what somebody typing "mcp" or "ssh"
// means — those are the names of the things, and no card's prose repeats them.
const visibleCards = computed(() => {
    const needle = search.value.trim().toLowerCase();
    if (needle === ``) {
        return inScope.value;
    }
    return inScope.value.filter((card) => `${card.entry.name} ${card.entry.description} ${card.entry.kind}`.toLowerCase().includes(needle));
});

// The visible cards grouped into their display sections, in category order; empty sections are dropped. Derived
// connector cards render before the static ones within a section (allCards order).
const groupedCatalog = computed(() =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const entries = visibleCards.value.filter((card) => card.entry.category === category.id);
        return entries.length === 0 ? [] : [{ label: category.label, hint: category.hint, entries }];
    }),
);

// The page's own sentence follows the slice: under one category it is that category's hint, which is where the
// heading the grid no longer repeats has gone.
const description = computed(() => {
    if (activeScope.value.key === CONNECTED) {
        return `What your agent can already reach. Open one to add another connection of the same kind, or to take it away.`;
    }
    if (activeScope.value.key === RECOMMENDED) {
        return `Suggested from what is checked out in your workspace — each one is something your own code already asks for.`;
    }
    return (
        CAPABILITY_CATEGORIES.find((category) => category.id === activeScope.value.key)?.hint ??
        `Grow your sandbox — each capability gives your agent new tools or connects your accounts. Everything is stored only in your sandbox.`
    );
});

watch(capabilities, () => {
    if (selected.value !== undefined && !nameEdited.value) {
        name.value = suggestName(selected.value);
    }
});
const values = reactive<Record<string, string>>({});
const submitting = ref(false);
const error = ref<string | null>(null);
// undefined = the confirm dialog is closed; a string = the capability id awaiting a confirmed removal.
const confirmRemoveId = ref<string>();
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
// The glyph tier <BrandMark> falls to when a card has no simple-icons logo (or the slug fails to load): the
// card's explicit `icon`, else the generic per-kind fallback. A card is never left to the initials tier — its
// KIND is always known, and "some connector" drawn as a bolt beats it drawn as two letters.
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
// The contribution behind a config, via its kind's pinned discriminator — what capabilityEffects reads a card's
// secret/image declarations from. Undefined for a kind whose cards carry none (agent) or a core-only kind.
const contributionFor = (kind: CapabilityKind, config: Record<string, string | number | boolean | undefined>) => {
    const key = contributionDiscriminator(kind);
    return key === undefined ? undefined : contributionOf(kind, String(config[key] ?? ``));
};
// Live over the form state, so the plugin clone URL tracks as the user types. A selected contributed card
// exists only because its extension is enabled (allCards derives it), so contributionOf always resolves here —
// the effects panel is complete by construction.
const liveEffects = computed<readonly CapabilityEffect[]>(() => {
    const entry = selected.value;
    if (entry === undefined) {
        return [];
    }
    const config = effectConfig(entry, (field) => (values[field.key] ?? ``).trim());
    return capabilityEffects({ kind: entry.kind, id: name.value.trim() || undefined, config, contribution: contributionFor(entry.kind, config) });
});
// The consequential effects a card statically implies, badged on its grid tile — image/runtime/trusted-code
// only (the full list is one click away). Defaults decide config-dependent ones (the SQL card's default engine).
const badgeEffects = (entry: CapabilityCatalogEntry): readonly CapabilityEffect[] => {
    const config = effectConfig(entry, (field) => field.default);
    return capabilityEffects({ kind: entry.kind, config, contribution: contributionFor(entry.kind, config) }).filter(
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
        contribution: contributionFor(instance.kind, instance.config),
        manifest: instance.kind === `extension` ? extensions.value.find((extension) => extension.id === instance.id)?.manifest : undefined,
    });

/* Connecting a computer of the user's own (host-kind): the machine can't be reached from here, so the flow is a
 * one-time command they run over there. This page owns the dialog's identity (which machine, which grant); the
 * live roster + revoke live in the composable, shared with the dialog. */
const { hostFor, revoke: revokeHost, refresh: refreshHosts, start: startHosts, stop: stopHosts } = useHostConnect();
const connectVisible = ref(false);
const connectId = ref(``);
const connectPlatform = ref(``);
const connectPermissions = ref(``);
// The grant in the machine's own words, read from the same effects the card renders — so the dialog's sentence
// and the card's row can never claim different permissions.
const hostGrants = (instance: CapabilitySummary): string => {
    const machine = instanceEffects(instance).find((effect) => effect.kind === `machine`);
    return machine === undefined ? `read files` : machine.grants.join(`, `);
};
const openConnect = (instance: CapabilitySummary): void => {
    connectId.value = instance.id;
    connectPlatform.value = String(instance.config[`platform`] ?? `linux`);
    connectPermissions.value = hostGrants(instance);
    connectVisible.value = true;
};
// A machine coming online flips the capability pending → active; refresh so the card follows it.
const onHostConnected = (): void => {
    void refreshHosts();
    void refetch();
};
const removeHostAccess = async (id: string): Promise<void> => {
    await revokeHost(id);
    void refetch();
};
// One read of the roster while this page is open, so a connected computer's row can say "online" without
// waiting for a dialog to be opened. The steady polling only runs while a pairing is live (see the composable).
onMounted(startHosts);
onBeforeUnmount(stopHosts);

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

/* Registry browse (the plugin and extension cards): resolve a registry repo into entries; picking one
 * pre-fills the form below, and install stays the ordinary capability apply. The extension card defaults the
 * field to the official registry and the plugin card starts blank — a plugin marketplace is usually somebody
 * else's, an extension registry is usually ours — but the field is editable in both, which is the whole of
 * "registries are plural": point it at an internal repo and this never touches intentic.dev. */
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
        error.value = errorMessage(err, `Could not browse the registry.`);
    } finally {
        browsing.value = false;
    }
};

// Only the rows this card can actually install: a registry serves plugins and extensions from one file, and
// offering an extension row on the plugin form would pre-fill a config the daemon then refuses.
const marketEntries = computed<RegistryEntry[]>(() =>
    selected.value === undefined ? [] : (market.value?.plugins.filter((entry) => entry.kind === selected.value?.kind) ?? []),
);

/* Why a row can't be clicked, in the words the reader needs — the button is disabled either way, and a
 * disabled row with no reason reads as a broken page. Blocked leads: it is the one case where the entry is
 * fine mechanically and the answer is still no. The sha rule bites only extensions (their code runs trusted
 * in this browser), so a plugin row pinned to a branch stays installable. */
const blockedReason = (entry: RegistryEntry): string | undefined => {
    if (entry.trust === `blocked`) {
        return entry.trustReason ?? `blocked`;
    }
    if (entry.install === undefined) {
        return `not installable from here`;
    }
    if (entry.kind === `extension` && !isShaPinned(entry.install)) {
        return `no pinned commit`;
    }
    return undefined;
};

// A connected VPN instance's live facts, compactly: the assigned address and what it routes. Undefined while
// the tunnel is down — the capability row's own status already says that.
const vpnFacts = (id: string): string | undefined => {
    const link = vpnLinks.value.find((candidate) => candidate.id === id);
    if (link === undefined || link.state !== `connected`) {
        return undefined;
    }
    return [link.address, link.routes.includes(`0.0.0.0/0`) ? `all traffic` : link.routes.join(`, `)]
        .filter((fact) => fact !== undefined && fact !== ``)
        .join(` · `);
};

// --- FortiClient import (vpn card only) ---
// A user with an exported FortiClient config drops the file in and picks a connection instead of re-keying its
// host, port and protocol per tunnel. The file is read HERE and only its text is posted: the daemon cannot
// reach the user's Downloads folder, and asking someone to open an XML export and copy it out by hand was the
// step that made this feature not worth using. Nothing is stored until the ordinary add below runs.
const forticlientConnections = ref<ForticlientConnection[]>([]);
// The file the list came from — named back at the user, so a picker full of unfamiliar connections is
// attributable to what they dropped. Empty until one has been read successfully.
const forticlientFile = ref(``);
const importing = ref(false);
const chooseForticlient = ref<HTMLInputElement>();
// A FortiClient backup is tens of KB of XML. Far past that, the drop was a slip — reading the file into this
// tab and posting it is the wrong answer to one.
const FORTICLIENT_MAX_BYTES = 4_000_000;

const readForticlientFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined || importing.value) {
        return;
    }
    error.value = null;
    forticlientFile.value = ``;
    forticlientConnections.value = [];
    if (file.size > FORTICLIENT_MAX_BYTES) {
        error.value = `${file.name} is far too big to be a FortiClient configuration — that looks like the wrong file.`;
        return;
    }
    importing.value = true;
    try {
        const xml = await file.text();
        // An empty file is "nothing to import", which the line under the zone already says — posting it would
        // trade that sentence for the route's validation error, which answers a question nobody asked.
        forticlientConnections.value = xml.trim().length === 0 ? [] : await importForticlient(xml);
        forticlientFile.value = file.name;
    } catch (err) {
        error.value = errorMessage(err, `Could not read that FortiClient configuration.`);
    } finally {
        importing.value = false;
    }
};

// Only an OS-file drag offers anything here; a link or an image dragged around inside the app must not light
// the zone up as though it could be imported.
const dragOffersFile = (event: DragEvent): boolean => event.dataTransfer?.types.includes(`Files`) ?? false;
// Depth, not a boolean: crossing onto the zone's own children fires dragleave on the zone, and a boolean would
// flicker the highlight off while the pointer is still inside it.
let forticlientDragDepth = 0;
const forticlientDragging = ref(false);
const onForticlientDragEnter = (event: DragEvent): void => {
    if (!dragOffersFile(event)) {
        return;
    }
    forticlientDragDepth += 1;
    forticlientDragging.value = true;
};
const onForticlientDragLeave = (): void => {
    forticlientDragDepth -= 1;
    if (forticlientDragDepth <= 0) {
        forticlientDragDepth = 0;
        forticlientDragging.value = false;
    }
};
const onForticlientDrop = (event: DragEvent): void => {
    forticlientDragDepth = 0;
    forticlientDragging.value = false;
    void readForticlientFile(event.dataTransfer?.files[0]);
};
const onForticlientPick = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    void readForticlientFile(input.files?.[0]);
    // Clear the field (the File is already captured): re-picking the SAME file after re-exporting it fires no
    // `change` otherwise, and the zone would look dead.
    input.value = ``;
};

// A file that misses the zone would otherwise navigate this tab to the file itself, taking a half-filled form
// with it. Swallow file drags page-wide — the zone's own handler runs first and still gets its file.
const swallowFileDrag = (event: DragEvent): void => {
    if (dragOffersFile(event)) {
        event.preventDefault();
    }
};
onMounted(() => {
    window.addEventListener(`dragover`, swallowFileDrag);
    window.addEventListener(`drop`, swallowFileDrag);
});
onBeforeUnmount(() => {
    window.removeEventListener(`dragover`, swallowFileDrag);
    window.removeEventListener(`drop`, swallowFileDrag);
});

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

const pickEntry = (entry: RegistryEntry): void => {
    if (entry.install === undefined || blockedReason(entry) !== undefined) {
        return;
    }
    name.value = entry.name.replace(/[^a-zA-Z0-9_-]/g, `-`);
    nameEdited.value = true;
    values[`url`] = entry.install.url;
    values[`ref`] = entry.install.ref ?? ``;
    values[`path`] = entry.install.path ?? ``;
    // Code hosted inside a private registry repo needs the same token to clone.
    values[`token`] = entry.install.url === marketUrl.value.trim() ? marketToken.value.trim() : ``;
};

const clearForm = (): void => {
    name.value = ``;
    nameEdited.value = false;
    for (const key of Object.keys(values)) {
        delete values[key];
    }
    error.value = null;
    marketUrl.value = ``;
    marketToken.value = ``;
    market.value = null;
    forticlientFile.value = ``;
    forticlientConnections.value = [];
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
        // The extension card opens on the official registry so browsing is one click, not a URL to go and find.
        if (entry.kind === `extension`) {
            marketUrl.value = OFFICIAL_REGISTRY_URL;
        }
        // Pre-fill a free name: the provider id for the first connection, `<id>-2` etc. for the next — so re-adding
        // creates another connection by default instead of overwriting the first.
        name.value = suggestName(entry);
        // Seed every editable field (ignoring `when`) so toggling a mode reveals an already-initialized field.
        // A switch seeds to "off" rather than empty: it always shows one of its two positions, so an unseeded
        // one would both render as off and count as an unfilled required field, blocking a submit over a
        // control the user can see is answered.
        for (const field of entry.fields) {
            if (field.value === undefined) {
                values[field.key] = field.default ?? (field.boolean === true ? `off` : ``);
            }
        }
        // A one-per-sandbox card opens as an EDIT of the live entry: its echoed config wins over the defaults,
        // so a switch shows where the user left it rather than resetting to off every time the card is opened —
        // which, on a form whose submit updates in place, would turn "come and look" into "turn it back off".
        // Booleans arrive from the echo as booleans and from the form as "on"/"off"; the form speaks strings.
        const live = entry.singleton === true ? instancesOf(entry)[0] : undefined;
        for (const [key, value] of Object.entries(live?.config ?? {})) {
            values[key] = typeof value === `boolean` ? (value ? `on` : `off`) : String(value);
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
            void router.replace({ name: `capabilities`, query: route.query });
        }
    },
    { immediate: true },
);

// Picking a card / going back is a navigation now — the URL is the source of truth for what's shown. The query
// rides along both ways, so going back lands on the slice the card was picked out of rather than on the whole
// catalog with the filter thrown away.
const pick = (entry: CapabilityCatalogEntry): void => {
    void router.push({ name: `capabilities`, params: { card: entry.id }, query: route.query });
};

const back = (): void => {
    void router.push({ name: `capabilities`, query: route.query });
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
    const input = buildInput(entry);
    try {
        await add(input, (line) => {
            // The install runs in a real tmux session — open ITS terminal tab, so what the user watches is the
            // commands themselves (user-clicked action → openFocused, the apply/vitest/add-apps precedent).
            // That IS the progress surface: a summary box beside it could only ever be a worse retelling of
            // the pane, and it went away with the flow anyway the moment this form navigated back.
            if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                useTerminalPanel().openFocused(line[`session`]);
            }
        });
        // Dev autofill persist (inert in prod): remember the secret fields that just worked, per card.
        for (const field of entry.fields) {
            if (field.secret === true && field.value === undefined) {
                devFillSet(`capability.${entry.id}.${field.key}`, (values[field.key] ?? ``).trim());
            }
        }
        // ADDING A COMPUTER IS HALF THE STEP. The other half runs on the machine itself, and this card is the
        // only place its one-time command exists — so the add hands straight over to that command instead of
        // returning to the catalog, where the reader is left in front of a grid with a capability that has
        // quietly gone `pending` and nothing saying what to do about it. Every other kind is finished when the
        // apply is, and goes back as before.
        const added = capabilities.value.find((capability) => capability.id === input.id);
        if (entry.kind === `host` && added !== undefined) {
            openConnect(added);
            return;
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
    <SplitView title="Capabilities" :description="description">
        <template #strips>
            <div v-if="topError" :class="cmp.alertDanger()">{{ topError }}</div>
        </template>

        <!-- The rail NARROWS the grid rather than selecting a document, so on a phone <SplitView> folds it ABOVE
             the grid instead of covering it (mobile="collapse", the default). <CapabilityRail> already swaps
             itself to a Picker at that width, so it needs no separate #compact form. -->
        <template #rail>
            <CapabilityRail v-model="railScope" :pinned="pinnedScopes" :categories="categoryScopes" />
        </template>

        <template #detail>
            <!-- STEP 2: configure + apply the picked capability. The form keeps its reading width and the card's
                 credential guide docks beside it, /setup-style — see the aside at the foot of this block. A
                 @container rather than a viewport breakpoint: this pane shares the page with the index column and
                 the shell with a chat panel the user drags, so how much room there is for a second column is a
                 fact about the pane, not about the screen. Below that width the row collapses and the guide moves
                 inline into the form. -->
            <div v-if="selected" class="scrollbar-thin scrollbar-stable @container min-h-0 flex-1 overflow-y-auto pr-2">
                <div class="mx-auto flex max-w-xl flex-col @3xl:max-w-none @3xl:flex-row @3xl:items-start @3xl:justify-center @3xl:gap-6">
                    <div class="flex min-w-0 flex-1 flex-col @3xl:max-w-xl">
                        <!-- Back to the slice the card was picked out of, named — "All capabilities" was a lie the
                             moment the rail could be pointing at one category. -->
                        <button type="button" class="mb-4 inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-content" @click="back">
                            <Icon name="arrow-left" class="text-2xs" /> {{ activeScope.label }}
                        </button>

                        <div class="mb-4 flex items-center gap-3">
                            <BrandMark :size="32" :name="selected.name" :logo="selected.logo" :icon="entryIcon(selected)" />
                            <div class="min-w-0">
                                <div class="font-medium text-content">{{ selected.name }}</div>
                                <div class="text-xs text-muted">{{ selected.description }}</div>
                            </div>
                        </div>

                        <!-- Precondition gate: a service/integration needs DevOps first. -->
                        <div v-if="!requiresMet" :class="cmp.alertInfo()">
                            This needs <b>DevOps</b> active first. Go back and activate the DevOps capability, then add this.
                        </div>

                        <form v-else class="flex flex-col gap-3" @submit.prevent="submit">
                            <!-- The connections already added for this card — each instance removable here (the only place a
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
                                        <!-- A connected computer's liveness is the fact its row exists to carry: "added" and
                                         "asleep" and "working" are three different situations for the person reading it. -->
                                        <span
                                            v-if="selected.kind === 'host'"
                                            class="text-2xs"
                                            :class="hostFor(instance.id)?.online ? 'text-success' : 'text-subtle'"
                                        >
                                            {{ hostFor(instance.id)?.online ? "online" : "offline" }}
                                        </span>
                                        <span v-if="selected.kind === 'host' && hostFor(instance.id)?.facts" class="font-mono text-2xs text-subtle">{{
                                            hostFor(instance.id)?.facts?.os
                                        }}</span>
                                        <div class="ml-auto flex items-center gap-1">
                                            <!-- A computer is connected by running a command ON IT — this button hands over that
                                             command (and is also how a machine is re-connected after being revoked). -->
                                            <Button
                                                v-if="selected.kind === 'host'"
                                                :label="
                                                    hostFor(instance.id) === undefined || !hostFor(instance.id)?.lastSeen ? 'Connect' : 'Reconnect'
                                                "
                                                size="small"
                                                :text="true"
                                                @click="openConnect(instance)"
                                            >
                                                <template #icon><Icon name="desktop" /></template>
                                            </Button>
                                            <!-- Revoke cuts this machine off without removing the capability, so the card keeps
                                             its name and permissions and Connect re-pairs it. Removing the capability does
                                             both, which is a different intent. -->
                                            <Button
                                                v-if="selected.kind === 'host' && hostFor(instance.id)?.lastSeen"
                                                label="Revoke"
                                                size="small"
                                                :text="true"
                                                severity="warn"
                                                @click="removeHostAccess(instance.id)"
                                            >
                                                <template #icon><Icon name="sign-out" /></template>
                                            </Button>
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
                                    <!-- A computer that was added but never connected is pending on the ONE-LINER, not on a
                                     rebuild — send the hint to the same dialog as the button rather than to /sandbox. -->
                                    <button
                                        v-else-if="instance.status.state === 'pending' && selected.kind === 'host'"
                                        type="button"
                                        class="inline-flex w-fit items-center gap-1 text-2xs text-warning hover:underline"
                                        @click="openConnect(instance)"
                                    >
                                        <Icon name="exclamation-triangle" />
                                        {{ instance.status.detail ?? "Not connected" }} — Connect →
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

                            <!-- The gateway serving those connections. It answers the question the connector page is
                             actually visited with once something is set up — "is this still working?" — so it lives
                             here rather than only in the terminal panel's popover. Same rows, same actions. -->
                            <RowGroup
                                v-if="cardProcesses.length > 0"
                                label="Background process"
                                caption="Relays events to your agent — restart it if this connection stops responding."
                            >
                                <div v-for="row in cardProcesses" :key="row.id" class="flex items-center gap-2 px-4 py-3 text-xs">
                                    <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="row.running ? 'bg-success' : 'bg-content/25'"></span>
                                    <span class="font-medium text-content">{{ row.name }}</span>
                                    <span class="text-2xs" :class="row.running ? 'text-muted' : 'text-warning'">{{
                                        row.running ? "running" : "stopped"
                                    }}</span>
                                    <div class="ml-auto flex items-center gap-1">
                                        <Button v-if="row.session" label="Logs" size="small" :text="true" @click="viewProcessLogs(row)">
                                            <template #icon><Icon name="align-left" /></template>
                                        </Button>
                                        <Button
                                            :label="row.running ? 'Restart' : 'Start'"
                                            size="small"
                                            :text="true"
                                            :disabled="processBusy === row.id"
                                            @click="void startProcess(row)"
                                        >
                                            <template #icon><Icon :name="row.running ? 'refresh' : 'play'" /></template>
                                        </Button>
                                        <Button
                                            v-if="row.running"
                                            label="Stop"
                                            size="small"
                                            severity="danger"
                                            :text="true"
                                            :disabled="processBusy === row.id"
                                            @click="void stopProcess(row)"
                                        >
                                            <template #icon><Icon name="stop" /></template>
                                        </Button>
                                    </div>
                                </div>
                            </RowGroup>

                            <!-- FortiClient import (vpn only): drop an exported config and pick a connection to pre-fill
                             the form. FortiClient encrypts stored credentials with a machine-bound key, so the secret
                             is never importable — each connection says which fields are still waiting. -->
                            <RowGroup v-if="selected.kind === 'vpn'" label="Import from FortiClient (optional)">
                                <div class="flex flex-col gap-2 px-4 py-3">
                                    <p class="text-2xs text-muted">
                                        Drop an exported FortiClient configuration (File ▸ Settings ▸ Backup) here to fill the form from one of its
                                        connections. Passwords in that file are encrypted by FortiClient and can't be read — you'll still type those.
                                    </p>
                                    <!-- The zone IS the button, so the drag and the click share one target and there is no
                                     small "browse" link beside it to aim at. -->
                                    <button
                                        type="button"
                                        :class="
                                            cmp.emptyState(
                                                `flex cursor-pointer flex-col items-center gap-1 py-6 transition-colors`,
                                                forticlientDragging ? `border-primary-500 bg-primary-500/5` : `hover:border-line-strong`,
                                            )
                                        "
                                        :disabled="importing"
                                        @click="chooseForticlient?.click()"
                                        @dragenter.prevent="onForticlientDragEnter"
                                        @dragover.prevent
                                        @dragleave="onForticlientDragLeave"
                                        @drop.prevent="onForticlientDrop"
                                    >
                                        <Icon v-if="importing" name="spinner" spin class="text-lg text-info" />
                                        <Icon v-else name="upload" :class="['text-lg', forticlientDragging ? 'text-primary-500' : 'text-muted']" />
                                        <span class="text-xs text-content">
                                            <template v-if="importing">Reading…</template>
                                            <template v-else-if="forticlientDragging">Drop it to read its connections</template>
                                            <template v-else>Drop the configuration file here</template>
                                        </span>
                                        <!-- Hidden, never unmounted: dropping the line would shorten the zone under the
                                         pointer mid-drag, and a cursor near its bottom edge would then leave and
                                         re-enter it in a loop. -->
                                        <span :class="['text-2xs text-subtle', importing || forticlientDragging ? 'invisible' : '']"
                                            >or click to choose one</span
                                        >
                                    </button>
                                    <input
                                        ref="chooseForticlient"
                                        type="file"
                                        accept=".conf,.xml,text/xml,application/xml"
                                        class="hidden"
                                        @change="onForticlientPick"
                                    />
                                    <p v-if="forticlientFile !== '' && forticlientConnections.length === 0" class="text-2xs text-warning">
                                        No VPN connections found in {{ forticlientFile }}.
                                    </p>
                                    <template v-if="forticlientConnections.length > 0">
                                        <p class="text-2xs text-subtle">From {{ forticlientFile }} — pick the connection to fill the form with.</p>
                                        <div class="scrollbar-thin flex max-h-48 flex-col gap-0.5 overflow-auto">
                                            <button
                                                v-for="connection in forticlientConnections"
                                                :key="`${connection.provider}-${connection.id}`"
                                                type="button"
                                                class="flex flex-col gap-0.5 rounded-md bg-canvas px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-overlay"
                                                @click="pickForticlient(connection)"
                                            >
                                                <span class="flex items-baseline gap-2">
                                                    <span class="font-medium text-content">{{ connection.label }}</span>
                                                    <span class="text-2xs text-subtle">{{
                                                        connection.provider === "fortinet" ? "SSL-VPN" : "IPsec"
                                                    }}</span>
                                                    <span class="min-w-0 truncate font-mono text-2xs text-muted">
                                                        {{ connection.server }}:{{ connection.port }}
                                                    </span>
                                                </span>
                                                <span class="text-2xs text-subtle">You'll need to enter: {{ connection.needs.join(", ") }}</span>
                                            </button>
                                        </div>
                                    </template>
                                </div>
                            </RowGroup>

                            <!-- Registry browse (plugin + extension): resolve a registry repo and pre-fill the form below. -->
                            <RowGroup v-if="selected.kind === 'plugin' || selected.kind === 'extension'" label="From a registry (optional)">
                                <div class="flex flex-col gap-2 px-4 py-3">
                                    <div class="flex gap-2">
                                        <input
                                            v-model="marketUrl"
                                            placeholder="https://github.com/owner/registry"
                                            :class="cmp.input('min-w-0 flex-1')"
                                        />
                                        <input
                                            v-model="marketToken"
                                            type="password"
                                            autocomplete="off"
                                            placeholder="Token"
                                            :class="cmp.input('w-28')"
                                        />
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
                                            v-for="entry in marketEntries"
                                            :key="entry.name"
                                            type="button"
                                            class="flex items-center gap-2 rounded-md bg-canvas px-2.5 py-1.5 text-left text-xs transition-colors enabled:hover:bg-overlay disabled:opacity-50"
                                            :disabled="blockedReason(entry) !== undefined"
                                            @click="pickEntry(entry)"
                                        >
                                            <!-- The mark the registry carries, which for most rows is the extension's own
                                             initials: these are names nobody has seen before, and a column of marks is
                                             the only thing here that can be scanned without reading. -->
                                            <BrandMark :size="20" :name="entry.name" :logo="entry.logo" :icon="entry.icon" />
                                            <!-- Verified is the only badge: it is the one state a human asserted, and badging
                                             "listed" too would dress the honest default up as a review. -->
                                            <Icon v-if="entry.trust === 'verified'" name="shield" class="shrink-0 text-success" title="Verified" />
                                            <span class="font-medium text-content">{{ entry.name }}</span>
                                            <span v-if="entry.version" class="text-2xs text-subtle">{{ entry.version }}</span>
                                            <span
                                                v-if="entry.stars !== undefined"
                                                class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle"
                                            >
                                                <Icon name="star" />{{ entry.stars }}
                                            </span>
                                            <span class="min-w-0 truncate text-2xs text-muted">{{ entry.description }}</span>
                                            <span
                                                v-if="blockedReason(entry)"
                                                :class="['ml-auto shrink-0 text-2xs', entry.trust === 'blocked' ? 'text-danger' : 'text-subtle']"
                                            >
                                                {{ blockedReason(entry) }}
                                            </span>
                                        </button>
                                    </div>
                                    <p v-if="market && marketEntries.length === 0" class="text-2xs text-subtle">
                                        That registry lists no {{ selected.kind === "extension" ? "extensions" : "plugins" }}.
                                    </p>
                                </div>
                            </RowGroup>

                            <!-- One per sandbox → nothing to name, and a name box would be the field that invites a second
                             one. The id stays the card's (suggestName), so the submit updates what's there. -->
                            <label v-if="!selected.singleton" class="ui-field">
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
                            <!-- The narrow half of the credential guide, above the fields it explains. From @3xl it
                             is docked in a column of its own (see the aside below) and this one is hidden. -->
                            <CredentialGuide v-if="selected.guide" :entry="selected" :values="values" class="@3xl:hidden" />
                            <template v-for="field in visibleFields(selected)" :key="field.key">
                                <!-- An opt-in extra: the switch sits BESIDE its label, not under it. Stacked in the column
                                 of inputs it would read as one more thing to fill in; beside the label it reads as the
                                 thing it is — already answered, changeable. Its hint carries what the label can't say
                                 (a host requirement, when the value takes effect), which is exactly the caveat a lone
                                 switch invites people to skip. -->
                                <label v-if="field.boolean" class="flex items-start justify-between gap-4">
                                    <span class="min-w-0">
                                        <span class="ui-field-label">{{ field.label }}</span>
                                        <StatusBadge
                                            v-if="field.rebuild"
                                            variant="neutral"
                                            size="xs"
                                            label="needs rebuild"
                                            class="ml-1.5 align-middle"
                                        />
                                        <span v-if="field.hint" class="mt-0.5 block text-2xs text-muted">{{ field.hint }}</span>
                                    </span>
                                    <ToggleSwitch
                                        class="ui-switch-sm mt-0.5 shrink-0"
                                        :model-value="values[field.key] === 'on'"
                                        :aria-label="field.label"
                                        @update:model-value="(value: boolean) => (values[field.key] = value ? 'on' : 'off')"
                                    />
                                </label>
                                <label v-else class="ui-field">
                                    <span class="ui-field-label">
                                        {{ field.label }}{{ field.optional ? " (optional)" : "" }}
                                        <StatusBadge
                                            v-if="field.rebuild"
                                            variant="neutral"
                                            size="xs"
                                            label="needs rebuild"
                                            class="ml-1.5 align-middle"
                                        />
                                    </span>
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
                                        :class="[
                                            cmp.input('font-mono resize-y'),
                                            touched.has(field.key) && fieldError(field) ? 'ui-field-input-error' : '',
                                        ]"
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
                                    <span v-else-if="field.hint" class="text-2xs text-muted">{{ field.hint }}</span>
                                </label>
                            </template>
                            <CapabilityEffects :effects="liveEffects" />
                            <!-- Why the grid badged this one — named here too, so the rebuild the hint asks for has a reason attached. -->
                            <div v-if="recommendationFor(selected.kind)" :class="cmp.alertInfo()">
                                Recommended: your workspace has <b>{{ recommendationFor(selected.kind)?.evidence }}</b
                                >, which needs this capability to run.
                            </div>
                            <p v-if="selected.hint" class="text-xs text-muted">{{ selected.hint }}</p>

                            <div :class="['flex justify-end', shaking ? 'ui-shake' : '']" @animationend="shaking = false">
                                <Button type="submit" :label="submitLabel" :loading="submitting">
                                    <template #icon><Icon name="check" /></template>
                                </Button>
                            </div>
                        </form>
                    </div>

                    <!-- The docked half of the card's credential guide. `hidden` below @3xl, where the same
                         component renders inline inside the form instead — exactly one of the two is ever on
                         screen. `items-start` on the row is what leaves it room to stick while the form scrolls
                         past it, and the v-if keeps a card with no guide from reserving an empty column. -->
                    <aside v-if="selected.guide" class="hidden @3xl:sticky @3xl:top-0 @3xl:block @3xl:w-72 @3xl:shrink-0">
                        <CredentialGuide :entry="selected" :values="values" />
                    </aside>
                </div>
            </div>

            <!-- STEP 1: the catalog. -->
            <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
                <!-- The bar sits on the grid it narrows, spanning it — one left edge and one right edge down the
                     pane. Picking the slice is the rail's own job and is not repeated here. -->
                <FilterBar v-model="search" placeholder="Filter by name, what it does, kind…" :count="visibleCards.length" />

                <!-- The tiles keep their distance from the scrollbar: `pr-2` is the gap, and the reserved gutter is
                     what stops the whole grid sliding sideways the moment a filter takes the last row away. -->
                <div class="scrollbar-thin scrollbar-stable @container flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pr-2">
                    <!-- HEADINGS ONLY WHERE THE GRID SPANS MORE THAN ONE CATEGORY. Under a single category the
                         rail has already said which one and the page's own description carries its sentence, so a
                         heading repeating both above the only group in view is a line of chrome. -->
                    <div v-for="group in groupedCatalog" :key="group.label" class="flex flex-col gap-3">
                        <div v-if="!inCategory">
                            <div :class="cmp.sectionLabel()">{{ group.label }}</div>
                            <div class="mt-0.5 text-xs text-muted">{{ group.hint }}</div>
                        </div>
                        <!-- Container queries, not viewport ones: the grid is what is left of the page after the
                             index column takes its 16rem, so how many tiles fit is a fact about this pane. -->
                        <div class="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
                            <button
                                v-for="card in group.entries"
                                :key="card.entry.id"
                                type="button"
                                class="flex h-full w-full items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay"
                                @click="pick(card.entry)"
                            >
                                <BrandMark :size="32" :name="card.entry.name" :logo="card.entry.logo" :icon="entryIcon(card.entry)" />
                                <div class="min-w-0">
                                    <!-- WRAPPING, because the tile is a third of a pane rather than a third of the
                                         page now. Without it the badges hold their line and squeeze the name into
                                         two, which puts the one word a scanner is looking for last. -->
                                    <div class="flex flex-wrap items-center gap-x-1.5">
                                        <span class="font-medium text-content">{{ card.entry.name }}</span>
                                        <span
                                            v-if="card.connected > 0"
                                            class="inline-flex items-center gap-1 text-2xs text-success"
                                            :aria-label="`${card.connected} connected`"
                                        >
                                            <Icon name="check-circle" />
                                            {{ card.connected }} connected
                                        </span>
                                        <span
                                            v-if="card.recommendation"
                                            class="inline-flex items-center gap-1 text-2xs text-info"
                                            aria-label="Recommended"
                                        >
                                            <Icon name="sparkles" />
                                            Recommended
                                        </span>
                                        <CapabilityEffects :effects="badgeEffects(card.entry)" :compact="true" />
                                    </div>
                                    <div class="mt-0.5 text-xs text-muted">{{ card.entry.description }}</div>
                                    <div v-if="card.entry.requires?.includes('devops') && !hasCapability('devops')" class="mt-1 text-xs text-muted">
                                        Requires DevOps
                                    </div>
                                    <!-- Derived from what is checked out in /work, so the evidence path is shown rather than asserted. -->
                                    <div v-if="card.recommendation" class="mt-1 text-xs text-info">
                                        Your workspace has {{ card.recommendation.evidence }}
                                    </div>
                                </div>
                            </button>
                        </div>
                    </div>

                    <!-- Only ever reachable through the filter: every slice the rail offers has cards in it. So it
                         answers the one question a reader has here, which is what they typed. -->
                    <div v-if="groupedCatalog.length === 0" :class="cmp.emptyState()">
                        <p class="text-sm">Nothing in {{ activeScope.label }} matches “{{ search.trim() }}”.</p>
                        <p class="mt-1 text-xs text-muted">Capabilities are searched by name, by what they do, and by kind — “mcp”, “ssh”, “sql”.</p>
                    </div>
                </div>
            </div>

            <!-- Removal runs a real teardown in the sandbox (MCP config, SSH host, service provisioning) — confirm first. -->
            <ConfirmDialog
                :open="confirmRemoveId !== undefined"
                header="Remove capability"
                confirm-label="Remove"
                confirm-icon="trash"
                :loading="remove.isPending.value"
                @cancel="confirmRemoveId = undefined"
                @confirm="confirmRemove"
            >
                <p class="text-sm text-content">
                    Remove <b>{{ confirmRemoveId }}</b> from your sandbox? This tears down its configuration and can't be undone.
                </p>
            </ConfirmDialog>

            <!-- Guided browser login for browser-kind capabilities (screencast a live Chromium the user signs into). -->
            <BrowserLoginDialog v-model:visible="loginVisible" :platform="loginPlatform" :label="loginLabel" @done="onLoginDone" />

            <!-- The one-time command that connects a computer of the user's own (host-kind capabilities). -->
            <HostConnectDialog
                v-model:visible="connectVisible"
                :id="connectId"
                :platform="connectPlatform"
                :permissions="connectPermissions"
                @connected="onHostConnected"
            />
        </template>
    </SplitView>
</template>
