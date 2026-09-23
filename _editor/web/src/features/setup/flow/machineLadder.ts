import type { HostedOffer } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";

// The picker's rungs: one card per place the sandbox can run, each stating its cost and what it asks before it is
// clicked. A machine we host while the platform hosts at all, and the reader's own computer while a command can be
// minted for it; `value` doubles as the drawing's name (SetupRungArt), so rung and picture cannot drift.

export type Machine = `hosted` | `mine`;

export interface MachineOption {
    readonly value: Machine;
    // Answers 'what do I do', not 'whose machine'; that fact lives in `note`.
    readonly title: string;
    // The badge: what the rung costs, or why it cannot be taken right now.
    readonly meta: string;
    readonly note: string;
}

export interface LadderInput {
    readonly hostedOffered: boolean;
    readonly hostedFull: boolean;
    readonly hostedSuspended: boolean;
    // On the hosted plan (or comped): the machine is always on and no hours apply.
    readonly plan: boolean;
    // The free plan's hour budget, where one applies.
    readonly hours: NonNullable<HostedOffer[`hours`]> | null;
    readonly commandOffered: boolean;
    // The installer offered in place of the command, whose name the own-computer rung carries.
    readonly installer: { readonly label: string } | undefined;
}

// The hour ceiling and what follows it, never a bare 'Free'; a full fleet or a switched-off account says so instead
// of a price, and the rung stays on screen.
const hostedMeta = ({ hostedFull, hostedSuspended, plan, hours }: LadderInput): string => {
    if (hostedFull) {
        return `No machines free right now`;
    }
    if (hostedSuspended) {
        return `Switched off for this account`;
    }
    if (plan) {
        return `On your plan · always on`;
    }
    if (hours === null) {
        return `Free · ready in seconds`;
    }
    return hours.rampUntil === undefined
        ? `Free to try · ${hours.allowance}h a month, always on with the plan`
        : `Free to try · ${hours.allowance}h to start, more after your first days`;
};

export const ladderOptionsOf = (input: LadderInput): readonly MachineOption[] => [
    ...(input.hostedOffered
        ? [{ value: `hosted` as const, title: t(`setup.setup.startInstantly`), meta: hostedMeta(input), note: t(`setup.setup.runsOnOurServers`) }]
        : []),
    // The own machine says no more than its three lines; the note names the actual next step.
    ...(input.commandOffered
        ? [
              {
                  value: `mine` as const,
                  title: t(`setup.setup.myOwnComputer`),
                  meta: `Most power · no limits`,
                  note: input.installer === undefined ? `One pasted command` : `A ${input.installer.label} installer`,
              },
          ]
        : []),
];

// A rung asked for before this page (`?machine=`), only if it is on offer; anything else falls back to the default.
export const requestedRung = (options: readonly MachineOption[], asked: unknown): Machine | undefined =>
    options.find((option) => option.value === asked)?.value;
