import { localModelMemory } from "@intentic/capability-catalog";
import type { CapabilityKind } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { formatMoney } from "@intentic/ui/format";

// Computes a live summary sentence for form values whose consequences aren't obvious: wallet numbers
// into a spending policy, a computer's switches into a grant, local model choices into a RAM bill.
// Pure functions over the form's values.

const usd = (value: string | undefined): number | undefined => {
    const amount = Number((value ?? ``).replace(/[$,\s]/gu, ``));
    return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
};

/** The wallet's spending policy as one sentence, undefined while a number is unparseable. */
export const walletPolicySummary = (values: Readonly<Record<string, string>>): string | undefined => {
    const perPayment = usd(values[`perPaymentMaxUsd`]);
    const daily = usd(values[`dailyCapUsd`]);
    const auto = usd(values[`autoApproveUnderUsd`]);
    if (perPayment === undefined || daily === undefined || auto === undefined) {
        return undefined;
    }
    const asks =
        auto <= 0 ? t(`capabilities.previews.everyPaymentAsks`) : t(`capabilities.previews.paymentsUnder`, { amount: formatMoney(auto) });
    return t(`capabilities.previews.walletSummary`, { asks, perPayment: formatMoney(perPayment), daily: formatMoney(daily) });
};

// A connected computer's grant: presets over the switches, and the sentence.

// Switch keys carried by a host tile (mirrors HOST_SCOPE_FIELDS); order matches how the sentence
// names them.
const HOST_SWITCHES = [`shell`, `write`, `screen`, `control`, `sandboxes`, `destructive`] as const;
type HostSwitch = (typeof HOST_SWITCHES)[number];

// Built when read, so the sentence follows the language picked after boot.
const grantWords = (): Readonly<Record<HostSwitch, string>> => ({
    shell: t(`capabilities.previews.grantShell`),
    write: t(`capabilities.previews.grantWrite`),
    screen: t(`capabilities.previews.grantScreen`),
    control: t(`capabilities.previews.grantControl`),
    sandboxes: t(`capabilities.previews.grantSandboxes`),
    destructive: t(`capabilities.previews.grantDestructive`),
});

export interface HostPreset {
    readonly key: string;
    readonly label: string;
    readonly grants: Readonly<Record<HostSwitch, `on` | `off`>>;
}

// Even "Full control" leaves destructive off: no preset hands over the machine's own files, only the sandboxes
// on it, which `sandboxes` covers to the point of deleting them.
export const hostPresets = (): readonly HostPreset[] => [
    {
        key: `observe`,
        label: t(`capabilities.previews.observe`),
        grants: { shell: `off`, write: `off`, screen: `on`, control: `off`, sandboxes: `off`, destructive: `off` },
    },
    {
        key: `operate`,
        label: t(`capabilities.previews.operate`),
        grants: { shell: `on`, write: `off`, screen: `on`, control: `off`, sandboxes: `off`, destructive: `off` },
    },
    {
        key: `full`,
        label: t(`capabilities.previews.fullControl`),
        grants: { shell: `on`, write: `on`, screen: `on`, control: `on`, sandboxes: `on`, destructive: `off` },
    },
];

/** The preset the switches currently spell, or undefined when they are a hand-tuned mix. */
export const matchHostPreset = (values: Readonly<Record<string, string>>): string | undefined =>
    hostPresets().find((preset) => HOST_SWITCHES.every((key) => (values[key] ?? `off`) === preset.grants[key]))?.key;

// States only what is allowed, never what is blocked: listing every denied switch runs to several
// lines and buries what's granted.
export const hostGrantSummary = (values: Readonly<Record<string, string>>): string => {
    const words = grantWords();
    const allowed = HOST_SWITCHES.filter((key) => values[key] === `on`).map((key) => words[key]);
    if (allowed.length === 0) {
        return t(`capabilities.previews.readFilesOnly`);
    }
    const list = allowed.length === 1 ? (allowed[0] ?? ``) : t(`capabilities.previews.listAnd`, { rest: allowed.slice(0, -1).join(`, `), last: allowed.at(-1) ?? `` });
    const everything = allowed.length === HOST_SWITCHES.length;
    return everything ? t(`capabilities.previews.mayAll`, { list }) : t(`capabilities.previews.mayOnly`, { list });
};

/** The local model's RAM bill: weights plus context window. */
export const localModelMemorySummary = (values: Readonly<Record<string, string>>): string | undefined => {
    const { weightsGb, windowGb, totalGb } = localModelMemory(values);
    if (totalGb === undefined || weightsGb === undefined || windowGb === undefined) {
        return undefined;
    }
    return t(`capabilities.previews.localModelMemory`, { weights: weightsGb, window: windowGb, total: totalGb });
};

/** The sentence a tile's answers compose into under the form, for the kinds that have one. */
export const answersSummary = (kind: CapabilityKind | undefined, values: Readonly<Record<string, string>>): string | undefined => {
    if (kind === `wallet`) {
        return walletPolicySummary(values);
    }
    if (kind === `localmodel`) {
        return localModelMemorySummary(values);
    }
    return undefined;
};
