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
import {
    BrandMark,
    cmp,
    ConfirmDialog,
    FilterBar,
    type IconName,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    Segmented,
    SplitView,
    StatusBadge,
    type StatusVariant,
} from "@intentic/ui";
import { type CapabilityField, contributionDiscriminator } from "@intentic/extension-manifest";
import { isShaPinned, OFFICIAL_REGISTRY_URL, type RegistryEntry } from "@intentic/registry";
import { type CapabilityKind, type CapabilityState, type ForticlientConnection, isForticlientCiphertext } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import BrowserProfileDialog from "../components/BrowserProfileDialog.vue";
import HostConnectDialog from "../components/HostConnectDialog.vue";
import CapabilityConnections, { type CapabilityConnection, type CapabilityConnectionGroup } from "../components/CapabilityConnections.vue";
import CapabilityContext from "../components/CapabilityContext.vue";
import CapabilityEffects from "../components/CapabilityEffects.vue";
import CapabilityRail, { type CapabilityScope } from "../components/CapabilityRail.vue";
import { startAgent } from "../composables/agents/agentActions";
import { devFillGet, devFillSet } from "../composables/devFill";
import { sandboxJson } from "../composables/sandbox/sandboxClient";
import { auditBrief, updateBrief } from "./sandbox/extensionBrief";
import { noticeFrom, noticeOf } from "../composables/useAsyncAction";
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
 * another category is one click rather than a trip back out through the catalog.
 *
 * ONE SLICE IS NOT A SHORTER CATALOG. Connected asks a different question — not "which of these could I add" but
 * "what have I got" — and a grid of cards answers it wrongly at every step: three SSH boxes collapse into one
 * tile, the names their owner typed are nowhere, and a connection that quietly needs signing in again looks
 * exactly like one that works. So that slice draws <CapabilityConnections> instead: the instances themselves,
 * named, addressed and stated. It is still the same page — same rail, same filter, same click into the same card
 * — it just stops pretending the reader is shopping. */

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const URL_RE = /^https?:\/\/.+/i;

const { hasCapability, recommendationFor, capabilities, error: listError, add, remove, refetch, dismissRecommendation } = useCapabilities();
const { contributionOf, enabled: enabledExtensions, extensions, settled: extensionsSettled } = useExtensions();
// VPN instances get live link state and connect/disconnect here too — the same daemon routes the Sandbox ▸
// Status card drives, so a tunnel dialled from either place reads identically in both.
const { links: vpnLinks } = useVpn();

/* The browser cards' core `identity` field, narrowed to what this sandbox can actually answer: a picker over
 * the identities that exist, or nothing at all when none do. The catalog declares the field without options
 * because the manifest cannot know instance state; a free-text id here would only mint dangling references the
 * daemon then rejects. "Standalone" is the empty value — buildInput drops empty answers, so the config carries
 * no `identity` key rather than an empty one. */
const withIdentityPicker = (entry: CapabilityCatalogEntry): CapabilityCatalogEntry => {
    if (entry.kind !== `browser`) {
        return entry;
    }
    const identities = capabilities.value.filter((instance) => instance.kind === `identity`).map((instance) => instance.id);
    return {
        ...entry,
        fields:
            identities.length === 0
                ? entry.fields.filter((field) => field.key !== `identity`)
                : entry.fields.map((field) =>
                      field.key === `identity`
                          ? { ...field, options: [{ value: ``, label: `Standalone` }, ...identities.map((id) => ({ value: id, label: id }))] }
                          : field,
                  ),
    };
};

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
    return [...derived, ...CAPABILITY_CATALOG].map(withIdentityPicker);
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
 * Every card with the facts all three panes read off it. Computed once here rather than per tile per render: the
 * grid used to call instancesOf() three times per card while drawing it, which is a scan of every capability in
 * the sandbox per call. The INSTANCES ride along rather than just their count, because the Connected slice lists
 * them one by one and re-deriving them there would be that same scan a fourth time. */
const cards = computed(() =>
    allCards.value.map((entry) => {
        const instances = instancesOf(entry);
        return { entry, instances, connected: instances.length, recommendation: recommendationFor(entry.id) };
    }),
);
const connectedCards = computed(() => cards.value.filter((card) => card.connected > 0));
const recommendedCards = computed(() => cards.value.filter((card) => card.recommendation !== undefined));
// Connections, not cards: the Connected row's number is what the list it opens is long, and one card can hold
// several (two Reddit accounts, three SSH boxes). Kept here beside the cards it counts; the rows themselves are
// built further down, where the per-kind facts they carry are in scope.
const connectionCount = computed(() => cards.value.reduce((total, card) => total + card.connected, 0));

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
    ...(connectedCards.value.length === 0
        ? []
        : [
              {
                  key: CONNECTED,
                  label: `Connected`,
                  icon: `check-circle` as IconName,
                  total: connectionCount.value,
                  connected: connectionCount.value,
                  meta: `${connectionCount.value} ${connectionCount.value === 1 ? `connection` : `connections`} across ${connectedCards.value.length} ${connectedCards.value.length === 1 ? `capability` : `capabilities`}`,
              },
          ]),
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

// The cards a slice covers. Connected covers them too — it just draws them as the CONNECTIONS inside them
// rather than as tiles (see `connectionGroups`), so nothing downstream of here renders in that slice.
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
// means — those are the names of the things, and no card's prose repeats them. The HINT is searched for the
// mirror reason: a tile's description is one line now, so the words that identify a card to the person looking
// for it ("webauthn", "socket mode", "botfather") live in prose the grid no longer prints. Searching only what
// is visible would make the catalog findable exactly to the extent it is already scannable, which is backwards.
const visibleCards = computed(() => {
    const needle = search.value.trim().toLowerCase();
    if (needle === ``) {
        return inScope.value;
    }
    return inScope.value.filter((card) =>
        `${card.entry.name} ${card.entry.description} ${card.entry.kind} ${card.entry.hint ?? ``}`.toLowerCase().includes(needle),
    );
});

// The visible cards grouped into their display sections, in category order; empty sections are dropped. Derived
// connector cards render before the static ones within a section (allCards order).
const groupedCatalog = computed(() =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const entries = visibleCards.value.filter((card) => card.entry.category === category.id);
        return entries.length === 0 ? [] : [{ label: category.label, entries }];
    }),
);

