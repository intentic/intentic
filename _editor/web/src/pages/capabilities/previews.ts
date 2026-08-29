import { localModelMemory } from "@intentic-app/capability-catalog";

/* WHAT THE ANSWERS ADD UP TO, said back in a sentence while they are being given. Three cards ask questions
 * whose consequences live in the reader's head: the wallet's numbers compose into a spending policy, a
 * computer's six switches compose into a grant, the local model's two choices compose into a RAM bill. Each
 * used to be explained in prose beside the fields; a sentence computed FROM the fields is shorter, always
 * current, and is the actual thing being agreed to. Pure functions over the form's values, pinned in tests. */

const usd = (value: string | undefined): number | undefined => {
    const amount = Number((value ?? ``).replace(/[$,\s]/gu, ``));
    return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
};

const dollars = (amount: number): string => `$${amount.toFixed(amount === Math.trunc(amount) && amount >= 10 ? 0 : 2)}`;

/** The wallet's spending policy as one sentence, undefined while a number is unparseable. */
export const walletPolicySummary = (values: Readonly<Record<string, string>>): string | undefined => {
    const perPayment = usd(values[`perPaymentMaxUsd`]);
    const daily = usd(values[`dailyCapUsd`]);
    const auto = usd(values[`autoApproveUnderUsd`]);
    if (perPayment === undefined || daily === undefined || auto === undefined) {
        return undefined;
    }
    const asks =
        auto <= 0 ? `Every payment asks you in chat first` : `Payments under ${dollars(auto)} go through on their own, the rest ask you first`;
    return `${asks} · at most ${dollars(perPayment)} each · ${dollars(daily)} a day.`;
};

// ---------------------------------------------------------------------------
// A connected computer's grant: presets over the switches, and the sentence.
// ---------------------------------------------------------------------------

// The switch keys a host card carries (HOST_SCOPE_FIELDS), in the order the sentence names them.
const HOST_SWITCHES = [`shell`, `write`, `screen`, `control`, `sandboxes`, `sandboxRemove`, `destructive`] as const;
type HostSwitch = (typeof HOST_SWITCHES)[number];

const GRANT_WORDS: Readonly<Record<HostSwitch, string>> = {
    shell: `run commands`,
    write: `change files`,
    screen: `see the screen`,
    control: `use the mouse and keyboard`,
    sandboxes: `manage its sandboxes`,
    sandboxRemove: `remove its sandboxes`,
    destructive: `delete folders and wipe disks`,
};

export interface HostPreset {
    readonly key: string;
    readonly label: string;
    readonly grants: Readonly<Record<HostSwitch, `on` | `off`>>;
}

/* Three postures a person actually means, over seven switches nobody wants to think about one by one. The two
 * grants nothing undoes, removing a sandbox and running a destructive command, stay off even at Full control:
 * a preset is a convenience, and neither of those is a thing to hand somebody by picking a convenient label. */
export const HOST_PRESETS: readonly HostPreset[] = [
    {
        key: `observe`,
        label: `Observe`,
        grants: { shell: `off`, write: `off`, screen: `on`, control: `off`, sandboxes: `off`, sandboxRemove: `off`, destructive: `off` },
    },
    {
        key: `operate`,
        label: `Operate`,
        grants: { shell: `on`, write: `off`, screen: `on`, control: `off`, sandboxes: `off`, sandboxRemove: `off`, destructive: `off` },
    },
    {
        key: `full`,
        label: `Full control`,
        grants: { shell: `on`, write: `on`, screen: `on`, control: `on`, sandboxes: `on`, sandboxRemove: `off`, destructive: `off` },
    },
];

/** The preset the switches currently spell, or undefined when they are a hand-tuned mix. */
export const matchHostPreset = (values: Readonly<Record<string, string>>): string | undefined =>
    HOST_PRESETS.find((preset) => HOST_SWITCHES.every((key) => (values[key] ?? `off`) === preset.grants[key]))?.key;

/* The grant the switches add up to, said in one line: what is ALLOWED, and nothing else. Naming the blocked
 * half too was the obvious first draft and it is the wrong one: six switches means the "may not" clause is
 * usually four items long, so the sentence grew to three lines and buried the half that matters. What is
 * granted is short, is what the reader is deciding, and "and nothing else" carries the rest exactly. */
export const hostGrantSummary = (values: Readonly<Record<string, string>>): string => {
    const allowed = HOST_SWITCHES.filter((key) => values[key] === `on`).map((key) => GRANT_WORDS[key]);
    if (allowed.length === 0) {
        return `Read files only.`;
    }
    const list = allowed.length === 1 ? allowed[0] : `${allowed.slice(0, -1).join(`, `)} and ${allowed[allowed.length - 1]}`;
    const everything = allowed.length === HOST_SWITCHES.length;
    return `May ${list}${everything ? `.` : `, and nothing else.`}`;
};

/** The local model's RAM bill, the sum the card used to ask its reader to do. */
export const localModelMemorySummary = (values: Readonly<Record<string, string>>): string | undefined => {
    const { weightsGb, windowGb, totalGb } = localModelMemory(values);
    if (totalGb === undefined || weightsGb === undefined || windowGb === undefined) {
        return undefined;
    }
    return `≈ ${weightsGb} GB weights + ${windowGb} GB window: needs ${totalGb} GB of free RAM.`;
};
