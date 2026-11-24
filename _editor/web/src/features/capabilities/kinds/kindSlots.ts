// WHAT EACH CAPABILITY KIND ADDS TO THE CAPABILITIES PAGE'S UI, as one entry per kind: the dialog its row pairs
// through, the parts its form opens with, what its save does besides the daemon's add. The page, the setup form, a
// connection's row and a need's card read the slots here instead of naming kinds, so a new
// kind's UI is one entry the compiler makes complete (`satisfies Record<CapabilityKind, KindSlots>`). What a kind IS
// (its group, whether it is a peer or an account) is the contract's trait table (policy/capability-kinds.ts); this is
// only what the editor draws for it. Components are imported statically: a lazy one would draw a tick later, and the
// page's suites read what is on screen after one render. None of them imports this file back.
import type { AddCapabilityInput, CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityKind, CapabilityProbe, CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { NoticeModel } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { Component } from "vue";
import LinkPairing from "../../../components/LinkPairing.vue";
import type { PairedLink } from "../../../components/linkPairing";
import { browserGrants, machineAway, machineGrants, phoneGrants } from "../../../models/capabilities/connections";
import { seedValues } from "../../../models/capabilities/form";
import { isDefaultName } from "../../../models/capabilities/tiles";
import type { LinkKind } from "../../../models/sandbox/devices/useLiveLinks";
import type { CapabilityForm } from "../capabilityForm";
import BrowseExtensionsLink from "../connect/BrowseExtensionsLink.vue";
import FleetAllow from "../connect/FleetAllow.vue";
import ForticlientImport from "../connect/ForticlientImport.vue";
import HostAccessPreset from "../connect/hosts/HostAccessPreset.vue";
import HostConnectDialog from "../connect/hosts/HostConnectDialog.vue";
import PhoneConnectDialog from "../connect/PhoneConnectDialog.vue";
import PluginRegistryBrowse from "../connect/PluginRegistryBrowse.vue";
import WebExtConnectDialog from "../connect/WebExtConnectDialog.vue";
import GpuHostedNote from "../GpuHostedNote.vue";
import { type ContributionOf, contributionFor } from "../model/effects";
import { hostPresets, localModelMemorySummary, matchHostPreset, walletPolicySummary } from "../model/previews";
import { pushWalletPolicy } from "../model/walletPolicy";

// A component and what it is drawn with, listeners included (`onPick`, `onNotice`), for a `<component :is v-bind>`:
// each slot below builds the props its own component declares.
export interface Bound {
    readonly is: Component;
    readonly props: object;
}

// What a part of the setup form is drawn from: the tile, the connection it is over, the form's own state.
export interface FormSlotContext {
    readonly entry: CapabilityCatalogEntry;
    /** The connection the form is over; undefined while it adds one. */
    readonly editing: CapabilitySummary | undefined;
    /** A one-per-sandbox tile's one connection. */
    readonly sole: CapabilitySummary | undefined;
    readonly form: CapabilityForm;
    /** The page's streamed add, for a part whose own press writes the card. */
    readonly save: (input: AddCapabilityInput) => Promise<void>;
    readonly submit: () => Promise<void>;
    readonly hosted: boolean;
    readonly notice: (notice: NoticeModel | null) => void;
}
// A part of the form, or undefined where it has nothing to show for this context.
export type FormPart = (context: FormSlotContext) => Bound | undefined;

// What a need's card (features/needs) hands the part a kind is added by in one press.
export interface NeedSlotContext {
    /** The sandbox or host the agent named. */
    readonly target: string | undefined;
    readonly paired: (link: PairedLink) => Promise<void>;
    readonly allow: (input: AddCapabilityInput) => Promise<void>;
    readonly notice: (notice: NoticeModel | null) => void;
}

// What a save's own checks run with; the submit fills in the daemon's preflight and the analytics capture.
export interface SaveContext {
    readonly hosted: boolean;
    readonly ownsSandbox: boolean;
    readonly preflight: (input: AddCapabilityInput) => Promise<CapabilityProbe>;
    readonly capture: (event: string, properties: { readonly hosted: boolean }) => void;
}

export interface PairingSlot {
    /** The dialog under the row, drawn with `id`, `visible`, `inline` and these props; it emits `connected`. */
    readonly dialog: Component;
    readonly props: (instance: CapabilitySummary, context: { readonly contributionOf: ContributionOf }) => object;
    /** The dialog may emit `renamed`, taking the machine's own name: the pairing follows it. */
    readonly renames?: true;
    /** The daemon still holds it paired while the roster has not seen it since a restart. */
    readonly stillPaired?: (instance: CapabilitySummary) => boolean;
    /** What the agent may do there, in the words of the form that sets it, for the row's closed line. */
    readonly access?: (entry: CapabilityCatalogEntry, instance: CapabilitySummary) => string;
}

export interface KindSlots {
    /** Above the tile's list: where the things this tile connects are found. */
    readonly headerExtra?: (context: { readonly publishedCount: number; readonly verifiedCount: number }) => Bound;
    /** Its rows dial or mount a live link from the list (LiveLinkRows) instead of the plain connection rows. */
    readonly liveLinks?: LinkKind;
    /** A peer's pairing: the dialog its row's Connect opens, under that row. */
    readonly pairing?: PairingSlot;
    /** Signs in by a command the daemon runs, in the terminal panel. */
    readonly signsInByCommand?: (instance: CapabilitySummary) => boolean;
    /** First in the form, a new connection's or an open one's. */
    readonly formLead?: FormPart;
    /** First in a new connection's form only: a way to fill it by doing rather than typing. */
    readonly addLead?: FormPart;
    /** After the name, before the fields. */
    readonly formExtra?: FormPart;
    /** Added by its own press (a pairing, an Allow): the form's by-hand Add waits until that way is taken. */
    readonly addsByItself?: true;
    /** The part a need's card adds it with, in one press, instead of the form. */
    readonly needLead?: (context: NeedSlotContext) => Bound & { readonly quietUnderAnswer?: true };
    /** Its form alone finishes the setup, so a need's card carries the form itself. */
    readonly inlineInNeed?: true;
    /** The sentence the form's answers compose into under it. */
    readonly answersSummary?: (values: Readonly<Record<string, string>>) => string | undefined;
    /** Refused before any write, said on the page. */
    readonly refuseSave?: (context: SaveContext) => NoticeModel | undefined;
    /** Awaited before the daemon's add where it returns a promise (a check that may refuse it); else the add starts at once. */
    readonly beforeSave?: (input: AddCapabilityInput, context: SaveContext) => Promise<void> | undefined;
    /** A second write after the daemon took the card, said apart when refused since the card itself was saved. */
    readonly afterSave?: { readonly run: (config: Record<string, string>) => Promise<void>; readonly refused: () => string };
}

const none: KindSlots = {};

// The value a pairing dialog's tile contributes for this card's family (its store listing), empty while it has none.
const installOf = (contributionOf: ContributionOf, instance: CapabilitySummary, kind: `webext` | `phone`): string => {
    const contribution = contributionFor(contributionOf, instance.kind, instance.config);
    return (contribution?.kind === kind ? contribution.install : undefined) ?? ``;
};

// A connected computer's access, as the preset the form's switches spell.
const hostAccess = (entry: CapabilityCatalogEntry, instance: CapabilitySummary): string => {
    const preset = matchHostPreset(seedValues(entry, instance.config, {}));
    return hostPresets().find((candidate) => candidate.key === preset)?.label ?? t(`capabilities.capabilityInstanceRow.customAccess`);
};

// The GPU switch is refused on a host whose device request ran and failed: Docker would otherwise rebuild into a runtime
// that refuses every GPU container, and the reader would learn why only from the install's log. A check that could not
// run (`checked: false`, no device to ask) saves, and the launch's own preflight decides.
const proveGpu = async (input: AddCapabilityInput, { hosted, preflight, capture }: SaveContext): Promise<void> => {
    const answer = await preflight(input);
    if (answer.checked && !answer.ok) {
        capture(`gpu_capability_blocked`, { hosted });
        throw new Error(answer.message);
    }
};

// In CapabilityKindSchema's own order.
export const KIND_SLOTS = {
    mcp: { inlineInNeed: true },
    cli: { inlineInNeed: true },
    plugin: {
        // Registry browse for plugins only; extensions have their own Browse tab, linked from the page.
        addLead: ({ entry, form, notice }) => ({
            is: PluginRegistryBrowse,
            props: { kind: entry.kind, onPick: form.applyRegistryPick, onNotice: notice },
        }),
    },
    extension: {
        headerExtra: ({ publishedCount, verifiedCount }) => ({ is: BrowseExtensionsLink, props: { publishedCount, verifiedCount } }),
    },
    ssh: { inlineInNeed: true },
    vpn: {
        liveLinks: `vpn`,
        // Fills this form from FortiClient's own file, a new connection's or an open one's.
        formLead: ({ form, notice }) => ({ is: ForticlientImport, props: { onPick: form.pickForticlient, onNotice: notice } }),
    },
    exit: none,
    netdisk: { liveLinks: `netdisk` },
    docker: {
        formExtra: ({ hosted, form }) =>
            hosted
                ? {
                      is: GpuHostedNote,
                      props: {
                          modelValue: form.values[`gpu`],
                          "onUpdate:modelValue": (value: string | undefined) => {
                              form.values[`gpu`] = value ?? ``;
                          },
                      },
                  }
                : undefined,
        beforeSave: (input, context) => (input.config[`gpu`] === `on` ? proveGpu(input, context) : undefined),
    },
    browser: none,
    identity: none,
    device: {
        // A device of the user's own is unreachable from here, so connecting it is a one-time command run on that machine.
        pairing: {
            dialog: HostConnectDialog,
            props: (instance) => {
                const platform = String(instance.config[`platform`] ?? `linux`);
                return {
                    platform,
                    // In the machine's own words, shared with the Devices tab, which opens this dialog on a machine gone quiet.
                    permissions: machineGrants(instance),
                    // Still wearing its tile's name (`linux`, `linux-2`): the dialog may then offer the machine's own hostname.
                    unnamed: isDefaultName(platform, instance.id),
                    renamed: false,
                };
            },
            renames: true,
            stillPaired: machineAway,
            access: hostAccess,
        },
        formExtra: ({ form }) => ({
            is: HostAccessPreset,
            props: { preset: matchHostPreset(form.values) ?? ``, options: form.hostPresetOptions, onApply: form.applyHostPreset },
        }),
    },
    webext: {
        // A browser of the user's own may be another browser at the far end, so it pairs by a pasted code, not a command.
        pairing: {
            dialog: WebExtConnectDialog,
            props: (instance, { contributionOf }) => ({ install: installOf(contributionOf, instance, `webext`), permissions: browserGrants(instance) }),
        },
    },
    phone: {
        // A phone pairs by a code its camera scans, or a link opened on it; a Wear OS watch by a code the phone beside it
        // scans and sends on.
        pairing: {
            dialog: PhoneConnectDialog,
            props: (instance, { contributionOf }) => ({
                install: installOf(contributionOf, instance, `phone`),
                permissions: phoneGrants(instance),
                platform: String(instance.config[`platform`] ?? `android`),
            }),
        },
    },
    // An ACP agent with a loginCommand signs in interactively: the daemon starts it and the terminal panel opens on it.
    agent: { signsInByCommand: (instance) => instance.config[`loginCommand`] !== undefined },
    endpoint: { inlineInNeed: true },
    localmodel: { answersSummary: localModelMemorySummary },
    wallet: {
        answersSummary: walletPolicySummary,
        // The signer spends the OWNER's wallet, so a member's save would cap a wallet of their own that pays for nothing here.
        refuseSave: ({ ownsSandbox }) => (ownsSandbox ? undefined : { tone: `warning`, title: t(`capabilities.capabilitySubmit.walletOwnerOnly`) }),
        // THE WALLET'S CAPS ARE THE PLATFORM'S TO ENFORCE, so its tile is two writes (model/walletPolicy.ts).
        afterSave: { run: pushWalletPolicy, refused: () => t(`capabilities.capabilitySubmit.walletCapsNotSaved`) },
    },
    fleet: {
        // The fleet's Allow, one press that writes the card.
        formLead: ({ sole, save, notice }) => ({ is: FleetAllow, props: { instance: sole, save, onNotice: notice } }),
        addsByItself: true,
        needLead: ({ allow, notice }) => ({ is: FleetAllow, props: { save: allow, onNotice: notice }, quietUnderAnswer: true }),
        inlineInNeed: true,
    },
    link: {
        // Pairs this sandbox with another of the reader's and adds the card; the fields under Advanced are the way by hand.
        addLead: ({ form, submit, notice }) => ({
            is: LinkPairing,
            props: {
                onPick: (paired: PairedLink) => {
                    form.pickLinked(paired);
                    void submit();
                },
                onNotice: notice,
            },
        }),
        addsByItself: true,
        needLead: ({ target, paired, notice }) => ({ is: LinkPairing, props: { prefer: target, onPick: paired, onNotice: notice } }),
    },
} as const satisfies Record<CapabilityKind, KindSlots>;

// One kind's slots, read as the full shape; an unknown kind (an older or newer peer's) has none.
export const slotsOf = (kind: CapabilityKind | undefined): KindSlots => (kind === undefined ? none : (KIND_SLOTS[kind] ?? none));