// The page's own sentence follows the slice: under one category it is that category's hint, which is where the
// heading the grid no longer repeats has gone.
const description = computed(() => {
    if (activeScope.value.key === CONNECTED) {
        return `Every connection your agent can reach right now. Open one to change it, to add another of the same kind, or to take it away.`;
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
const error = ref<NoticeModel | null>(null);
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
                  : kind === `identity`
                    ? `user`
                    : kind === `agent`
                      ? `sparkles`
                      : `bolt`;
// The glyph tier <BrandMark> falls to when a card has no simple-icons logo (or the slug fails to load): the
// card's explicit `icon`, else the generic per-kind fallback. A card is never left to the initials tier — its
// KIND is always known, and "some connector" drawn as a bolt beats it drawn as two letters.
const entryIcon = (entry: CapabilityCatalogEntry): IconName => (entry.icon as IconName | undefined) ?? kindIcon(entry.kind);

/* The live-browser window for a browser-kind capability (the session is a real logged-in browser, not a pasted
 * token, so it lives out-of-band over the /system/browser-profile WebSocket). Two things open it and one
 * component serves both: signing the account in, and — once it IS signed in — the user taking that same browser
 * for a spin themselves.
 *
 * It opens ONE CONNECTION, never a site: the same card can hold several accounts (a work Reddit and a personal
 * one), each with its own profile and its own login, so every caller below passes the instance it is standing on
 * and the window is titled with that account's name. */
const profileVisible = ref(false);
const profileCapability = ref(``);
const profileLabel = ref(``);
const profileMode = ref<`login` | `browse`>(`login`);
// An ACP agent's interactive sign-in: the daemon starts its loginCommand in the capability's job session and
// the terminal panel opens focused on it (user-clicked action → openFocused, the add-stream precedent).
const startAgentLogin = async (id: string): Promise<void> => {
    try {
        const { session } = await sandboxJson<{ session: string }>(`/capabilities/${encodeURIComponent(id)}/login`, { method: `POST` });
        useTerminalPanel().openFocused(session);
    } catch (caught) {
        error.value = noticeFrom(caught, `Sign-in could not start.`);
    }
};

const openBrowser = (capability: string, label: string, mode: `login` | `browse` = `login`): void => {
    profileCapability.value = capability;
    profileLabel.value = label;
    profileMode.value = mode;
    profileVisible.value = true;
};
/* A browser capability goes pending on one of TWO different things, and they lead to opposite places: its
 * Chromium is not installed yet (a sandbox rebuild, on another screen) or it is and nobody has signed in (the
 * login window, right here). The daemon tells them apart by the word "rebuild" in the detail — see the
 * handler, which is written to keep that word in one and out of the other. Read in both places that act on the
 * distinction, so the hint under a card and the hand-off after an add can never disagree about it. */
const awaitingLogin = (instance: CapabilitySummary): boolean =>
    instance.status.state === `pending` && !String(instance.status.detail ?? ``).includes(`rebuild`);

// A completed login flips the capability's status pending → active; refresh the list so it shows.
const onBrowserDone = (): void => {
    void refetch();
};

// A `when`-gated field applies only while its referenced field holds the given value (e.g. the SSH credential
// matching the chosen auth mode). Read from reactive `values`, so it re-evaluates as the user toggles.
const whenMet = (field: CapabilityField): boolean => field.when === undefined || values[field.when.key] === field.when.value;

/* WHICH FIELDS ANSWER THEMSELVES BESIDE THEIR LABEL rather than under it. A switch always does. A picker does
 * when its answers are short enough to sit in the same line as the question — and the test is the WIDTH of the
 * answers, not how many there are, because that is what actually decides whether the row fits.
 *
 * Counting options would have been the obvious rule and it is the wrong one: `Allowed`/`Blocked` and
 * `OpenAI-compatible`/`Anthropic-compatible` are both two options, and only one of them leaves room for a label
 * to its left. Measuring instead puts the six Allowed/Blocked permissions of a computer inline (where they
 * halve the form) and leaves the model-endpoint protocol and the VPN's three-protocol picker stacked (where
 * they would otherwise crush the label or wrap). A long list — the DH groups — fails the same test by itself. */
const INLINE_OPTIONS_BUDGET = 24;
const inlineField = (field: CapabilityField): boolean => {
    if (field.boolean === true) {
        return true;
    }
    if (field.options === undefined || field.multiline === true) {
        return false;
    }
    return field.options.reduce((total, option) => total + option.label.length, 0) <= INLINE_OPTIONS_BUDGET;
};
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
// its manifest so process/image contributions show. Not rendered any more — the effects a card implies are
// stated once beside the form (<CapabilityContext>), not repeated under every connection of it — but still
// read for the ONE fact that is genuinely per-instance: the grants a machine was given (hostGrants below).
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
        error.value = noticeFrom(err, `Could not browse the registry.`);
    } finally {
        browsing.value = false;
    }
};

// Only the rows this card can actually install: a registry serves plugins and extensions from one file, and
// offering an extension row on the plugin form would pre-fill a config the daemon then refuses.
const marketEntries = computed<RegistryEntry[]>(() =>
    selected.value === undefined ? [] : (market.value?.plugins.filter((entry) => entry.kind === selected.value?.kind) ?? []),
);

/* What the nightly scan found at the row's pinned commit, folded to the one question a browser has: will it
 * load? Absent checks say nothing (a registry with no scanner, or a listing repointed since last night) — the
 * row renders as it always did, claiming nothing. "none" is a daemon-only extension, which loads fine. */
const checksProblem = (entry: RegistryEntry): string | undefined => {
    if (entry.checks === undefined) {
        return undefined;
    }
    if (entry.checks.manifest !== `ok`) {
        return `At the pinned commit, ${entry.checks.manifest}`;
    }
    return entry.checks.bundle === `ok` || entry.checks.bundle === `none` ? undefined : `At the pinned commit, the bundle ${entry.checks.bundle}`;
};
const checksOk = (entry: RegistryEntry): boolean => entry.checks !== undefined && checksProblem(entry) === undefined;

/* THE PRE-INSTALL READ. The install dialog shows what the manifest declares and the registry's checks say the
 * thing loads; what neither can say is whether the code does what the description claims and nothing else. The
 * one party with perfect incentives to answer that is the owner's own agent, reading the exact commit cold —
 * so an extension form holding a pinned commit offers to start that read as an ordinary chat.
 *
 * Offered exactly when there is a commit to read: the audit's whole subject is the sha the install would pin,
 * and reading a branch instead would produce a confident account of code nobody is about to run. The gate does
 * not move — installing stays the same approval, made by the same person, with an account of the code in front
 * of them instead of a description written by the person selling it. */
const auditable = computed(
    () =>
        selected.value?.kind === `extension` &&
        typeof values[`url`] === `string` &&
        values[`url`] !== `` &&
        /^[0-9a-f]{40}$/u.test(String(values[`ref`] ?? ``)),
);
/* When the form is about to REPLACE an installed commit rather than add a first one, the sharper read is the
 * diff: the installed sha was approved once already, and what an update asks the owner to judge is what sits
 * between the two. Known from the same collision that flips the submit button to "Update". */
const updateFrom = computed<string | undefined>(() => {
    if (!auditable.value || !nameCollision.value) {
        return undefined;
    }
    const installed = selectedInstances.value.find((instance) => instance.id === name.value.trim())?.config[`ref`];
    return typeof installed === `string` && /^[0-9a-f]{40}$/u.test(installed) && installed !== String(values[`ref`]) ? installed : undefined;
});
const startAudit = (): void => {
    const label = name.value.trim() === `` ? String(values[`url`]) : name.value.trim();
    const shared = { label, url: String(values[`url`]), path: String(values[`path`] ?? ``) };
    startAgent(
        updateFrom.value !== undefined
            ? updateBrief({ ...shared, fromRef: updateFrom.value, toRef: String(values[`ref`]) })
            : auditBrief({ ...shared, ref: String(values[`ref`]) }),
    );
};

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

/* --- THE CONNECTED SLICE: an inventory, not a catalog with the unconnected cards taken out ---
 *
 * See <CapabilityConnections> for why this is a list of INSTANCES. What lives here rather than in the component
 * is everything that needs the page's own sources — the host roster, the vpn links, the daemon's pending detail
 * — so the component stays a renderer of rows somebody else decided the meaning of.
 *
 * Placed below the per-kind helpers it reads (hostFor, awaitingLogin, vpnFacts) rather than beside the cards it
 * derives from: `connectionCount` is up there because the rail needs only the number. */

// What identifies a connection to the person who made it, in the order they would say it. `provider`/`platform`
// are deliberately absent — they are the card, which the row already names, so printing them would spend the
// line on "github · github". Secrets never reach here: the daemon strips them from the config it echoes back.
// `email` is an identity row's one fact; `identity` is the born-from note on an account row filed under one.
const CONNECTION_FACTS = [`host`, `server`, `url`, `account`, `email`, `identity`, `org`, `guild`, `database`, `user`, `path`] as const;

// Two facts at most. A row is a line, and the third fact is the one that pushes the state badge off the end of it.
const connectionFacts = (instance: CapabilitySummary): string =>
    CONNECTION_FACTS.map((key) => instance.config[key])
        .filter((value): value is string => typeof value === `string` && value.trim() !== ``)
        .slice(0, 2)
        .join(` · `);

/* THE STATE IN THE READER'S WORDS, and the order the rows sort in. "active/pending/error/inactive" is the
 * daemon's vocabulary and it is the wrong one here: `pending` is the state of a thing whose setup was never
 * finished, and the reader's question is not what to call it but whether they still have something to do. Rank
 * is the same judgement as the wording — what is unfinished or broken sorts above what is merely working, so a
 * list that mostly works still opens on the part that doesn't. */
const CONNECTION_STATES: Readonly<Record<CapabilityState, { label: string; tone: StatusVariant; rank: number }>> = {
    error: { label: `error`, tone: `danger`, rank: 0 },
    pending: { label: `needs setup`, tone: `warning`, rank: 1 },
    inactive: { label: `off`, tone: `neutral`, rank: 2 },
    active: { label: `ready`, tone: `success`, rank: 3 },
};

// Two kinds know something truer about themselves than their status field does, and both are the difference
// between "you have something to do" and "it is simply asleep" — which is exactly what this column is for.
const connectionState = (entry: CapabilityCatalogEntry, instance: CapabilitySummary): { label: string; tone: StatusVariant; rank: number } => {
    if ((entry.kind === `browser` || entry.kind === `identity`) && awaitingLogin(instance)) {
        return { label: `needs sign-in`, tone: `warning`, rank: 1 };
    }
    if (entry.kind === `host` && instance.status.state === `active`) {
        return hostFor(instance.id)?.online === true ? { label: `online`, tone: `success`, rank: 3 } : { label: `offline`, tone: `neutral`, rank: 2 };
    }
    return CONNECTION_STATES[instance.status.state];
};

/* One row per live connection, carrying its category so the list groups the way the catalog does and a haystack
 * so the filter over it searches the things a row actually shows. That haystack is the reason the bar keeps
 * working when the slice changes under it: in the catalog "acme" matches nothing, and here it has to find the
 * box called ops-box at ops.acme.dev — the name its owner typed and the address they typed are the two things
 * they would search for, and neither is in any card's prose. */
type ConnectionRow = CapabilityConnection & { readonly category: CapabilityCategory; readonly rank: number; readonly haystack: string };

const connections = computed<ConnectionRow[]>(() =>
    cards.value.flatMap((card) =>
        card.instances.map((instance) => {
            const state = connectionState(card.entry, instance);
            const facts = (card.entry.kind === `vpn` ? vpnFacts(instance.id) : undefined) ?? connectionFacts(instance);
            // Only where something is actually outstanding: the daemon writes these for a reader ("Not
            // connected", "Needs a sandbox rebuild"), and echoing one beside a working connection would turn a
            // status into noise.
            const note = state.rank <= 1 ? instance.status.detail : undefined;
            // A connection nobody named took the card's id (suggestName), and "docker" written under a Docker
            // logo with "Docker" beneath it is the same word three times. Where the name IS the card, the card
            // is the name — and the line under it is free for the facts that actually differ.
            const named = instance.id !== card.entry.id;
            return {
                title: named ? instance.id : card.entry.name,
                card: named ? card.entry.name : undefined,
                cardId: card.entry.id,
                id: instance.id,
                logo: card.entry.logo,
                icon: entryIcon(card.entry),
                detail: facts,
                state: state.label,
                tone: state.tone,
                note,
                category: card.entry.category,
                rank: state.rank,
                haystack: `${instance.id} ${card.entry.name} ${card.entry.kind} ${facts}`.toLowerCase(),
            };
        }),
    ),
);

const visibleConnections = computed<ConnectionRow[]>(() => {
    const needle = search.value.trim().toLowerCase();
    return needle === `` ? connections.value : connections.value.filter((row) => row.haystack.includes(needle));
});

// The same headings as the grid, so the rail points at the same ten either way. Sorted inside a group rather
// than across the whole list: what needs attention should rise past the rows it sits WITH, not jump the
// category it belongs to.
const connectionGroups = computed<CapabilityConnectionGroup[]>(() =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const rows = visibleConnections.value
            .filter((row) => row.category === category.id)
            .toSorted((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
        return rows.length === 0 ? [] : [{ label: category.label, rows }];
    }),
);

// Which of the two the grid pane is showing, and how much of it — the filter bar's count follows whichever list
// is under it, because a number that counts something else is worse than no number.
const showingConnections = computed(() => activeScope.value.key === CONNECTED);
const visibleCount = computed(() => (showingConnections.value ? visibleConnections.value.length : visibleCards.value.length));
const nothingMatches = computed(() => (showingConnections.value ? connectionGroups.value.length === 0 : groupedCatalog.value.length === 0));

/* --- AND THE SAME CONNECTION SEEN FROM INSIDE ITS CARD ---
 * The Connected slice above lists every connection in the sandbox; a card's own view lists the ones that came
 * from THAT card, which is where they are also acted on. Two surfaces, one vocabulary: both read their state
 * from connectionState(), so a Reddit account cannot be "needs sign-in" in the inventory and "pending" on its
 * card. That mattered enough to delete a second mapping written for the card rows alone.
 *
 * What the card's rows need on top is the two live facts a stored config cannot answer — the address a tunnel
 * was actually given, the OS a machine actually reported. connectionFacts() is the fallback for everything
 * else, so a Postgres row still names its host and database. */
const cardRowFacts = (instance: CapabilitySummary): string => {
    if (selected.value?.kind === `vpn`) {
        return vpnFacts(instance.id) ?? connectionFacts(instance);
    }
    if (selected.value?.kind === `host`) {
        return hostFor(instance.id)?.facts?.os ?? connectionFacts(instance);
    }
    return connectionFacts(instance);
};

/* THE ONE UNFINISHED STEP THE ROW CANNOT OFFER ITSELF. A pending connection is waiting on one of three things,
 * and two of them — a browser's login, a computer's pairing command — are already a button on this very row, so
 * a second link beside the badge saying "Log in →" next to the Log in button was the same click twice.
 *
 * The third has nowhere on this card to go: a rebuild happens on the Sandbox screen. That is the only one that
 * still needs a link, and pointing it at the right place is the whole reason this is a function rather than a
 * `v-if` — a reader sent to /sandbox for a browser that merely needs signing in is a reader who does not come
 * back. The distinction is the daemon's "rebuild" wording (see awaitingLogin). */
const rebuildStep = (instance: CapabilitySummary): boolean =>
    instance.status.state === `pending` && selected.value?.kind !== `host` && !awaitingLogin(instance);

/* THE ONE-PER-SANDBOX CARD HAS NO LIST, because it never had one — it had a list of one, which is a different
 * thing wearing a list's chrome. Docker is not an account you hold N of; it is a part of the sandbox that is
 * either on or off, and rendering "docker · active" as a bordered card above the form that configures that very
 * docker asked the reader to hold two objects where there is one. Its state belongs on the card's own heading,
 * beside its name, which is where a state that describes the whole screen goes. */
const soleInstance = computed<CapabilitySummary | undefined>(() => (selected.value?.singleton === true ? selectedInstances.value[0] : undefined));

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
        error.value = noticeOf(`${file.name} is far too big to be a FortiClient configuration — that looks like the wrong file.`);
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
        error.value = noticeFrom(err, `Could not read that FortiClient configuration.`);
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

/* The picked row's tier, remembered beside the form rather than in it: tier is the registry's fact about the
 * listing, not a field anyone types, so it rides the install config only while the URL still is the picked
 * row's (hand-editing the URL is installing something else, whose tier this browser does not know). */
const pickedPremiumUrl = ref<string | null>(null);

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
    pickedPremiumUrl.value = entry.tier === `premium` ? entry.install.url : null;
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
    pickedPremiumUrl.value = null;
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
        /* WHAT THE WORKSPACE SCAN ALREADY KNOWS, filled in — the self-hosted instance url it read off a remote,
         * and anything else a card would otherwise ask a user to go and look up. This is where the recommended
         * flow earns its keep: a wrong instance url is one of the two ways connecting a repository host fails,
         * and the scan has already answered it correctly.
         *
         * NEVER A SECRET, and the guard is deliberate rather than defensive: a credential is the one thing this
         * flow will not put into a form on the user's behalf, even where one is sitting in a file it has read. */
        for (const [key, value] of Object.entries(recommendationFor(entry.id)?.prefill ?? {})) {
            const field = entry.fields.find((candidate) => candidate.key === key);
            if (field !== undefined && field.secret !== true && field.value === undefined) {
                values[key] = value;
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
            void router.replace({ name: `capabilities`, query: route.query });
        }
    },
    { immediate: true },
);

