import { type BrokerAction, type CapabilityContribution, type CommandAction, holdsUnruled } from "@intentic/extension-manifest";
import type { OutwardAction } from "@intentic/sandbox-contract/schemas/data-protection";
import type { DeclaredCommand } from "../../activity/outbound.js";
import { contributionRegistry } from "../contributions.js";
import type { ExtensionHost } from "../extension-inventory/installed-extensions.js";

// The outward actions the enabled extensions declare, read off the cli cards they contribute (`broker.actions` and
// `commandActions`), each under its card's id: what Guardrails and the public-office preset offer a rule for, and what the
// command guard and the turn's record recognise in a command. The credential gateway reads a card's own declaration
// as it serves a request (broker-actions.ts). The first extension to contribute a card id is the one read, as for
// every other part of a card (contributions.ts).

export interface OutwardActions {
    // Every action that is not only a read, once each, in the order the cards and their declarations give.
    readonly offered: readonly OutwardAction[];
    // Every declared command action, the ones a backend gates included (classifyCommand skips those).
    readonly commands: readonly DeclaredCommand[];
}

type GateFields = Pick<CommandAction, "gatedBy" | "unruled" | "selfGated">;

// (2026-11-26) What an action comes to while no rule names it is its declaration's `unruled` (the IMAP and Microsoft 365
// senders hold): one of its declarations saying `hold` holds it (holdsUnruled), and every other action is allowed then.
// Until then it was inferred from `selfGated`, which still reads as holding (commandActionGate).

const offeredOf = (provider: string, extension: string, actions: readonly (Pick<BrokerAction, "action" | "read"> & GateFields)[]): OutwardAction[] =>
    actions
        .filter((entry) => entry.read !== true)
        .map((entry) => (holdsUnruled([entry]) ? { key: `${provider}.${entry.action}`, extension, unruled: "hold" } : { key: `${provider}.${entry.action}`, extension }));

// One contributed card and the extension it comes from: what the contribution registry holds, one per card id.
export interface DeclaringCard {
    readonly spec: CapabilityContribution;
    readonly extension: { readonly id: string };
}

/** The outward actions a set of cards declares, in their order; pure, so a suite can hand it manifests as they are. */
export const outwardActionsFrom = (cards: Iterable<DeclaringCard>): OutwardActions => {
    const offered = new Map<string, OutwardAction>();
    const commands: DeclaredCommand[] = [];
    for (const { spec, extension } of cards) {
        if (spec.kind !== "cli") {
            continue;
        }
        const declared = spec.commandActions ?? [];
        for (const entry of [...offeredOf(spec.id, extension.id, spec.broker?.actions ?? []), ...offeredOf(spec.id, extension.id, declared)]) {
            if (!offered.has(entry.key)) {
                offered.set(entry.key, entry);
            }
        }
        commands.push(...declared.map((entry) => ({ ...entry, provider: spec.id })));
    }
    return { offered: [...offered.values()], commands };
};

export const outwardActionsOf = async (host: ExtensionHost): Promise<OutwardActions> => outwardActionsFrom((await contributionRegistry(host)).values());
