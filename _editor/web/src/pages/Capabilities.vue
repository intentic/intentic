<script setup lang="ts">
import {
    type AddCapabilityInput,
    CAPABILITY_CATALOG,
    CAPABILITY_CATEGORIES,
    type CapabilityCatalogEntry,
    type CapabilityCategory,
    type CapabilityEffect,
    capabilityEffects,
} from "@intentic-app/capability-catalog";
import { type CapabilityProbe, type CapabilityRecommendation, type CapabilitySummary } from "@intentic-app/api-contract";
import {
    BrandMark,
    Button,
    ui,
    ConfirmDialog,
    FilterBar,
    type IconName,
    Notice,
    type NoticeModel,
    RowGroup,
    SegmentedControl,
    SplitView,
    StatusBadge,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { type CapabilityField, contributionDiscriminator } from "@intentic/extension-manifest";
import { type CapabilityKind, type ForticlientConnection } from "@intentic/sandbox-contract";
import { type ComputedRef, computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import BrowserProfileDialog from "../components/BrowserProfileDialog.vue";
import CapabilityFieldRow from "../components/CapabilityFieldRow.vue";
import ForticlientImport from "../components/ForticlientImport.vue";
import HostConnectDialog from "../components/HostConnectDialog.vue";
import PluginRegistryBrowse from "../components/PluginRegistryBrowse.vue";
import CapabilityConnections, { type CapabilityConnection, type CapabilityConnectionGroup } from "../components/CapabilityConnections.vue";
import CapabilityContext from "../components/CapabilityContext.vue";
import CapabilityEffects from "../components/CapabilityEffects.vue";
import CapabilityInstanceRow from "../components/CapabilityInstanceRow.vue";
import CapabilityRenameDialog from "../components/CapabilityRenameDialog.vue";
import CapabilityRail, { type CapabilityScope } from "../components/CapabilityRail.vue";
import { startAgent } from "../composables/agents/agentActions";
import { sandboxJson } from "../composables/sandbox/sandboxClient";
import { auditBrief, updateBrief } from "./sandbox/extensionBrief";
import { CATEGORY_ICONS, cardHaystack, contributedCards, entryIcon, instancesOf, suggestName, withIdentityPicker } from "./capabilities/cards";
import {
    type ConnectionState,
    awaitingLogin,
    connectionFacts,
    connectionState,
    rebuildStep,
    signsInByHand,
    vpnFacts,
} from "./capabilities/connections";
import { rememberedSecrets, rememberSecrets } from "./capabilities/devSecrets";
import {
    type StoredSecrets,
    buildConfig,
    cleanName,
    fieldConfig,
    fieldInvalid,
    fieldMissing,
    fieldVerified,
    forticlientAnswers,
    formComplete,
    inlineField,
    isCommitSha,
    keepsSecret,
    nameError,
    seedValues,
    shownFields,
} from "./capabilities/form";
import { type ConfSummary, containerUrlFix, expandPaste, normalizeFieldValue, summarisesWireguard, wireguardSummary } from "./capabilities/normalize";
import { HOST_PRESETS, hostGrantSummary, localModelMemorySummary, matchHostPreset, walletPolicySummary } from "./capabilities/previews";
import { probeCapability, useCapabilities } from "../composables/extensions/useCapabilities";
import { useExtensions } from "../composables/extensions/useExtensions";
import { useRegistry } from "../composables/extensions/useRegistry";
import { type BackgroundProcessRow, useBackgroundProcesses, viewProcessLogs } from "../composables/terminal/useBackgroundProcesses";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { useHostConnect } from "../composables/sandbox/useHostConnect";
import { useVpn } from "../composables/sandbox/useVpn";

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
 * it. The rail is bounded by CATEGORIES instead: see <CapabilityRail> for why that is the axis, and for the two
 * slices that cut across all of them.
 *
 * TWO THINGS NARROW THE GRID, AND EACH SITS ON WHAT IT NARROWS: the slice (the rail) and free text (the bar over
 * the grid, per <FilterBar>'s rule that the bar spans the list under it). Both live in the URL, so "the SQL cards"
 * and "everything I have connected" are links somebody can be sent. Picking a card is not a third filter but a
 * navigation: the config form takes the grid's place and the rail stays put, so abandoning a half-filled form for
 * another category is one click rather than a trip back out through the catalog.
 *
 * ONE SLICE IS NOT A SHORTER CATALOG. Connected asks a different question, not "which of these could I add" but
 * "what have I got", and a grid of cards answers it wrongly at every step: three SSH boxes collapse into one
 * tile, the names their owner typed are nowhere, and a connection that quietly needs signing in again looks
 * exactly like one that works. So that slice draws <CapabilityConnections> instead: the instances themselves,
 * named, addressed and stated. It is still the same page: same rail, same filter, same click into the same card
 *: it just stops pretending the reader is shopping.
 *
 * WHAT IS NOT IN THIS FILE, and why: the rules that hold whether or not a page is drawing them. A card's own
 * facts and the join to its live instances are in ./capabilities/cards, the add form's answers and refusals in
 * ./capabilities/form, and what a live connection is called and how it sorts in ./capabilities/connections:
 * that last one shared with the inventory, so a Reddit account cannot be "needs sign-in" in one list and
 * "pending" in the other. */

const { hasCapability, recommendationFor, capabilities, error: listError, add, remove, rename, refetch, dismissRecommendation } = useCapabilities();
const { contributionOf, enabled: enabledExtensions, extensions, settled: extensionsSettled } = useExtensions();
// VPN instances get live link state and connect/disconnect here too: the same daemon routes the Sandbox ▸
// Status card drives, so a tunnel dialled from either place reads identically in both.
const { links: vpnLinks } = useVpn();

// The identities the browser cards can be filed under: instance state, which the manifest cannot know.
const identityIds = computed(() => capabilities.value.filter((instance) => instance.kind === `identity`).map((instance) => instance.id));

// The full card list: what the enabled extensions contribute, then the static core cards.
const allCards = computed<CapabilityCatalogEntry[]>(() =>
    [...contributedCards(enabledExtensions.value), ...CAPABILITY_CATALOG].map((entry) => withIdentityPicker(entry, identityIds.value)),
);

const route = useRoute();
const router = useRouter();

// The picked card is URL-driven (/capabilities/<id>); an absent or unknown slug → undefined → the catalog grid.
const selected = computed<CapabilityCatalogEntry | undefined>(() => allCards.value.find((entry) => entry.id === route.params[`card`]));
const name = ref(``);
// Whether the user (or a marketplace pick) chose the name. Until then the field holds a suggestion, and the
// suggestion must track the LIVE list: pick() may run against a stale-hydrated or still-fetching list, and a
// frozen snapshot then collides ("already exists"), or worse, mints a stale-bumped id: once fresh data lands.
const nameEdited = ref(false);
/* THE NAME AS IT WILL BE SAVED, repaired rather than refused: "My GitHub" becomes `My-GitHub` and the box says
 * so underneath while the two differ (namePreview), instead of interrupting with the rule about hyphens. Every
 * consumer of the name (the collision check, completeness, the submit itself) reads THIS, so what the preview
 * promises is exactly what the daemon gets. Blur writes it back into the box, at which point the preview has
 * nothing left to say. */
const savedName = computed(() => cleanName(name.value));
const namePreview = computed(() => (savedName.value !== `` && savedName.value !== name.value.trim() ? savedName.value : undefined));

const instancesFor = (entry: CapabilityCatalogEntry): CapabilitySummary[] => instancesOf(entry, capabilities.value);
const selectedInstances = computed<CapabilitySummary[]>(() => (selected.value === undefined ? [] : instancesFor(selected.value)));

/* --- CHANGING A CONNECTION YOU ALREADY HAVE, on the card that made it ---
 *
 * The card's form was only ever an ADD form. Everything needed to edit was already here: the daemon's write is
 * an upsert, and every non-credential answer comes back on the list, but the only way in was to notice a line
 * of small print and re-type the connection's name exactly, so in practice a wrong gateway or a wrong routed
 * network meant removing the connection and setting it up again. For the kinds people most want to change (a
 * signed-in account, a paired machine, a tunnel) that is the one operation that throws away what makes them
 * worth keeping.
 *
 * IN THE URL, next to the card, for the same reason the card itself is: a reload lands back on what was being
 * edited, Back leaves the edit rather than the page, and the row that opened it is still on screen underneath.
 * `replace`, not `push`: stepping between two connections of one card is not a place in history.
 *
 * A ONE-PER-SANDBOX CARD IS ALWAYS EDITING, without a query: its single connection IS the card, there is no list
 * to pick from, and its form has updated in place since long before this existed. Both arms answer through
 * `editing`, so nothing downstream has to know which kind of card it is standing on. */
const editingId = computed<string>({
    get: () => (typeof route.query[`edit`] === `string` ? route.query[`edit`] : ``),
    set: (value) =>
        void router.replace({ name: `capabilities`, params: route.params, query: { ...route.query, edit: value === `` ? undefined : value } }),
});
/* THE ONE-PER-SANDBOX CARD HAS NO LIST, because it never had one: it had a list of one, which is a different
 * thing wearing a list's chrome. Docker is not an account you hold N of; it is a part of the sandbox that is
 * either on or off, and rendering "docker · active" as a bordered card above the form that configures that very
 * docker asked the reader to hold two objects where there is one. Its state belongs on the card's own heading,
 * beside its name, which is where a state that describes the whole screen goes. */
const soleInstance = computed<CapabilitySummary | undefined>(() => (selected.value?.singleton === true ? selectedInstances.value[0] : undefined));
// The connection the form is over, or undefined while it is adding one. An `edit` naming a connection this card
// does not hold (a stale link, a connection removed in another tab) falls back to adding rather than to a form
// over nothing.
const editing = computed<CapabilitySummary | undefined>(
    () => soleInstance.value ?? selectedInstances.value.find((instance) => instance.id === editingId.value),
);

/* THE CREDENTIALS THIS FORM IS KEEPING, which is a fact about the SESSION rather than about the connection.
 *
 * It starts as what the connection holds (the daemon names them without sending them) and is emptied by anything
 * that means "these answers are for a different connection now": importing a FortiClient profile over an open
 * edit, above all, where keeping the old password would silently dial the new gateway with the wrong credential.
 * Typing into a box takes it out of the set by itself: a non-empty value is not a kept one. */
const keptSecrets = ref<StoredSecrets>(new Set<string>());

// --- the connection's background process (a gateway's liveness, where the user forms the intent) ---
// A connector that relays events (Discord, IMAP) only works while its extension's gateway runs, and "my bot
// went quiet" sends people to the connector, not to a process list behind the terminal panel. So the same
// rows the panel's popover shows render here too, scoped to the extension serving THIS card.
const { rows: processRows, busy: processBusy, start: startProcess, stop: stopProcess } = useBackgroundProcesses();

// The extension that runs an instance's processes: an extension-kind capability IS the extension; a connector
// instance is served by whichever extension declares its provider (resolved per INSTANCE, not per card: the
// SQL card owns two providers, and they need not come from the same extension).
const ownerExtensionId = (instance: CapabilitySummary): string | undefined => {
    if (instance.kind === `extension`) {
        return instance.id;
    }
    const provider = String(instance.config[contributionDiscriminator(instance.kind) ?? ``]);
    return enabledExtensions.value.find((extension) =>
        (extension.manifest.contributes?.capabilities ?? []).some(
            (contribution) => contribution.kind === instance.kind && contribution.id === provider,
        ),
    )?.id;
};

// Empty until something is actually connected: a declared-but-idle gateway on a card you never configured is
// noise, not health. Several instances of one provider share a single gateway, hence the owner set.
const cardProcesses = computed<BackgroundProcessRow[]>(() => {
    const owners = new Set(selectedInstances.value.map(ownerExtensionId).filter((id) => id !== undefined));
    return processRows.value.filter((row) => row.extensionId !== undefined && owners.has(row.extensionId));
});

/* THE TYPED NAME IS ALREADY TAKEN, which is now a refusal rather than a quiet update.
 *
 * It used to mean "save over that connection", and that was the only way to change one at all: a line of small
 * print under the box, and a submit button that changed its word. It was also a trap in the direction that
 * costs: an add form is seeded with a card's DEFAULTS, so re-typing a live connection's name and saving wrote
 * the defaults over its settings. Now that the row itself opens for editing, the honest answer to a name that
 * exists is to say so and point at it. */
const nameCollision = computed(() => editing.value === undefined && selectedInstances.value.some((instance) => instance.id === savedName.value));

/* --- what the rail slices the catalog by, and what the grid then shows ---
 * Every card with the facts all three panes read off it. Computed once here rather than per tile per render: the
 * grid used to call instancesOf() three times per card while drawing it, which is a scan of every capability in
 * the sandbox per call. The INSTANCES ride along rather than just their count, because the Connected slice lists
 * them one by one and re-deriving them there would be that same scan a fourth time. */
interface CatalogCard {
    readonly entry: CapabilityCatalogEntry;
    readonly instances: readonly CapabilitySummary[];
    readonly connected: number;
    readonly recommendation: CapabilityRecommendation | undefined;
}

const cards = computed<CatalogCard[]>(() =>
    allCards.value.map((entry) => {
        const instances = instancesFor(entry);
        return { entry, instances, connected: instances.length, recommendation: recommendationFor(entry.id) };
    }),
);
const connectedCards = computed<CatalogCard[]>(() => cards.value.filter((card) => card.connected > 0));
const recommendedCards = computed<CatalogCard[]>(() => cards.value.filter((card) => card.recommendation !== undefined));
// Connections, not cards: the Connected row's number is what the list it opens is long, and one card can hold
// several (two Reddit accounts, three SSH boxes). Kept here beside the cards it counts; the rows themselves are
// built further down, where the per-kind facts they carry are in scope.
const connectionCount = computed(() => cards.value.reduce((total, card) => total + card.connected, 0));

// The slices the rail offers on top of the categories, and the spelling of "no slice at all".
const ALL = ``;
const CONNECTED = `connected`;
const RECOMMENDED = `recommended`;

const scopeOf = (key: string, label: string, icon: IconName, subset: readonly { connected: number }[]): CapabilityScope => ({
    key,
    label,
    icon,
    total: subset.length,
    connected: subset.filter((card) => card.connected > 0).length,
});

const countOf = (total: number, one: string, many: string): string => `${total} ${total === 1 ? one : many}`;

const allScope = computed<CapabilityScope>(() => scopeOf(ALL, `All capabilities`, `bolt`, cards.value));
// Counts CONNECTIONS rather than cards, so its number matches the list it opens; `meta` spells that out for the
// tooltip, which would otherwise read the two figures as cards.
const connectedScope = computed<CapabilityScope>(() => ({
    key: CONNECTED,
    label: `Connected`,
    icon: `check-circle`,
    total: connectionCount.value,
    connected: connectionCount.value,
    meta: `${countOf(connectionCount.value, `connection`, `connections`)} across ${countOf(connectedCards.value.length, `capability`, `capabilities`)}`,
}));
// Each cross-cutting row exists only while it has something in it: "Connected 0" on a fresh sandbox promises a
// page that turns out to be empty, and "Recommended 0" reads as the workspace scan having failed.
const pinnedScopes = computed<CapabilityScope[]>(() => {
    const scopes = [allScope.value];
    if (connectedCards.value.length > 0) {
        scopes.push(connectedScope.value);
    }
    if (recommendedCards.value.length > 0) {
        scopes.push(scopeOf(RECOMMENDED, `Recommended`, `sparkles`, recommendedCards.value));
    }
    return scopes;
});
// A category with no cards is not a row: several of them are empty until the extension that fills them is enabled.
const categoryScopes = computed<CapabilityScope[]>(() =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const subset = cards.value.filter((card) => card.entry.category === category.id);
        return subset.length === 0 ? [] : [scopeOf(category.id, category.label, CATEGORY_ICONS[category.id], subset)];
    }),
);

/* WHAT SURVIVES LEAVING THIS CARD: the slice and the filter, which describe where the reader is in the catalog,
 * and the walk. Not the connection being edited: that names a connection of the card being left, and means
 * nothing on the next one or on the grid. Carried along, it would open the next card straight into an edit of
 * something it does not hold, or (worse) of something it does. */
const elsewhere = () => ({ ...route.query, edit: undefined });

/* THE SLICE AND THE SEARCH LIVE IN THE URL, replaced rather than pushed: Back should undo opening a card, not
 * each letter of a filter. Derived from the query rather than mirrored into refs, so there is one direction of
 * flow and no watcher pair to fight over what is shown. Writing either drops the `card` param: picking a category
 * while a form is open means "show me that category", not "keep me here". */
const queryParam = (key: string) =>
    computed<string>({
        get: () => (typeof route.query[key] === `string` ? route.query[key] : ``),
        set: (value) => void router.replace({ name: `capabilities`, query: { ...elsewhere(), [key]: value === `` ? undefined : value } }),
    });
const scope = queryParam(`category`);
const search = queryParam(`q`);

// An unknown slice (a stale link, or Connected after the last capability was removed) falls back to everything
// rather than to a blank grid, which the rail offers no row to get back from.
const activeScope = computed<CapabilityScope>(
    () => [...pinnedScopes.value, ...categoryScopes.value].find((entry) => entry.key === scope.value) ?? allScope.value,
);
const railScope = computed<string>({ get: () => activeScope.value.key, set: (value) => (scope.value = value) });
const inCategory = computed(() => categoryScopes.value.some((entry) => entry.key === activeScope.value.key));

// The cards a slice covers. Connected covers them too: it just draws them as the CONNECTIONS inside them
// rather than as tiles (see `connectionGroups`), so nothing downstream of here renders in that slice. Anything
// that is not one of these three is a category.
const SLICES: Readonly<Record<string, ComputedRef<CatalogCard[]>>> = { [ALL]: cards, [CONNECTED]: connectedCards, [RECOMMENDED]: recommendedCards };
const inScope = computed<CatalogCard[]>(
    () => SLICES[activeScope.value.key]?.value ?? cards.value.filter((card) => card.entry.category === activeScope.value.key),
);

const visibleCards = computed<CatalogCard[]>(() => {
    const needle = search.value.trim().toLowerCase();
    if (needle === ``) {
        return inScope.value;
    }
    return inScope.value.filter((card) => cardHaystack(card.entry).includes(needle));
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
const SLICE_DESCRIPTIONS: Readonly<Record<string, string>> = {
    [CONNECTED]: `Every connection your agent can reach right now. Open one to change it, to add another of the same kind, or to take it away.`,
    [RECOMMENDED]: `Suggested from what is checked out in your workspace, each one is something your own code already asks for.`,
};
const CATALOG_DESCRIPTION = `Grow your sandbox: each capability gives your agent new tools or connects your accounts. Everything is stored only in your sandbox.`;
const description = computed(
    () =>
        SLICE_DESCRIPTIONS[activeScope.value.key] ??
        CAPABILITY_CATEGORIES.find((category) => category.id === activeScope.value.key)?.hint ??
        CATALOG_DESCRIPTION,
);

watch(capabilities, () => {
    if (selected.value === undefined || nameEdited.value || editing.value !== undefined) {
        return;
    }
    name.value = suggestName(selected.value, selectedInstances.value);
});

const values = reactive<Record<string, string>>({});
const submitting = ref(false);
const error = ref<NoticeModel | null>(null);
// undefined = the confirm dialog is closed; a string = the capability id awaiting a confirmed removal.
const confirmRemoveId = ref<string>();
// --- inline validation (touched-on-blur, alarmed-on-submit) ---
// A field key appears here after the user has interacted with it (blur), so errors show only after they leave.
const touched = reactive(new Set<string>());
// A submit has been attempted and refused: the moment emptiness stops being "not yet" and starts being "this
// is what's blocking you", which is when (and only when) a required-but-empty field turns red.
const attempted = ref(false);
const shaking = ref(false);
const markTouched = (key: string): void => {
    touched.add(key);
};
const finishName = (): void => {
    if (namePreview.value !== undefined) {
        name.value = savedName.value;
    }
    markTouched(`name`);
};

/* Blur is when a field's value is DONE, so it is when the quiet repairs run: trim the pasted newline off a
 * token, put the scheme on a bare host, keep only the digits of a port. Written back into the box, so the
 * correction is something the reader sees rather than something the submit does behind their back. */
const finishField = (field: CapabilityField): void => {
    values[field.key] = normalizeFieldValue(field, values[field.key] ?? ``);
    markTouched(field.key);
};

// The one-line accounts of what a paste was unpacked into, keyed by the field that took the paste.
const pasteNotes = reactive<Record<string, string>>({});
const onFieldInput = (field: CapabilityField): void => {
    // Editing a field by hand outdates the story about what was pasted into it.
    delete pasteNotes[field.key];
};
/* A paste that RECOGNISABLY holds more than the one box asks for (an ssh command, a connection string, a repo
 * deep link, a mail address with a well-known provider) answers every box it can, and says what it read where
 * the paste landed. Anything unrecognised falls through to the ordinary paste it always was. */
const onFieldPaste = (field: CapabilityField, event: ClipboardEvent): void => {
    const entry = selected.value;
    const text = event.clipboardData?.getData(`text`) ?? ``;
    if (entry === undefined || text.trim() === ``) {
        return;
    }
    const expansion = expandPaste(entry, field, values, text);
    if (expansion === undefined) {
        return;
    }
    event.preventDefault();
    Object.assign(values, expansion.values);
    pasteNotes[field.key] = expansion.summary;
};

/* The refusals, over the form as it stands right now, split by severity. `fieldAlarm` is the red treatment: a
 * malformed value that is actually there, or (after a refused submit) a required box still empty. `fieldQuiet`
 * is the muted "Required" for an empty box merely tabbed past: nothing has gone wrong yet, and the form should
 * not sound like it has. */
const nameProblem = computed<string | undefined>(() => nameError(name.value));
const fieldAlarm = (field: CapabilityField): string | undefined => {
    if (!touched.has(field.key) && !attempted.value) {
        return undefined;
    }
    const invalid = fieldInvalid(field, values[field.key], keptSecrets.value);
    if (invalid !== undefined) {
        return invalid;
    }
    return attempted.value && fieldMissing(field, values[field.key], keptSecrets.value) ? `This field is required.` : undefined;
};
const fieldQuiet = (field: CapabilityField): boolean =>
    !attempted.value && touched.has(field.key) && fieldMissing(field, values[field.key], keptSecrets.value);
// The green check beside a label, for the values a rule can genuinely vouch for (a URL that parses, a full
// sha, a port in range): the moment the reader would otherwise squint at what they pasted.
const fieldChecked = (field: CapabilityField): boolean => fieldVerified(field, values[field.key]);
// The localhost trap's one-click way out: defined exactly while a URL box points at the container itself.
const fieldUrlFix = (field: CapabilityField): string | undefined => containerUrlFix(field, values[field.key]);
const applyUrlFix = (field: CapabilityField): void => {
    const fix = fieldUrlFix(field);
    if (fix !== undefined) {
        values[field.key] = fix;
    }
};
// What a WireGuard blob actually holds, read live so the check happens in the box, not after a failed connect.
const fieldConfSummary = (field: CapabilityField): ConfSummary | undefined => {
    const entry = selected.value;
    return entry !== undefined && summarisesWireguard(entry, field) ? wireguardSummary(values[field.key]) : undefined;
};
// A credential box the reader may leave alone, because one is already stored behind it. It says so in its own
// placeholder rather than in prose above the form: the question "do I have to find this again?" is asked of one
// box at a time, and answered where the eye already is.
const keptField = (field: CapabilityField): boolean => keepsSecret(field, values[field.key], keptSecrets.value);
/* WHAT AN EMPTY CREDENTIAL BOX SAYS. On an add, whatever the card wrote. On an edit of a connection that
 * already holds this one: that it is there, that it is not being shown, and that leaving the box alone keeps
 * it: three facts in the space where "paste your token" would otherwise sit and imply the opposite.
 *
 * The dots are the whole point of the wording. A box that merely said "leave blank to keep" still LOOKS empty,
 * and an empty required-looking box next to a Save button is what sends people off to find a credential they
 * did not need. */
const fieldPlaceholder = (field: CapabilityField): string | undefined =>
    keptField(field) ? `•••••••••••• already set, leave blank to keep it` : field.placeholder;
// The fields on screen for a card: const-valued ones are baked into the config, `when`-gated ones come and go
// as the user toggles the mode they hang off.
const formFields = (entry: CapabilityCatalogEntry): readonly CapabilityField[] => shownFields(entry, values);
/* THE FORM'S TWO TIERS. Main fields are the card's actual questions; advanced ones are the answers whose
 * default is right for nearly everyone (a registry mirror, an IKE version), folded behind one quiet line so a
 * card's length is what it asks, not what it could be asked. The disclosure's state is decided when the form
 * seeds (below): open while any advanced field holds a non-default value, because an edit must never hide the
 * settings it is standing on. */
const mainFields = (entry: CapabilityCatalogEntry): readonly CapabilityField[] => formFields(entry).filter((field) => field.advanced !== true);
const advancedFields = (entry: CapabilityCatalogEntry): readonly CapabilityField[] => formFields(entry).filter((field) => field.advanced === true);
const advancedOpen = ref(false);
// A browser card's folded fields are one specific offer, not "advanced": stored credentials the daemon can
// type into the site's own login for the agent. Named as what they are.
const advancedLabel = (entry: CapabilityCatalogEntry): string => (entry.kind === `browser` ? `Let the agent sign in for you (optional)` : `Advanced`);
const advancedDefault = (field: CapabilityField): string => field.default ?? (field.boolean === true ? `off` : ``);

/* WHAT THE ANSWERS ADD UP TO, said back while they are given (see ./capabilities/previews). The wallet's
 * numbers compose into a spending policy and the local model's two choices into a RAM bill: each was a
 * paragraph of prose asking the reader to do the composition themselves. A computed sentence is shorter,
 * always current, and is the actual thing the submit agrees to. */
const formSummary = computed<string | undefined>(() => {
    if (selected.value?.kind === `wallet`) {
        return walletPolicySummary(values);
    }
    if (selected.value?.kind === `localmodel`) {
        return localModelMemorySummary(values);
    }
    return undefined;
});

/* A connected computer's grant, driven as a posture rather than six switches: the preset row sets them all,
 * the sentence states what they currently spell (in the same words the connect dialog and the row will use),
 * and the switches stay underneath for fine-tuning. A hand-tuned mix matches no preset and the row shows it
 * by holding nothing selected. */
const hostPresetOptions = HOST_PRESETS.map((preset) => ({ value: preset.key, label: preset.label }));
const applyHostPreset = (key: string): void => {
    const preset = HOST_PRESETS.find((candidate) => candidate.key === key);
    if (preset !== undefined) {
        Object.assign(values, preset.grants);
    }
};

/* The live-browser window for a browser-kind capability (the session is a real logged-in browser, not a pasted
 * token, so it lives out-of-band over the /system/browser-profile WebSocket). Two things open it and one
 * component serves both: signing the account in, and (once it IS signed in) the user taking that same browser
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

// A completed login flips the capability's status pending → active; refresh the list so it shows.
const onBrowserDone = (): void => {
    void refetch();
};

const touchAll = (): void => {
    touched.add(`name`);
    if (selected.value === undefined) {
        return;
    }
    for (const field of formFields(selected.value)) {
        touched.add(field.key);
    }
};
// A card with no `requires` has them all met: the gate below only ever asks about a card that is open.
const requiresMet = computed(() => (selected.value?.requires ?? []).every((kind) => hasCapability(kind)));

// --- effect derivation (the "This will add to your sandbox" disclosure) ---
// The contribution behind a config, via its kind's pinned discriminator: what capabilityEffects reads a card's
// secret/image declarations from. Undefined for a kind whose cards carry none (agent) or a core-only kind.
const contributionFor = (kind: CapabilityKind, config: Record<string, string | number | boolean | undefined>) => {
    const key = contributionDiscriminator(kind);
    if (key === undefined) {
        return undefined;
    }
    return contributionOf(kind, String(config[key] ?? ``));
};
// Live over the form state, so the plugin clone URL tracks as the user types. A selected contributed card
// exists only because its extension is enabled (allCards derives it), so contributionOf always resolves here:
// the effects panel is complete by construction.
const liveEffects = computed<readonly CapabilityEffect[]>(() => {
    const entry = selected.value;
    if (entry === undefined) {
        return [];
    }
    const config = fieldConfig(entry, (field) => (values[field.key] ?? ``).trim());
    return capabilityEffects({ kind: entry.kind, id: name.value.trim() || undefined, config, contribution: contributionFor(entry.kind, config) });
});
// The consequential effects a card statically implies, badged on its grid tile: the full list is one click
// away. Defaults decide config-dependent ones (the SQL card's default engine).
const BADGED_EFFECTS = new Set([`image`, `runtime`, `trusted-code`]);
const badgeEffects = (entry: CapabilityCatalogEntry): readonly CapabilityEffect[] => {
    const config = fieldConfig(entry, (field) => field.default);
    return capabilityEffects({ kind: entry.kind, config, contribution: contributionFor(entry.kind, config) }).filter((effect) =>
        BADGED_EFFECTS.has(effect.kind),
    );
};
// A connected instance's effects from its secret-stripped config echo; an installed extension also resolves
// its manifest so process/image contributions show. Not rendered any more: the effects a card implies are
// stated once beside the form (<CapabilityContext>), not repeated under every connection of it, but still
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
// The grant in the machine's own words, read from the same effects the card renders, so the dialog's sentence
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

const canSubmit = computed(
    () =>
        selected.value !== undefined &&
        requiresMet.value &&
        !nameCollision.value &&
        formComplete(selected.value, values, name.value, keptSecrets.value),
);

/* The two numbers on the Extension card's signpost, read from whatever the registry cache already holds
 * (`read: false`, see useRegistry). This page must not clone a repository to put a figure in a sentence, so
 * the counts are absent until something has genuinely browsed, and the sentence reads fine without them. */
const { entries: publishedExtensions } = useRegistry({ read: false });
const publishedCount = computed(() => publishedExtensions.value.length);
const verifiedCount = computed(() => publishedExtensions.value.filter((entry) => entry.trust === `verified`).length);

// A registry row picked in <PluginRegistryBrowse>, as answers to this form.
const applyRegistryPick = (answers: { name: string; url: string; ref: string; path: string; token: string }): void => {
    name.value = answers.name;
    nameEdited.value = true;
    values[`url`] = answers.url;
    values[`ref`] = answers.ref;
    values[`path`] = answers.path;
    values[`token`] = answers.token;
};

/* THE PRE-INSTALL READ. The install dialog shows what the manifest declares and the registry's checks say the
 * thing loads; what neither can say is whether the code does what the description claims and nothing else. The
 * one party with perfect incentives to answer that is the owner's own agent, reading the exact commit cold:
 * so an extension form holding a pinned commit offers to start that read as an ordinary chat.
 *
 * Offered exactly when there is a commit to read: the audit's whole subject is the sha the install would pin,
 * and reading a branch instead would produce a confident account of code nobody is about to run. The gate does
 * not move: installing stays the same approval, made by the same person, with an account of the code in front
 * of them instead of a description written by the person selling it. */
const auditable = computed(() => selected.value?.kind === `extension` && isCommitSha(values[`ref`]) && (values[`url`] ?? ``) !== ``);
/* When the form is about to REPLACE an installed commit rather than add a first one, the sharper read is the
 * diff: the installed sha was approved once already, and what an update asks the owner to judge is what sits
 * between the two. That is exactly an EDIT of an installed extension: the form is open over the entry whose
 * sha is about to move. */
const updateFrom = computed<string | undefined>(() => {
    if (!auditable.value || editing.value === undefined) {
        return undefined;
    }
    const installed = editing.value.config[`ref`];
    if (typeof installed !== `string` || !isCommitSha(installed) || installed === values[`ref`]) {
        return undefined;
    }
    return installed;
});
const startAudit = (): void => {
    const typed = name.value.trim();
    const shared = { label: typed === `` ? String(values[`url`]) : typed, url: String(values[`url`]), path: String(values[`path`] ?? ``) };
    if (updateFrom.value === undefined) {
        startAgent(auditBrief({ ...shared, ref: String(values[`ref`]) }));
        return;
    }
    startAgent(updateBrief({ ...shared, fromRef: updateFrom.value, toRef: String(values[`ref`]) }));
};

/* --- THE CONNECTED SLICE: an inventory, not a catalog with the unconnected cards taken out ---
 *
 * See <CapabilityConnections> for why this is a list of INSTANCES. What lives here rather than in the component
 * is everything that needs the page's own sources: the host roster, the vpn links, the daemon's pending detail
 *, so the component stays a renderer of rows somebody else decided the meaning of.
 *
 * `connectionCount` is up beside the cards because the rail needs only the number; the rows themselves wait
 * until the per-kind sources they read are in scope. */

// A tunnel's live address and what it routes, which no stored config can answer.
const vpnAddress = (id: string): string | undefined => vpnFacts(id, vpnLinks.value);
// A connection's state, with the machine roster's answer folded in where there is one.
const rowState = (entry: CapabilityCatalogEntry, instance: CapabilitySummary): ConnectionState =>
    connectionState(entry.kind, instance, hostFor(instance.id)?.online);

/* One row per live connection, carrying its category so the list groups the way the catalog does and a haystack
 * so the filter over it searches the things a row actually shows. That haystack is the reason the bar keeps
 * working when the slice changes under it: in the catalog "acme" matches nothing, and here it has to find the
 * box called ops-box at ops.acme.dev: the name its owner typed and the address they typed are the two things
 * they would search for, and neither is in any card's prose. */
type ConnectionRow = CapabilityConnection & { readonly category: CapabilityCategory; readonly rank: number; readonly haystack: string };

const connectionRow = (card: CatalogCard, instance: CapabilitySummary): ConnectionRow => {
    const state = rowState(card.entry, instance);
    const facts = (card.entry.kind === `vpn` ? vpnAddress(instance.id) : undefined) ?? connectionFacts(instance);
    // A connection nobody named took the card's id (suggestName), and "docker" written under a Docker logo with
    // "Docker" beneath it is the same word three times. Where the name IS the card, the card is the name, and
    // the line under it is free for the facts that actually differ.
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
        // Only where something is actually outstanding: the daemon writes these for a reader ("Not connected",
        // "Needs a sandbox rebuild"), and echoing one beside a working connection would turn a status into noise.
        note: state.rank <= 1 ? instance.status.detail : undefined,
        code: state.rank <= 1 ? instance.status.code : undefined,
        category: card.entry.category,
        rank: state.rank,
        haystack: `${instance.id} ${card.entry.name} ${card.entry.kind} ${facts}`.toLowerCase(),
    };
};

const connections = computed<ConnectionRow[]>(() => cards.value.flatMap((card) => card.instances.map((instance) => connectionRow(card, instance))));

const visibleConnections = computed<ConnectionRow[]>(() => {
    const needle = search.value.trim().toLowerCase();
    if (needle === ``) {
        return connections.value;
    }
    return connections.value.filter((row) => row.haystack.includes(needle));
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

// Which of the two the grid pane is showing, and how much of it: the filter bar's count follows whichever list
// is under it, because a number that counts something else is worse than no number.
const showingConnections = computed(() => activeScope.value.key === CONNECTED);
const visibleCount = computed(() => (showingConnections.value ? visibleConnections.value.length : visibleCards.value.length));
const nothingMatches = computed(() => (showingConnections.value ? connectionGroups.value.length === 0 : groupedCatalog.value.length === 0));

/* --- AND THE SAME CONNECTION SEEN FROM INSIDE ITS CARD ---
 * The Connected slice above lists every connection in the sandbox; a card's own view lists the ones that came
 * from THAT card, which is where they are also acted on (see <CapabilityInstanceRow>). Two surfaces, one
 * vocabulary: both read their state from connectionState(), so a Reddit account cannot be "needs sign-in" in the
 * inventory and "pending" on its card.
 *
 * What the card's rows need on top is the two live facts a stored config cannot answer: the address a tunnel
 * was actually given, the OS a machine actually reported. connectionFacts() is the fallback for everything
 * else, so a Postgres row still names its host and database. */
const cardRowFacts = (instance: CapabilitySummary): string => {
    if (selected.value?.kind === `vpn`) {
        return vpnAddress(instance.id) ?? connectionFacts(instance);
    }
    if (selected.value?.kind === `host`) {
        return hostFor(instance.id)?.facts?.os ?? connectionFacts(instance);
    }
    return connectionFacts(instance);
};

// The one step a row cannot offer itself: a rebuild, which happens on the Sandbox screen.
const soleRebuildStep = (instance: CapabilitySummary): boolean => rebuildStep(selected.value?.kind, instance);

// A file that misses the FortiClient import zone would otherwise navigate this tab to the file itself, taking a
// half-filled form with it. Swallow file drags page-wide: the zone's own handler runs first and still gets its
// file.
const swallowFileDrag = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes(`Files`) === true) {
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

/* Fill the form from an imported FortiClient connection. Credentials are never among them (FortiClient encrypts
 * them with a machine-bound key), so the user still types the secret: `needs` is what tells them which fields
 * are waiting.
 *
 * AND IT DROPS THE KEPT SET, which matters only over an open edit and matters absolutely there: the passwords
 * this form was keeping belong to the gateway that is being replaced. Left standing, a blank password box would
 * still mean "keep", and the save would dial the imported gateway with the previous one's credential: the same
 * wrong-credential trap the blanking below exists to close, one level up. */
const pickForticlient = (connection: ForticlientConnection): void => {
    name.value = connection.id;
    nameEdited.value = true;
    keptSecrets.value = new Set<string>();
    Object.assign(values, forticlientAnswers(selected.value?.fields ?? [], connection));
    // The fields still needed are the ones to land on, not the top of the form.
    touched.clear();
};

/* --- TRY IT BEFORE SAVING IT ---
 *
 * The one question a form full of hostnames and tokens cannot answer about itself: does any of this reach the
 * thing. Answered by the daemon dialling the service the way the connection would (capabilities/probe.ts), and
 * shown as the service's own words: "Reached GitHub, authenticated as ada", or the exact refusal. Which is
 * what turns the guide beside the form from required reading into a fallback: the reader can simply find out.
 *
 * Offered only where a check exists. A `checked: false` answer retires the button for this card rather than
 * printing "cannot verify", because not-testable is not a failure and must not be dressed as one: an ssh box,
 * a paired computer and a signed-in browser are all connections whose test IS the thing itself. */
const probing = ref(false);
const probeResult = ref<CapabilityProbe>();
// Hidden once a card has answered "no test exists": the button would only ever say so again.
const canProbe = computed(() => selected.value !== undefined && probeResult.value?.checked !== false);
const runProbe = async (): Promise<void> => {
    const entry = selected.value;
    if (entry === undefined || probing.value) {
        return;
    }
    probing.value = true;
    probeResult.value = undefined;
    try {
        probeResult.value = await probeCapability({
            id: savedName.value || entry.id,
            kind: entry.kind,
            config: buildConfig(entry, values, keptSecrets.value),
        });
    } catch (caught) {
        error.value = noticeFrom(caught, `Could not test that connection.`);
    } finally {
        probing.value = false;
    }
};

const clearForm = (): void => {
    name.value = ``;
    nameEdited.value = false;
    for (const key of Object.keys(values)) {
        delete values[key];
    }
    for (const key of Object.keys(pasteNotes)) {
        delete pasteNotes[key];
    }
    probeResult.value = undefined;
    keptSecrets.value = new Set<string>();
    error.value = null;
    touched.clear();
    attempted.value = false;
    shaking.value = false;
};

/* One init path for a click, a deep link, and stepping from one connection of a card to another: (re)seed the
 * form whenever the URL changes what it is over. Watching the CONNECTION as well as the card is what makes an
 * edit reachable by link: /capabilities/vpn?edit=office lands on the same form the row's menu opens.
 *
 * Keyed by the two IDS rather than by the objects they name, and that is load-bearing: both are computed off the
 * live capability list, so every refetch of it hands back fresh objects, and a watch on those would empty a
 * half-filled form each time a pending connection was polled. What has to re-seed the form is the URL pointing
 * somewhere else, which is exactly what a changed id is. */
watch(
    [() => selected.value?.id, () => editing.value?.id],
    () => {
        const entry = selected.value;
        const instance = editing.value;
        if (entry === undefined) {
            return;
        }
        clearForm();
        /* Editing keeps the connection's own name; adding pre-fills a free one: the provider id for the first
         * connection, `<id>-2` etc. for the next, so re-adding creates another rather than overwriting the
         * first. The name is not editable either way: renaming a connection moves state a form cannot (see
         * askRename), so it is its own dialog and this field would be a second, lossy way to do it. */
        name.value = instance?.id ?? suggestName(entry, instancesFor(entry));
        // The connection's echoed config is the seed when there is one; dev autofill (inert in prod) lands on
        // top. Its credentials are not in there and never will be: `keptSecrets` is how the form knows they
        // exist, so the boxes for them can say "already set" instead of "fill me in".
        Object.assign(values, seedValues(entry, instance?.config, recommendationFor(entry.id)?.prefill ?? {}), rememberedSecrets(entry));
        keptSecrets.value = new Set(instance?.secrets ?? []);
        // The Advanced fold's opening state: open while anything in it differs from its default (a live
        // connection's changed mirror, a scan's prefill), because an edit must never hide what it stands on.
        advancedOpen.value = entry.fields.some((field) => field.advanced === true && (values[field.key] ?? ``) !== advancedDefault(field));
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
            void router.replace({ name: `capabilities`, query: elsewhere() });
        }
    },
    { immediate: true },
);

// Picking a card / going back is a navigation now: the URL is the source of truth for what's shown. The query
// rides along both ways (minus the edit: see `elsewhere`), so going back lands on the slice the card was picked
// out of rather than on the whole catalog with the filter thrown away.
const openCard = (card: string): void => {
    void router.push({ name: `capabilities`, params: { card }, query: elsewhere() });
};
const pick = (entry: CapabilityCatalogEntry): void => {
    openCard(entry.id);
};

const back = (): void => {
    void router.push({ name: `capabilities`, query: elsewhere() });
};

// Open a connection of the card already on screen, and close it again. `replace` (see editingId): stepping
// between two connections of one card is not a place in history, and Back should leave the card.
const openEdit = (id: string): void => {
    editingId.value = id;
};
// The same landing, from the Connected inventory, which is a click AWAY from this card rather than on it, so
// it pushes, carrying which connection the row was, and Back returns to the list it was picked out of.
const openConnection = (card: string, connection: string): void => {
    void router.push({ name: `capabilities`, params: { card }, query: { ...elsewhere(), edit: connection } });
};
const stopEditing = (): void => {
    editingId.value = ``;
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

// The card to land on after this one is dealt with, read BEFORE the change that deals with it: after a connect
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
            ? { name: `capabilities`, query: { ...elsewhere(), setup: undefined } }
            : { name: `capabilities`, params: { card }, query: elsewhere() },
    );
};
const startSetup = (): void => {
    const first = walkQueue.value[0];
    if (first !== undefined) {
        void router.push({ name: `capabilities`, params: { card: first.id }, query: { ...elsewhere(), setup: SETUP } });
    }
};
const skip = (): void => {
    if (selected.value !== undefined) {
        goNext(nextAfter(selected.value));
    }
};
// Where a card that is done with goes: on through the walk, or back to the slice it was picked out of.
const leaveCard = (next: string | undefined): void => {
    if (walking.value) {
        goNext(next);
        return;
    }
    back();
};

const selectedRecommendation = computed(() => (selected.value === undefined ? undefined : recommendationFor(selected.value.id)));

// "Not needed": the suggestion goes quiet until its evidence changes, which is what keeps the Recommended
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
    leaveCard(next);
};

/* AN APPLY THAT ENDS `pending` HAS NOT FINISHED SETTING THE CAPABILITY UP, and going back to the catalog is what
 * stranded it: the reader lands in front of a grid, with a capability that has quietly gone pending and nothing
 * on screen saying what remains. The card they were just on already says it: the instance row's hint names the
 * missing step and leads to it, in all three flavours (a machine's one-liner, a browser's login, a sandbox
 * rebuild). So: pending stays, finished goes back.
 *
 * The two whose missing step is a DIALOG on this very card open it outright rather than leaving a hint to click,
 * because the reader is standing there waiting for exactly that. The rebuild flavour cannot: it lives on the
 * Sandbox screen, and deliberately does not get a bar or a redirect for it: a standing condition belongs on the
 * sandbox chip that already carries it (see sandboxAttention.ts), and the row's link is the hand-off. */
const handOff = (entry: CapabilityCatalogEntry, added: CapabilitySummary): void => {
    // A machine that has never checked in is waiting on the one-liner. One that HAS is merely asleep, and a
    // fresh pairing is not what wakes it: the same distinction the row's button draws when it says Reconnect.
    if (entry.kind === `host` && hostFor(added.id)?.lastSeen === undefined) {
        openConnect(added);
        return;
    }
    // An identity's sign-in is the ONE login the owner does by hand: open the window right away, exactly like
    // a fresh account's.
    if (signsInByHand(entry.kind) && awaitingLogin(added)) {
        openBrowser(added.id, added.id);
    }
};

const submit = async (): Promise<void> => {
    const entry = selected.value;
    if (entry === undefined || submitting.value) {
        return;
    }
    // Mark every field touched, and raise the alarm tier: from here on a required-but-empty box is the thing
    // actually blocking the reader, and is allowed to say so in red.
    touchAll();
    if (!canSubmit.value) {
        attempted.value = true;
        // A refusal the reader cannot see is a form that looks broken: if what blocks the submit sits in the
        // Advanced fold, open it.
        if (
            advancedFields(entry).some(
                (field) =>
                    fieldMissing(field, values[field.key], keptSecrets.value) ||
                    fieldInvalid(field, values[field.key], keptSecrets.value) !== undefined,
            )
        ) {
            advancedOpen.value = true;
        }
        shaking.value = false;
        void nextTick(() => {
            shaking.value = true;
        });
        return;
    }
    submitting.value = true;
    error.value = null;
    /* One write for both, because the daemon's is one write: adding and editing are the same upsert over the
     * same id. The only difference is what a blank credential box means, and `keptSecrets` is what carries that
     *: a kept one goes down as the marker the daemon resolves back into the stored value. */
    const input: AddCapabilityInput = { id: savedName.value, kind: entry.kind, config: buildConfig(entry, values, keptSecrets.value) };
    // Read BEFORE the write, like `next` below: a one-per-sandbox card that is being connected for the first
    // time becomes an edit the moment its entry lands, and asking afterwards would call every first add an edit.
    const wasEditing = editing.value !== undefined;
    // Where the walk goes next, decided against the queue as it stands now: the add below takes this card out
    // of it, and asking afterwards would answer about a different list.
    const next = walking.value ? nextAfter(entry) : undefined;
    try {
        await add(input, (line) => {
            // The install runs in a real tmux session: open ITS terminal tab, so what the user watches is the
            // commands themselves (user-clicked action → openFocused, the apply/vitest/add-apps precedent).
            // That IS the progress surface: a summary box beside it could only ever be a worse retelling of
            // the pane, and it went away with the flow anyway the moment this form navigated back.
            if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                useTerminalPanel().openFocused(line[`session`]);
            }
        });
        rememberSecrets(entry, values);
        attempted.value = false;
        const added = capabilities.value.find((capability) => capability.id === input.id);
        if (added?.status.state === `pending`) {
            handOff(entry, added);
            /* A PENDING ADD IS THE ONE PATH THAT LEAVES THE FORM STANDING, and a form still holding the name it
             * just used reads as a failure: the connection above now owns that name, so the untouched box lights
             * up "already exists" under a submit that in fact worked. Reset it the way arriving on the card does,
             * down to the next free name. An edit is exempt: it keeps its connection's name by design, and the
             * collision check ignores it anyway. */
            if (!wasEditing) {
                clearForm();
                name.value = suggestName(entry, instancesFor(entry));
            }
            return;
        }
        /* A SAVED EDIT STAYS ON THE CARD, where an add leaves it. The two look alike and are opposite: an add
         * is finished with this card: the catalog it lands back on is the proof of what got connected, while
         * an edit was opened FROM the list of connections a few pixels up, and the reader's next act is to
         * check the row now says what they just typed. Sent back to the grid they would have to find the card
         * again to see whether the change took. */
        if (wasEditing) {
            stopEditing();
            return;
        }
        leaveCard(next);
    } catch (err) {
        error.value = noticeFrom(err, wasEditing ? `Could not save that connection.` : `Could not add the capability.`);
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

/* RENAMING A CONNECTION. The one edit a card could not make: every other field is re-typed into the form and
 * saved over the same name, but the name itself had no path at all: the closest thing was removing the
 * connection and setting it up again, which for the kinds people most want to rename (a signed-in account, a
 * paired computer) is the one operation that throws away what makes them worth keeping. The daemon carries that
 * state across; this only has to ask which name, and to hold onto its refusals.
 *
 * The refusal is kept BESIDE the dialog rather than in the page's top notice: it is an answer about the name
 * still in the field, and the reader's next act is to change it. */
const renameId = ref<string>();
const renameError = ref<NoticeModel>();
const askRename = (id: string): void => {
    renameError.value = undefined;
    renameId.value = id;
};
const confirmRename = async (to: string): Promise<void> => {
    const id = renameId.value;
    if (id === undefined) {
        return;
    }
    renameError.value = undefined;
    try {
        await rename.mutateAsync({ id, to });
    } catch (err) {
        renameError.value = noticeFrom(err, `Could not rename that connection.`);
        return;
    }
    renameId.value = undefined;
};
const confirmRemove = async (): Promise<void> => {
    const id = confirmRemoveId.value;
    if (id === undefined) {
        return;
    }
    await removeCapability(id);
    confirmRemoveId.value = undefined;
};

const topError = computed<NoticeModel | undefined>(() => {
    if (error.value !== null) {
        return error.value;
    }
    if (listError.value === undefined) {
        return undefined;
    }
    return { tone: `danger`, title: `Couldn't list your capabilities.`, detail: listError.value };
});

/* The submit's word, in the card's own vocabulary. Editing a connection leads, because it is the only one of
 * these the reader can be wrong about in a costly way: a form pre-filled with somebody's live gateway must not
 * offer to "Add" it. DevOps is activated rather than added; a service is provisioned as it is added. */
const submitLabel = computed(() => {
    if (editing.value !== undefined) {
        return `Save changes`;
    }
    if (selected.value?.kind === `devops`) {
        return `Activate`;
    }
    if (selected.value?.kind === `service`) {
        return `Add & provision`;
    }
    return `Add`;
});
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
                 width and everything the card SAYS rather than ASKS docks beside it, /setup-style: see
                 <CapabilityContext> and the aside at the foot of this block. A @container rather than a viewport
                 breakpoint: this pane shares the page with the index column and the shell with a chat panel the
                 user drags, so how much room there is for a second column is a fact about the pane, not about the
                 screen. Below that width the row collapses and the context moves inline into the form. -->
            <div v-if="selected" class="scrollbar-thin scrollbar-stable @container min-h-0 flex-1 overflow-y-auto pr-2">
                <div class="mx-auto flex max-w-xl flex-col @3xl:max-w-none @3xl:flex-row @3xl:items-start @3xl:justify-center @3xl:gap-6">
                    <!-- CAPPED BELOW THE READING MEASURE, because this column does not hold reading: it holds a
                         stack of single-line inputs, and a text box is no easier to fill in at 36rem than at 32.
                         The room it was taking came out of the column beside it, which holds the opposite kind of
                         text: five numbered steps a reader works through before the first keystroke. -->
                    <div class="flex min-w-0 flex-1 flex-col @3xl:max-w-lg">
                        <!-- Back to the slice the card was picked out of, named: "All capabilities" was a lie the
                             moment the rail could be pointing at one category. -->
                        <button type="button" class="mb-4 inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-content" @click="back">
                            <Icon name="arrow-left" class="text-2xs" /> {{ activeScope.label }}
                        </button>

                        <!-- The walk's own strip: where the user is in it, and the way past a card they don't
                             want to answer right now. A count of what is LEFT rather than "step 2 of 5": a
                             connected card leaves the queue, so any fixed position would start lying at the
                             first success. -->
                        <div v-if="walking" class="mb-4 flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
                            <Icon name="sparkles" class="text-info" />
                            <span class="text-xs text-content">Recommended setup</span>
                            <span class="text-2xs text-muted">{{ walkQueue.length }} left</span>
                            <Button class="ml-auto" label="Skip" size="small" severity="secondary" text @click="skip" />
                        </div>

                        <!-- The card's own heading, and (for a one-per-sandbox card) its STATE, because on
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
                                        :variant="rowState(selected, soleInstance).tone"
                                        :label="rowState(selected, soleInstance).label"
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
                             waiting on, so it carries it here: directly under the heading its badge is on. -->
                        <RouterLink
                            v-if="soleInstance && soleRebuildStep(soleInstance)"
                            to="/sandbox/environment"
                            class="mb-4 inline-flex w-fit items-center gap-1 text-xs text-warning hover:underline"
                        >
                            <Icon name="exclamation-triangle" />
                            {{ soleInstance.status.detail ?? "Needs a sandbox rebuild" }}: Finish setup →
                        </RouterLink>

                        <!-- Precondition gate: a service/integration needs DevOps first. -->
                        <Notice v-if="!requiresMet" tone="info">
                            This needs <b>DevOps</b> active first. Go back and activate the DevOps capability, then add this.
                        </Notice>

                        <form v-else class="flex flex-col gap-3" @submit.prevent="submit">
                            <!-- WHAT YOU ALREADY HAVE OF THIS CARD: a list of accounts, and therefore a LIST.
                                 Suppressed entirely for a one-per-sandbox card, whose single instance is the
                                 subject of the heading above rather than an entry under it. -->
                            <RowGroup
                                v-if="selectedInstances.length > 0 && !selected.singleton"
                                label="Your connections"
                                :count="selectedInstances.length"
                            >
                                <CapabilityInstanceRow
                                    v-for="instance in selectedInstances"
                                    :key="instance.id"
                                    :entry="selected"
                                    :instance="instance"
                                    :host="hostFor(instance.id)"
                                    :state="rowState(selected, instance)"
                                    :facts="cardRowFacts(instance)"
                                    :editing="editing?.id === instance.id"
                                    @connect="openConnect(instance)"
                                    @revoke="removeHostAccess(instance.id)"
                                    @browse="openBrowser(instance.id, instance.id, `browse`)"
                                    @login="openBrowser(instance.id, instance.id)"
                                    @agent-login="startAgentLogin(instance.id)"
                                    @edit="openEdit(instance.id)"
                                    @rename="askRename(instance.id)"
                                    @remove="askRemove(instance.id)"
                                />
                            </RowGroup>

                            <!-- The gateway serving those connections. It answers the question the connector page is
                             actually visited with once something is set up: "is this still working?", so it lives
                             here rather than only in the terminal panel's popover. Same rows, same actions. -->
                            <RowGroup
                                v-if="cardProcesses.length > 0"
                                label="Background process"
                                caption="Relays events to your agent: restart it if this connection stops responding."
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
                                            @click="startProcess(row)"
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
                                            @click="stopProcess(row)"
                                        >
                                            <template #icon><Icon name="stop" /></template>
                                        </Button>
                                    </div>
                                </div>
                            </RowGroup>

                            <!-- Fill this form from the file FortiClient already wrote. Keyed on the card so
                                 leaving it and coming back starts with an empty zone rather than a stale list. -->
                            <ForticlientImport v-if="selected.kind === 'vpn'" :key="selected.id" @pick="pickForticlient" @notice="error = $event" />

                            <!-- WHERE EXTENSIONS ARE FOUND, said on the card people arrive at wanting one. This
                                 form is the "I already have a repository and a commit" path and it stays exactly
                                 that; browsing what other people have published is a surface, not a field, and
                                 it is one link away. The counts render only when the registry is already in
                                 cache: this page must not clone a repo to decorate a sentence. -->
                            <RouterLink
                                v-if="selected.kind === 'extension'"
                                to="/sandbox/discover"
                                class="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5 transition-colors hover:border-line-strong hover:bg-overlay"
                            >
                                <Icon name="search" class="shrink-0 text-link" />
                                <span class="min-w-0 flex-1">
                                    <span class="block text-xs font-medium text-content">Browse published extensions</span>
                                    <span class="block text-2xs text-muted">
                                        <template v-if="publishedCount > 0"
                                            >{{ publishedCount }} published<template v-if="verifiedCount > 0"
                                                >, {{ verifiedCount }} with the source read by a human</template
                                            >. </template
                                        >Install in a click from the registry, or fill the form below from a repository you already trust.
                                    </span>
                                </span>
                                <Icon name="arrow-right" class="shrink-0 text-subtle" />
                            </RouterLink>

                            <!-- Registry browse (plugins only: extensions have Discover). -->
                            <PluginRegistryBrowse
                                v-if="selected.kind === 'plugin'"
                                :key="selected.id"
                                :kind="selected.kind"
                                @pick="applyRegistryPick"
                                @notice="error = $event"
                            />

                            <!-- WHAT THE FORM BELOW IS FOR, said out loud, and the one line on this screen that
                                 has to be unmissable: the same fields mean "make a new connection" and "change
                                 the one you are looking at", and the difference is the reader's whole intent.
                                 The name is IN the sentence when editing rather than in a box below it, because
                                 there is nothing to type: it names the subject, the way a title does.

                                 It used to say only "Add another", leaving "Name": pre-filled with `github-2`
                                : as the only clue that this was a second connection rather than an edit of the
                                 first. -->
                            <div
                                v-if="editing || selected.singleton || selectedInstances.length > 0"
                                class="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
                            >
                                <div :class="ui.sectionLabel()">
                                    <!-- A one-per-sandbox card says "Settings" whether or not it is connected
                                         yet: it is never adding a second anything, so its form is its settings
                                         either way, and it has no name to put in the sentence. -->
                                    <template v-if="selected.singleton">Settings</template>
                                    <template v-else-if="editing">
                                        Editing <span class="font-mono normal-case">{{ editing.id }}</span>
                                    </template>
                                    <template v-else>Add another</template>
                                </div>
                                <!-- The way out of an edit, beside what it is an edit OF. Not down by the submit:
                                     that button is stuck to the foot of the pane and reachable from anywhere, so
                                     a Cancel next to it would be a second thing to read past on every card,
                                     including the ones that are only ever adding. -->
                                <button v-if="editing && !selected.singleton" type="button" :class="ui.linkButton(`text-2xs`)" @click="stopEditing">
                                    Cancel: add another instead
                                </button>
                            </div>

                            <!-- NO NAME BOX WHILE EDITING, and none on a one-per-sandbox card. Renaming a
                                 connection moves what the name keys: a signed-in browser profile, a paired
                                 machine's enrollment, an extension's checkout, so it is its own migration
                                 (askRename), and a second, lossy way to do it here would be a trap wearing a
                                 text box. A one-per-sandbox card never had one for the other reason: a name
                                 field is the thing that invites a second one. -->
                            <label v-if="!selected.singleton && !editing" class="ui-field">
                                <span class="ui-field-label">Name</span>
                                <input
                                    v-model="name"
                                    placeholder="my-tool"
                                    :class="[ui.input(), nameCollision || (attempted && nameProblem) ? 'ui-field-input-error' : '']"
                                    @input="nameEdited = true"
                                    @blur="finishName"
                                />
                                <!-- A taken name is refused rather than quietly saved over that connection: this
                                     form holds the card's DEFAULTS, and writing those over somebody's live
                                     settings is the accident this points away from. -->
                                <span v-if="nameCollision" class="ui-field-error">
                                    <Icon name="exclamation-triangle" class="text-2xs" />
                                    "{{ savedName }}" already exists: open it above to change it, or pick another name.
                                </span>
                                <span v-else-if="attempted && nameProblem" class="ui-field-error">
                                    <Icon name="exclamation-triangle" class="text-2xs" />
                                    {{ nameProblem }}
                                </span>
                                <!-- The repair, shown rather than performed silently: spaces and punctuation
                                     become hyphens, and this line is the contract for what the submit will use.
                                     Blur writes it into the box, at which point there is nothing left to say. -->
                                <span v-else-if="namePreview" class="mt-1 flex items-center gap-1 text-2xs text-muted">
                                    <Icon name="check" class="text-2xs text-success" />
                                    Saved as <span class="font-mono text-content">{{ namePreview }}</span>
                                </span>
                                <span v-else-if="selectedInstances.length > 0" class="mt-1 text-2xs text-subtle">
                                    What your agent will call this connection.
                                </span>
                            </label>
                            <!-- The narrow half of the card's reference material, above the fields it explains.
                             From @3xl it is docked in a column of its own (see the aside below) and this one is
                             hidden: exactly one of the two is ever on screen. -->
                            <CapabilityContext :entry="selected" :values="values" :effects="liveEffects" class="@3xl:hidden" />
                            <!-- A computer's grant as a posture: the preset row sets the six switches at once,
                                 and the sentence under it states what they currently spell, in the same words
                                 the connect dialog and the machine's row will use. The switches stay below for
                                 fine-tuning; a hand-tuned mix selects no preset. -->
                            <label v-if="selected.kind === 'host'" class="flex items-start justify-between gap-4">
                                <span class="min-w-0">
                                    <span class="ui-field-label">Access</span>
                                    <span class="mt-0.5 block text-2xs text-muted">{{ hostGrantSummary(values) }}</span>
                                </span>
                                <SegmentedControl
                                    class="shrink-0"
                                    :model-value="matchHostPreset(values) ?? ''"
                                    :options="hostPresetOptions"
                                    @update:model-value="applyHostPreset($event)"
                                />
                            </label>

                            <!-- The fields, main ones first, with the rarely-changed answers folded behind one
                                 Advanced line. Each row draws the page's verdicts (see <CapabilityFieldRow>);
                                 the disclosure opens by itself when an edit holds a non-default advanced value
                                 or a refused submit is blocked by one, so nothing live or blocking ever hides. -->
                            <CapabilityFieldRow
                                v-for="field in mainFields(selected)"
                                :key="field.key"
                                :field="field"
                                :values="values"
                                :inline="inlineField(field)"
                                :placeholder="fieldPlaceholder(field)"
                                :alarm="fieldAlarm(field)"
                                :quiet="fieldQuiet(field)"
                                :checked="fieldChecked(field)"
                                :url-fix="fieldUrlFix(field)"
                                :note="pasteNotes[field.key]"
                                :summary="fieldConfSummary(field)"
                                @edited="onFieldInput(field)"
                                @pasted="onFieldPaste(field, $event)"
                                @left="finishField(field)"
                                @fix="applyUrlFix(field)"
                            />
                            <template v-if="advancedFields(selected).length > 0">
                                <button
                                    type="button"
                                    class="inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-content"
                                    @click="advancedOpen = !advancedOpen"
                                >
                                    <Icon :name="advancedOpen ? 'chevron-down' : 'chevron-right'" class="text-2xs" />
                                    {{ advancedLabel(selected) }}
                                    <span class="text-2xs text-subtle">{{ advancedFields(selected).length }}</span>
                                </button>
                                <template v-if="advancedOpen">
                                    <CapabilityFieldRow
                                        v-for="field in advancedFields(selected)"
                                        :key="field.key"
                                        :field="field"
                                        :values="values"
                                        :inline="inlineField(field)"
                                        :placeholder="fieldPlaceholder(field)"
                                        :alarm="fieldAlarm(field)"
                                        :quiet="fieldQuiet(field)"
                                        :checked="fieldChecked(field)"
                                        :url-fix="fieldUrlFix(field)"
                                        :note="pasteNotes[field.key]"
                                        :summary="fieldConfSummary(field)"
                                        @edited="onFieldInput(field)"
                                        @pasted="onFieldPaste(field, $event)"
                                        @left="finishField(field)"
                                        @fix="applyUrlFix(field)"
                                    />
                                </template>
                            </template>
                            <!-- Why the grid badged this one: the claim, then the thing that was read to make
                                 it, verbatim. The evidence is what makes this checkable instead of magic, and it
                                 is also what "Not needed" is answering: the suggestion goes quiet for THIS, and
                                 comes back by itself if the workspace changes under it. -->
                            <!-- The sentence the answers add up to (a spending policy, a RAM bill), computed
                                 live so it is always what the submit actually agrees to. -->
                            <p v-if="formSummary" class="flex items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs text-content">
                                <Icon name="info-circle" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                                {{ formSummary }}
                            </p>

                            <Notice v-if="selectedRecommendation" tone="info">
                                <div class="flex items-start gap-3">
                                    <div class="min-w-0 flex-1">
                                        <div>Recommended: {{ selectedRecommendation.reason }}.</div>
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
                            </Notice>

                            <!-- THE SUBMIT STAYS ON SCREEN. A few cards are genuinely long: a VPN carries three
                                 protocols' worth of fields, a computer seven permissions, and no amount of moving
                                 prose out of this column makes those short. What made a long one unusable was not
                                 its length but that scrolling took the only button on the page out of view, so the
                                 reader had to scroll back down through what they had just filled in to press it.
                                 Stuck to the foot of the pane it is reachable from anywhere in the form, and the
                                 canvas tint under it keeps the last field from appearing to run into it. -->
                            <!-- WHAT THE SERVICE ITSELF SAID, above the button that would save it: the answer to
                                 "will any of this work" belongs before the commitment, not after it, and it is
                                 the one thing on this screen a guide cannot tell anybody. -->
                            <p
                                v-if="probeResult"
                                class="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
                                :class="
                                    probeResult.ok
                                        ? 'border-success/30 bg-success/5 text-content'
                                        : probeResult.checked
                                          ? 'border-danger/30 bg-danger/5 text-content'
                                          : 'border-line bg-card text-muted'
                                "
                            >
                                <Icon
                                    :name="probeResult.ok ? 'check-circle' : probeResult.checked ? 'exclamation-triangle' : 'info-circle'"
                                    class="mt-0.5 shrink-0 text-2xs"
                                    :class="probeResult.ok ? 'text-success' : probeResult.checked ? 'text-danger' : 'text-subtle'"
                                />
                                {{ probeResult.message }}
                            </p>

                            <div
                                :class="[
                                    'sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 bg-canvas px-1 py-3',
                                    auditable ? 'justify-between' : 'justify-end',
                                    shaking ? 'ui-shake' : '',
                                ]"
                                @animationend="shaking = false"
                            >
                                <!-- The read is beside the approval because that is when it matters: before the
                                     click, not after. It starts an ordinary chat and the form stays as it is:
                                     the account arrives, and installing remains this same button. -->
                                <button v-if="auditable" type="button" :class="ui.linkButton(`text-2xs`)" @click="startAudit">
                                    {{
                                        updateFrom !== undefined
                                            ? `Have an agent read what changed first: the manifest delta leads`
                                            : `Have an agent read it first, what the code does, route by route`
                                    }}
                                </button>
                                <!-- Quiet, and beside the real button rather than competing with it: testing is
                                     optional, saving is the task. It retires itself on a card that answers "no
                                     test exists" (see canProbe). -->
                                <Button
                                    v-if="canProbe"
                                    class="ml-auto"
                                    label="Test"
                                    size="small"
                                    severity="secondary"
                                    text
                                    :loading="probing"
                                    @click="runProbe"
                                >
                                    <template #icon><Icon name="wave-pulse" /></template>
                                </Button>
                                <Button type="submit" size="small" :label="submitLabel" :loading="submitting">
                                    <template #icon><Icon name="check" /></template>
                                </Button>
                            </div>
                        </form>
                    </div>

                    <!-- The docked half of the card's reference material. `hidden` below @3xl, where the same
                         component renders inline inside the form instead: exactly one of the two is ever on
                         screen. `items-start` on the row is what leaves it room to stick while the form scrolls
                         past it.

                         NO `v-if` ANY MORE, and that is the point of the restructure: it used to appear only for
                         a card whose author had written a credential guide, so half the catalog rendered one
                         narrow column against an empty half-page. Every card has effects, so every card has a
                         column: the page has one shape instead of two.

                         AND IT SCROLLS WITH THE PANE rather than sticking. Sticky was right when this column
                         held only a guide, because a guide short enough to pin is a guide that fits. Holding
                         three panels it does not fit, and the two ways to pin something that doesn't fit are
                         both worse than not pinning it: leave it sticky and its foot, where "this will add to
                         your sandbox" now lives: is unreachable; cap it and give it its own scrollbar and the
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
                     Only ever shown when the scan actually found something: an empty version of this would be a
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

                <!-- The bar sits on the grid it narrows, spanning it: one left edge and one right edge down the
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
                         the connections themselves: named, with the host or account that tells them apart and
                         the state they are actually in. See <CapabilityConnections>. -->
                    <CapabilityConnections v-if="showingConnections" :groups="connectionGroups" @open="openConnection" />

                    <!-- HEADINGS ONLY WHERE THE GRID SPANS MORE THAN ONE CATEGORY. Under a single category the
                         rail has already said which one and the page's own description carries its sentence, so a
                         heading repeating both above the only group in view is a line of chrome. -->
                    <template v-else>
                        <div v-for="group in groupedCatalog" :key="group.label" class="flex flex-col gap-2">
                            <!-- The label alone. The category's sentence is the PAGE's description the moment the rail
                             points at it, so printing all ten of them down the full catalog spends a line each on
                             text nobody is reading yet, and the catalog is the view that has no room to spare. -->
                            <div v-if="!inCategory" :class="ui.sectionLabel()">{{ group.label }}</div>
                            <!-- Container queries, not viewport ones: the grid is what is left of the page after the
                             index column takes its 16rem, so how many tiles fit is a fact about this pane. -->
                            <div class="grid grid-cols-1 gap-2 @xl:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4">
                                <!-- The padding is the TEXT's, not the tile's, so the mark can reach the tile's own edges;
                                     `overflow-hidden` is what then cuts its corners to the tile's radius. -->
                                <button
                                    v-for="card in group.entries"
                                    :key="card.entry.id"
                                    type="button"
                                    class="flex h-full w-full items-stretch overflow-hidden rounded-lg border border-line-subtle bg-card text-left transition-colors hover:border-line-strong hover:bg-overlay"
                                    @click="pick(card.entry)"
                                >
                                    <!-- THE MARK IS THE TILE'S FULL HEIGHT: a band down the left edge, which is what makes
                                     a grid of forty scannable by logo rather than by reading forty names. `flush` is
                                     what says so: it stretches the plate to the row and drops the mark's own rounding
                                     and border, which inside the tile's border would be a second outline along three
                                     shared edges. `size` is left to scale what is INSIDE the plate (the glyph, the
                                     monogram, the brand mask), which is the only thing it still decides. The one line
                                     that IS wanted is the divider from the text, and that is this layout's to draw. -->
                                    <BrandMark
                                        flush
                                        class="border-r border-line"
                                        :size="44"
                                        :name="card.entry.name"
                                        :logo="card.entry.logo"
                                        :icon="entryIcon(card.entry)"
                                    />
                                    <div class="min-w-0 flex-1 px-2.5 py-2">
                                        <!-- ONE LINE, NEVER TWO. A grid row is as tall as its tallest tile, so any line
                                         a single card can grow is a line every card beside it pays for in white
                                         space, which is what a catalog of ragged tiles looked like. The name gives
                                         way (it truncates) rather than the badges, which are a fixed few glyphs
                                         wide and are the state a scanner is reading down the column.

                                         EVERY BADGE IS A GLYPH, with its sentence in the tooltip: the words were
                                         the same words on every card carrying them: a strip of green ticks reads
                                         as a column of state faster than "1 connected" repeated down the grid. -->
                                        <div class="flex items-center gap-x-1.5">
                                            <span class="truncate text-xs font-semibold text-content">{{ card.entry.name }}</span>
                                            <!-- The count only once there is more than one to count: a lone tick already
                                             means connected, and "1" beside it is a number nobody needs. -->
                                            <span
                                                v-if="card.connected > 0"
                                                v-tooltip.top="`${card.connected} connected`"
                                                class="inline-flex shrink-0 items-center gap-0.5 text-2xs text-success"
                                                :aria-label="`${card.connected} connected`"
                                            >
                                                <Icon name="check-circle" />
                                                <template v-if="card.connected > 1">{{ card.connected }}</template>
                                            </span>
                                            <!-- The scan's finding rides its own badge rather than two lines under the
                                             description: the claim and the file it was read from are what the
                                             tooltip says, so a reader can still check it, and a recommended card is
                                             the same shape as the ones around it. -->
                                            <span
                                                v-if="card.recommendation"
                                                v-tooltip.top="`${card.recommendation.reason}: ${card.recommendation.evidence}`"
                                                class="shrink-0 text-2xs text-info"
                                                :aria-label="`Recommended: ${card.recommendation.reason}`"
                                            >
                                                <Icon name="sparkles" />
                                            </span>
                                            <span
                                                v-if="card.entry.requires?.includes('devops') && !hasCapability('devops')"
                                                v-tooltip.top="`Requires DevOps`"
                                                class="shrink-0 text-2xs text-muted"
                                                aria-label="Requires DevOps"
                                            >
                                                <Icon name="lock" />
                                            </span>
                                            <CapabilityEffects :effects="badgeEffects(card.entry)" :compact="true" />
                                        </div>
                                        <!-- TRUNCATED, not merely short. Card copy is authored to one line, but a card
                                         derives from any enabled extension's manifest: including one nobody here
                                         wrote, and that sentence cannot be allowed to set the height of its row. -->
                                        <div class="truncate text-2xs text-muted">{{ card.entry.description }}</div>
                                    </div>
                                </button>
                            </div>
                        </div>
                    </template>

                    <!-- Only ever reachable through the filter: every slice the rail offers has something in it.
                         So it answers the one question a reader has here, which is what they typed, and it
                         answers it about the list they are actually looking at, which under Connected is their
                         own connections and not the catalog. -->
                    <div v-if="nothingMatches" :class="ui.emptyState()">
                        <p class="text-sm">Nothing in {{ activeScope.label }} matches "{{ search.trim() }}".</p>
                        <p v-if="showingConnections" class="mt-1 text-xs text-muted">
                            Connections are searched by the name you gave them, by what they connect to, and by kind.
                        </p>
                        <p v-else class="mt-1 text-xs text-muted">
                            Capabilities are searched by name, by what they do, and by kind: "mcp", "ssh", "sql".
                        </p>
                    </div>
                </div>
            </div>

            <!-- Removal runs a real teardown in the sandbox (MCP config, SSH host, service provisioning): confirm first. -->
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

            <!-- The one edit that is a migration rather than a form field: see askRename. -->
            <CapabilityRenameDialog
                :visible="renameId !== undefined"
                :id="renameId ?? ''"
                :busy="rename.isPending.value"
                :error="renameError"
                @update:visible="renameId = undefined"
                @rename="confirmRename"
            />

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