// Picking a card / going back is a navigation now — the URL is the source of truth for what's shown. The query
// rides along both ways, so going back lands on the slice the card was picked out of rather than on the whole
// catalog with the filter thrown away.
const openCard = (card: string): void => {
    void router.push({ name: `capabilities`, params: { card }, query: route.query });
};
const pick = (entry: CapabilityCatalogEntry): void => {
    openCard(entry.id);
};

const back = (): void => {
    void router.push({ name: `capabilities`, query: route.query });
};

/* --- THE GUIDED SETUP: the recommended cards, one at a time, in the order the daemon made them ---
 *
 * A queue rather than a wizard, and it steps through the ORDINARY cards: they already own the form, the "where
 * this token is made, with these scopes" guide, and the warning about what applying one costs. A parallel
 * wizard would be a second copy of all three, and the copy would drift.
 *
 * The walk lives in the URL and its contents are DERIVED, never snapshotted: connecting a card or declining it
 * takes it out of the queue by itself, so there is no cursor to get out of step with what is actually connected,
 * and a reload lands back where the user was. */
const SETUP = `recommended`;
const walking = computed(() => route.query[`setup`] === SETUP);
const walkQueue = computed<CapabilityCatalogEntry[]>(() => recommendedCards.value.filter((card) => card.connected === 0).map((card) => card.entry));

// The card to land on after this one is dealt with, read BEFORE the change that deals with it — after a connect
// or a dismissal the current card has left the queue, and re-deriving "next" then would send a user who skipped
// forward back to the top of the list.
const nextAfter = (entry: CapabilityCatalogEntry): string | undefined => {
    const at = walkQueue.value.findIndex((candidate) => candidate.id === entry.id);
    return (at === -1 ? walkQueue.value[0] : walkQueue.value[at + 1])?.id;
};
// Nothing left ⇒ the walk is over, and the catalog it lands back on is the proof of what got connected.
const goNext = (card: string | undefined): void => {
    void router.push(
        card === undefined
            ? { name: `capabilities`, query: { ...route.query, setup: undefined } }
            : { name: `capabilities`, params: { card }, query: route.query },
    );
};
const startSetup = (): void => {
    const first = walkQueue.value[0];
    if (first !== undefined) {
        void router.push({ name: `capabilities`, params: { card: first.id }, query: { ...route.query, setup: SETUP } });
    }
};
const skip = (): void => {
    if (selected.value !== undefined) {
        goNext(nextAfter(selected.value));
    }
};

const selectedRecommendation = computed(() => (selected.value === undefined ? undefined : recommendationFor(selected.value.id)));

// "Not needed" — the suggestion goes quiet until its evidence changes, which is what keeps the Recommended
// slice from becoming the strip people learn to stop reading. Nothing is torn down; the card stays in the
// catalog exactly as it was, minus the badge.
const dismiss = async (entry: CapabilityCatalogEntry): Promise<void> => {
    const next = walking.value ? nextAfter(entry) : undefined;
    error.value = null;
    try {
        await dismissRecommendation.mutateAsync(entry.id);
    } catch (err) {
        error.value = noticeFrom(err, `Could not dismiss that suggestion.`);
        return;
    }
    if (walking.value) {
        goNext(next);
        return;
    }
    back();
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
    // The picked registry row's tier (see pickedPremiumUrl) — what the daemon's premium gate reads.
    if (entry.kind === `extension` && pickedPremiumUrl.value !== null && pickedPremiumUrl.value === (values[`url`] ?? ``).trim()) {
        config[`tier`] = `premium`;
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
    // Where the walk goes next, decided against the queue as it stands now — the add below takes this card out
    // of it, and asking afterwards would answer about a different list.
    const next = walking.value ? nextAfter(entry) : undefined;
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
        /* AN APPLY THAT ENDS `pending` HAS NOT FINISHED SETTING THE CAPABILITY UP, and going back to the
         * catalog is what stranded it: the reader lands in front of a grid, with a capability that has quietly
         * gone pending and nothing on screen saying what remains. The card they were just on already says it —
         * the instance row's hint names the missing step and leads to it, in all three flavours (a machine's
         * one-liner, a browser's login, a sandbox rebuild). So: pending stays, finished goes back.
         *
         * The two whose missing step is a DIALOG on this very card open it outright rather than leaving a hint
         * to click, because the reader is standing there waiting for exactly that. The rebuild flavour cannot —
         * it lives on the Sandbox screen — and deliberately does not get a bar or a redirect for it: a standing
         * condition belongs on the sandbox chip that already carries it (see sandboxAttention.ts), and the row's
         * link is the hand-off. */
        const added = capabilities.value.find((capability) => capability.id === input.id);
        if (added?.status.state === `pending`) {
            // A machine that has never checked in is waiting on the one-liner. One that HAS is merely asleep,
            // and a fresh pairing is not what wakes it — that is the same distinction the row's button draws
            // when it relabels itself Reconnect.
            if (entry.kind === `host` && hostFor(added.id)?.lastSeen === undefined) {
                openConnect(added);
            } else if ((entry.kind === `browser` || entry.kind === `identity`) && awaitingLogin(added)) {
                // An identity's sign-in is the ONE login the owner does by hand — open the window right away,
                // exactly like a fresh account's.
                openBrowser(added.id, added.id);
            }
            return;
        }
        if (walking.value) {
            goNext(next);
            return;
        }
        back();
    } catch (err) {
        error.value = noticeFrom(err, `Could not add the capability.`);
    } finally {
        submitting.value = false;
    }
};

const removeCapability = async (id: string): Promise<void> => {
    error.value = null;
    try {
        await remove.mutateAsync(id);
    } catch (err) {
        error.value = noticeFrom(err, `Could not remove the capability.`);
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

const topError = computed<NoticeModel | undefined>(
    () =>
        error.value ??
        (listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list your capabilities.`, detail: listError.value }),
);
const submitLabel = computed(() =>
    selected.value?.kind === `devops` ? `Activate` : nameCollision.value ? `Update` : selected.value?.kind === `service` ? `Add & provision` : `Add`,
);
</script>

<template>
    <SplitView title="Capabilities" :description="description">
        <template #strips>
            <Notice v-if="topError" :of="topError" />
        </template>

        <!-- The rail NARROWS the grid rather than selecting a document, so on a phone <SplitView> folds it ABOVE
             the grid instead of covering it (mobile="collapse", the default). <CapabilityRail> already swaps
             itself to a Picker at that width, so it needs no separate #compact form. -->
        <template #rail>
            <CapabilityRail v-model="railScope" :pinned="pinnedScopes" :categories="categoryScopes" />
        </template>

        <template #detail>
            <!-- STEP 2: configure + apply the picked capability. TWO COLUMNS, ALWAYS: the form keeps its reading
                 width and everything the card SAYS rather than ASKS docks beside it, /setup-style — see
                 <CapabilityContext> and the aside at the foot of this block. A @container rather than a viewport
                 breakpoint: this pane shares the page with the index column and the shell with a chat panel the
                 user drags, so how much room there is for a second column is a fact about the pane, not about the
                 screen. Below that width the row collapses and the context moves inline into the form. -->
            <div v-if="selected" class="scrollbar-thin scrollbar-stable @container min-h-0 flex-1 overflow-y-auto pr-2">
                <div class="mx-auto flex max-w-xl flex-col @3xl:max-w-none @3xl:flex-row @3xl:items-start @3xl:justify-center @3xl:gap-6">
                    <!-- CAPPED BELOW THE READING MEASURE, because this column does not hold reading — it holds a
                         stack of single-line inputs, and a text box is no easier to fill in at 36rem than at 32.
                         The room it was taking came out of the column beside it, which holds the opposite kind of
                         text: five numbered steps a reader works through before the first keystroke. -->
                    <div class="flex min-w-0 flex-1 flex-col @3xl:max-w-lg">
                        <!-- Back to the slice the card was picked out of, named — "All capabilities" was a lie the
                             moment the rail could be pointing at one category. -->
                        <button type="button" class="mb-4 inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-content" @click="back">
                            <Icon name="arrow-left" class="text-2xs" /> {{ activeScope.label }}
                        </button>

                        <!-- The walk's own strip: where the user is in it, and the way past a card they don't
                             want to answer right now. A count of what is LEFT rather than "step 2 of 5" — a
                             connected card leaves the queue, so any fixed position would start lying at the
                             first success. -->
                        <div v-if="walking" class="mb-4 flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
                            <Icon name="sparkles" class="text-info" />
                            <span class="text-xs text-content">Recommended setup</span>
                            <span class="text-2xs text-muted">{{ walkQueue.length }} left</span>
                            <Button class="ml-auto" label="Skip" size="small" severity="secondary" text @click="skip" />
                        </div>

                        <!-- The card's own heading, and — for a one-per-sandbox card — its STATE, because on
                             such a card the state describes this whole screen rather than one row in a list of
                             them. Its removal sits here too, for the same reason: the thing being removed is
                             the subject of the page, not an entry under it. -->
                        <div class="mb-4 flex items-center gap-3">
                            <BrandMark :size="32" :name="selected.name" :logo="selected.logo" :icon="entryIcon(selected)" />
                            <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="font-medium text-content">{{ selected.name }}</span>
                                    <StatusBadge
                                        v-if="soleInstance"
                                        size="xs"
                                        :dot="true"
                                        :variant="connectionState(selected, soleInstance).tone"
                                        :label="connectionState(selected, soleInstance).label"
                                    />
                                </div>
                                <div class="text-xs text-muted">{{ selected.description }}</div>
                            </div>
                            <Button
                                v-if="soleInstance && selected.kind !== 'devops'"
                                label="Remove"
                                size="small"
                                severity="danger"
                                :text="true"
                                @click="askRemove(soleInstance.id)"
                            >
                                <template #icon><Icon name="trash" /></template>
                            </Button>
                        </div>

                        <!-- A one-per-sandbox card whose setup never finished has no row to carry the step it is
                             waiting on, so it carries it here — directly under the heading its badge is on. -->
                        <RouterLink
                            v-if="soleInstance && rebuildStep(soleInstance)"
                            to="/sandbox/environment"
                            class="mb-4 inline-flex w-fit items-center gap-1 text-xs text-warning hover:underline"
                        >
                            <Icon name="exclamation-triangle" />
                            {{ soleInstance.status.detail ?? "Needs a sandbox rebuild" }} — Finish setup →
                        </RouterLink>

                        <!-- Precondition gate: a service/integration needs DevOps first. -->
                        <div v-if="!requiresMet" :class="cmp.alertInfo()">
                            This needs <b>DevOps</b> active first. Go back and activate the DevOps capability, then add this.
                        </div>

                        <form v-else class="flex flex-col gap-3" @submit.prevent="submit">
                            <!-- WHAT YOU ALREADY HAVE OF THIS CARD — a list of accounts, and therefore a LIST:
                                 <Row> at the density every other record list in the app is read at, one line
                                 each. It used to be a stack of two-line blocks, and the second line was a strip
                                 of icon-only effect glyphs repeated identically under every row — the same three
                                 symbols under all three GitHub connections, saying nothing that distinguished
                                 one from another, and clickable-looking without being clickable. Effects are a
                                 fact about the CARD, so they are stated once, in the column beside this one.
                                 What is left is what actually differs per connection: its name, its state, the
                                 live fact it reports, and what you can do to it.

                                 Suppressed entirely for a one-per-sandbox card, whose single instance is the
                                 subject of the heading above rather than an entry under it. -->
                            <RowGroup
                                v-if="selectedInstances.length > 0 && !selected.singleton"
                                label="Your connections"
                                :count="selectedInstances.length"
                            >
                                <Row v-for="instance in selectedInstances" :key="instance.id" density="compact">
                                    <template #title>
                                        <span class="flex flex-wrap items-center gap-2">
                                            <span class="font-mono">{{ instance.id }}</span>
                                            <StatusBadge
                                                size="xs"
                                                :dot="true"
                                                :variant="connectionState(selected, instance).tone"
                                                :label="connectionState(selected, instance).label"
                                            />
                                            <!-- The one unfinished step this row has no button for, in line with
                                                 the badge that named it: it is one clause, and giving it a line
                                                 of its own is what made these rows two-deep. The badge says the
                                                 STATE in the reader's words and this says what is actually
                                                 outstanding, in the daemon's — the same division <CapabilityConnections>
                                                 draws between a row's state and its note. -->
                                            <RouterLink
                                                v-if="rebuildStep(instance)"
                                                to="/sandbox/environment"
                                                class="text-2xs text-warning hover:underline"
                                            >
                                                {{ instance.status.detail ?? "Needs a sandbox rebuild" }} — Finish setup →
                                            </RouterLink>
                                        </span>
                                    </template>
                                    <!-- A tunnel's address and what it routes, a machine's reported OS: what the
                                         connection says about itself, in the column <Row> reserves for facts.
                                         CAPPED, because a split tunnel lists every network it carries and the
                                         column does not shrink — left to run, it pushed the name and its badge
                                         onto two lines. The full list is one hover away and, unabridged, on the
                                         Status card that dials the thing. -->
                                    <template v-if="cardRowFacts(instance)" #meta>
                                        <span class="block max-w-40 truncate font-mono" :title="cardRowFacts(instance)">
                                            {{ cardRowFacts(instance) }}
                                        </span>
                                    </template>
                                    <template #control>
                                        <div class="flex items-center gap-1">
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
                                            <!-- A connected browser is an account the user still owns, so the window that signed
                                                 it in is also the way to USE it: check a message, clear a captcha, change a
                                                 setting the agent has no business changing. Only once it is connected — before
                                                 that the same window's job is the sign-in beside it. Both pass THIS ROW's
                                                 instance: the card may hold several accounts of the site, and the window opens
                                                 one of them. -->
                                            <Button
                                                v-if="
                                                    (selected.kind === 'browser' || selected.kind === 'identity') &&
                                                    instance.status.state === 'active'
                                                "
                                                label="Open browser"
                                                size="small"
                                                :text="true"
                                                @click="openBrowser(instance.id, instance.id, `browse`)"
                                            >
                                                <template #icon><Icon name="globe" /></template>
                                            </Button>
                                            <!-- A browser capability connects via a live login window, not a form — offer it here
                                                 (also the way to re-log-in once a session expires). An identity's window is the
                                                 same thing pointed at its email provider — the one login that stays human. -->
                                            <Button
                                                v-if="selected.kind === 'browser' || selected.kind === 'identity'"
                                                :label="instance.status.state === 'active' ? 'Re-log in' : 'Log in'"
                                                size="small"
                                                :text="true"
                                                @click="openBrowser(instance.id, instance.id)"
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
                                    </template>
                                </Row>
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
                                            <!-- The price, before the click: a premium row needs a membership to install,
                                             and its retained use is what pays its creator from the pool. -->
                                            <span
                                                v-if="entry.tier === 'premium'"
                                                class="shrink-0 rounded-sm bg-overlay px-1 text-2xs font-medium text-primary-500"
                                                v-tooltip.top="`Premium — needs an intentic membership; its use pays its creator from the pool`"
                                                >Premium</span
                                            >
                                            <span v-if="entry.version" class="text-2xs text-subtle">{{ entry.version }}</span>
                                            <!-- Evidence, not endorsement: the nightly scan re-read this row's pinned
                                             commit and found (or didn't) a thing that loads. Silent when there are no
                                             checks at all — absence of evidence is not a warning. -->
                                            <Icon
                                                v-if="checksOk(entry)"
                                                name="check"
                                                class="shrink-0 text-success"
                                                v-tooltip.top="`Loads — re-checked at the pinned commit by the registry's nightly scan`"
                                            />
                                            <Icon
                                                v-else-if="checksProblem(entry)"
                                                name="exclamation-triangle"
                                                class="shrink-0 text-warning"
                                                v-tooltip.top="checksProblem(entry)"
                                            />
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

                            <!-- WHAT THE FORM BELOW IS FOR, said out loud. The fields used to begin immediately
                                 under the list of existing connections, which left "Name" — pre-filled with
                                 `github-2` — as the only clue that this was a second connection rather than an
                                 edit of the first. A card that holds one thing per sandbox is not adding
                                 anything, so it says what it IS doing instead. -->
                            <div v-if="selectedInstances.length > 0 || selected.singleton" :class="cmp.sectionLabel(`mt-1`)">
                                {{ selected.singleton ? "Settings" : "Add another" }}
                            </div>

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
                            <!-- The narrow half of the card's reference material, above the fields it explains.
                             From @3xl it is docked in a column of its own (see the aside below) and this one is
                             hidden — exactly one of the two is ever on screen. -->
                            <CapabilityContext :entry="selected" :values="values" :effects="liveEffects" class="@3xl:hidden" />
                            <template v-for="field in visibleFields(selected)" :key="field.key">
                                <!-- AN ANSWERED QUESTION SITS BESIDE ITS LABEL, NOT UNDER IT. Stacked in the column of
                                 inputs it reads as one more thing to fill in; beside the label it reads as the thing it
                                 is — already answered, changeable. Its hint carries what the label can't say (a host
                                 requirement, when the value takes effect), which is exactly the caveat a lone switch
                                 invites people to skip.
                                 The switches always worked this way; the SHORT PICKERS did not, and they are the ones
                                 that hurt — a connected computer asks six Allowed/Blocked questions, and stacking each
                                 label over its own pair of buttons made a form of six pre-answered defaults twice as
                                 tall as the screen. See inlineField() for where the line is drawn and why it is drawn
                                 on the width of the answers rather than on their number. -->
                                <label v-if="inlineField(field)" class="flex items-start justify-between gap-4">
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
                                        v-if="field.boolean"
                                        class="ui-switch-sm mt-0.5 shrink-0"
                                        :model-value="values[field.key] === 'on'"
                                        :aria-label="field.label"
                                        @update:model-value="(value: boolean) => (values[field.key] = value ? 'on' : 'off')"
                                    />
                                    <Segmented
                                        v-else
                                        class="shrink-0"
                                        :model-value="values[field.key] ?? ''"
                                        :options="[...(field.options ?? [])]"
                                        @update:model-value="values[field.key] = $event"
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
                            <!-- Why the grid badged this one — the claim, then the thing that was read to make
                                 it, verbatim. The evidence is what makes this checkable instead of magic, and it
                                 is also what "Not needed" is answering: the suggestion goes quiet for THIS, and
                                 comes back by itself if the workspace changes under it. -->
                            <div v-if="selectedRecommendation" :class="cmp.alertInfo()">
                                <div class="flex items-start gap-3">
                                    <div class="min-w-0 flex-1">
                                        <div>Recommended — {{ selectedRecommendation.reason }}.</div>
                                        <div class="mt-0.5 truncate font-mono text-2xs text-subtle">{{ selectedRecommendation.evidence }}</div>
                                    </div>
                                    <Button
                                        label="Not needed"
                                        size="small"
                                        severity="secondary"
                                        text
                                        :loading="dismissRecommendation.isPending.value"
                                        @click="dismiss(selected)"
                                    />
                                </div>
                            </div>

                            <!-- THE SUBMIT STAYS ON SCREEN. A few cards are genuinely long — a VPN carries three
                                 protocols' worth of fields, a computer seven permissions — and no amount of moving
                                 prose out of this column makes those short. What made a long one unusable was not
                                 its length but that scrolling took the only button on the page out of view, so the
                                 reader had to scroll back down through what they had just filled in to press it.
                                 Stuck to the foot of the pane it is reachable from anywhere in the form, and the
                                 canvas tint under it keeps the last field from appearing to run into it. -->
                            <div
                                :class="[
                                    'sticky bottom-0 -mx-1 flex items-center gap-3 border-t border-line bg-canvas px-1 py-3',
                                    auditable ? 'justify-between' : 'justify-end',
                                    shaking ? 'ui-shake' : '',
                                ]"
                                @animationend="shaking = false"
                            >
                                <!-- The read is beside the approval because that is when it matters: before the
                                     click, not after. It starts an ordinary chat and the form stays as it is —
                                     the account arrives, and installing remains this same button. -->
                                <button v-if="auditable" type="button" :class="cmp.linkButton(`text-2xs`)" @click="startAudit">
                                    {{
                                        updateFrom !== undefined
                                            ? `Have an agent read what changed first — the manifest delta leads`
                                            : `Have an agent read it first — what the code does, route by route`
                                    }}
                                </button>
                                <Button type="submit" :label="submitLabel" :loading="submitting">
                                    <template #icon><Icon name="check" /></template>
                                </Button>
                            </div>
                        </form>
                    </div>

                    <!-- The docked half of the card's reference material. `hidden` below @3xl, where the same
                         component renders inline inside the form instead — exactly one of the two is ever on
                         screen. `items-start` on the row is what leaves it room to stick while the form scrolls
                         past it.

                         NO `v-if` ANY MORE, and that is the point of the restructure: it used to appear only for
                         a card whose author had written a credential guide, so half the catalog rendered one
                         narrow column against an empty half-page. Every card has effects, so every card has a
                         column — the page has one shape instead of two.

                         AND IT SCROLLS WITH THE PANE rather than sticking. Sticky was right when this column
                         held only a guide, because a guide short enough to pin is a guide that fits. Holding
                         three panels it does not fit, and the two ways to pin something that doesn't fit are
                         both worse than not pinning it: leave it sticky and its foot — where "this will add to
                         your sandbox" now lives — is unreachable; cap it and give it its own scrollbar and the
                         page has three nested scroll regions, which is the thing this whole pass is undoing.
                         Flowing, one scrollbar moves the whole page and nothing is hidden anywhere.

                         AND IT WIDENS WITH THE PANE, up to a measure and no further. 18rem was set when this
                         column held a four-line hint; it now holds the how-to somebody reads BEFORE they can
                         answer the first field, and five steps broken across 18rem is a wall of text no amount
                         of leading fixes. 24rem is where it stops: past roughly 70 characters a line costs more
                         in finding the next one than it wins in fitting the last, and this text is small. -->
                    <aside class="hidden @3xl:block @3xl:w-80 @3xl:shrink-0 @4xl:w-96">
                        <CapabilityContext :entry="selected" :values="values" :effects="liveEffects" />
                    </aside>
                </div>
            </div>

            <!-- STEP 1: the catalog. -->
            <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
                <!-- WHAT THE WORKSPACE ITSELF ASKS FOR, offered as one thing to do rather than as badges to go
                     and find. It sits above the filter because it is not one: it is the shortest path off this
                     page for somebody who has just arrived and has no idea which of forty cards apply to them.
                     Only ever shown when the scan actually found something — an empty version of this would be a
                     permanent invitation to a walk with nothing in it. -->
                <div v-if="walkQueue.length > 0" class="flex flex-wrap items-center gap-3 rounded-lg border border-info/30 bg-info/5 px-4 py-3">
                    <Icon name="sparkles" class="text-info" />
                    <div class="min-w-0 flex-1">
                        <div class="text-sm text-content">
                            {{ walkQueue.length }} {{ walkQueue.length === 1 ? "capability your" : "capabilities your" }} workspace asks for
                        </div>
                        <div class="text-xs text-muted">
                            Each one is something your own code already points at. We fill in what we could read; you add only the credential.
                        </div>
                    </div>
                    <Button label="Set them up" size="small" @click="startSetup">
                        <template #icon><Icon name="arrow-right" /></template>
                    </Button>
                </div>

                <!-- The bar sits on the grid it narrows, spanning it — one left edge and one right edge down the
                     pane. Picking the slice is the rail's own job and is not repeated here. -->
                <FilterBar
                    v-model="search"
                    :placeholder="showingConnections ? `Filter by name, host, kind…` : `Filter by name, what it does, kind…`"
                    :count="visibleCount"
                />

                <!-- The tiles keep their distance from the scrollbar: `pr-2` is the gap, and the reserved gutter is
                     what stops the whole grid sliding sideways the moment a filter takes the last row away. -->
                <div class="scrollbar-thin scrollbar-stable @container flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pr-2">
                    <!-- THE ONE SLICE THAT IS NOT A SHORTER CATALOG. Everywhere else the question is "what could
                         I add", and a grid of tiles answers it; here it is "what have I got", and the answer is
                         the connections themselves — named, with the host or account that tells them apart and
                         the state they are actually in. See <CapabilityConnections>. -->
                    <CapabilityConnections v-if="showingConnections" :groups="connectionGroups" @open="openCard" />

                    <!-- HEADINGS ONLY WHERE THE GRID SPANS MORE THAN ONE CATEGORY. Under a single category the
                         rail has already said which one and the page's own description carries its sentence, so a
                         heading repeating both above the only group in view is a line of chrome. -->
                    <template v-else>
                        <div v-for="group in groupedCatalog" :key="group.label" class="flex flex-col gap-2">
                            <!-- The label alone. The category's sentence is the PAGE's description the moment the rail
                             points at it, so printing all ten of them down the full catalog spends a line each on
                             text nobody is reading yet — and the catalog is the view that has no room to spare. -->
                            <div v-if="!inCategory" :class="cmp.sectionLabel()">{{ group.label }}</div>
                            <!-- Container queries, not viewport ones: the grid is what is left of the page after the
                             index column takes its 16rem, so how many tiles fit is a fact about this pane. -->
                            <div class="grid grid-cols-1 gap-2 @xl:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4">
                                <button
                                    v-for="card in group.entries"
                                    :key="card.entry.id"
                                    type="button"
                                    class="flex h-full w-full items-start gap-2 rounded-lg border border-line bg-card px-2.5 py-2 text-left transition-colors hover:border-line-strong hover:bg-overlay"
                                    @click="pick(card.entry)"
                                >
                                    <BrandMark :size="24" :name="card.entry.name" :logo="card.entry.logo" :icon="entryIcon(card.entry)" />
                                    <div class="min-w-0">
                                        <!-- WRAPPING, because the tile is a third of a pane rather than a third of the
                                         page now. Without it the badges hold their line and squeeze the name into
                                         two, which puts the one word a scanner is looking for last.

                                         EVERY BADGE IS A GLYPH, with its sentence in the tooltip: the words spent
                                         a whole line of a tile that is now two lines tall, and they were the same
                                         words on every card carrying them — a strip of green ticks reads as a
                                         column of state faster than "1 connected" repeated down the grid. -->
                                        <div class="flex flex-wrap items-center gap-x-1.5">
                                            <span class="text-xs font-semibold text-content">{{ card.entry.name }}</span>
                                            <!-- The count only once there is more than one to count: a lone tick already
                                             means connected, and "1" beside it is a number nobody needs. -->
                                            <span
                                                v-if="card.connected > 0"
                                                v-tooltip.top="`${card.connected} connected`"
                                                class="inline-flex items-center gap-0.5 text-2xs text-success"
                                                :aria-label="`${card.connected} connected`"
                                            >
                                                <Icon name="check-circle" />
                                                <template v-if="card.connected > 1">{{ card.connected }}</template>
                                            </span>
                                            <span v-if="card.recommendation" class="text-2xs text-info" aria-label="Recommended">
                                                <Icon name="sparkles" />
                                            </span>
                                            <span
                                                v-if="card.entry.requires?.includes('devops') && !hasCapability('devops')"
                                                v-tooltip.top="`Requires DevOps`"
                                                class="text-2xs text-muted"
                                                aria-label="Requires DevOps"
                                            >
                                                <Icon name="lock" />
                                            </span>
                                            <CapabilityEffects :effects="badgeEffects(card.entry)" :compact="true" />
                                        </div>
                                        <!-- CLAMPED, not merely short. Card copy is authored to one line, but a card
                                         derives from any enabled extension's manifest — including one nobody here
                                         wrote — and a row is as tall as its tallest tile, so one long sentence
                                         used to inflate the two cards beside it. -->
                                        <div class="line-clamp-2 text-2xs text-muted">{{ card.entry.description }}</div>
                                        <!-- Derived from what is checked out in the workspace, so the claim comes
                                         with the thing that was read to make it rather than being asserted. The
                                         two lines this costs are spent only on the handful of cards the scan
                                         actually vouched for — a claim nobody can check is one nobody should act
                                         on, which is not a thing to hide behind a hover. -->
                                        <div v-if="card.recommendation" class="text-2xs text-info">{{ card.recommendation.reason }}</div>
                                        <div v-if="card.recommendation" class="truncate font-mono text-2xs text-subtle">
                                            {{ card.recommendation.evidence }}
                                        </div>
                                    </div>
                                </button>
                            </div>
                        </div>
                    </template>

                    <!-- Only ever reachable through the filter: every slice the rail offers has something in it.
                         So it answers the one question a reader has here, which is what they typed — and it
                         answers it about the list they are actually looking at, which under Connected is their
                         own connections and not the catalog. -->
                    <div v-if="nothingMatches" :class="cmp.emptyState()">
                        <p class="text-sm">Nothing in {{ activeScope.label }} matches “{{ search.trim() }}”.</p>
                        <p v-if="showingConnections" class="mt-1 text-xs text-muted">
                            Connections are searched by the name you gave them, by what they connect to, and by kind.
                        </p>
                        <p v-else class="mt-1 text-xs text-muted">
                            Capabilities are searched by name, by what they do, and by kind — “mcp”, “ssh”, “sql”.
                        </p>
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

            <!-- Guided browser login for one connected account (screencast a live Chromium the user signs into). -->
            <BrowserProfileDialog
                v-model:visible="profileVisible"
                :capability="profileCapability"
                :label="profileLabel"
                :mode="profileMode"
                @done="onBrowserDone"
            />

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
