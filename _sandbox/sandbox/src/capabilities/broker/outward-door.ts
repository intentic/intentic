import { randomUUID } from "node:crypto";
import { type CapabilityContribution, holdsUnruled } from "@intentic/extension-manifest";
import type { ActivityEvent } from "@intentic/sandbox-contract/schemas/activity";
import type { ActionApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import type { OutwardActionVerdict } from "@intentic/sandbox-contract/schemas/outward-action";
import type { AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import { ORPCError } from "@orpc/server";
import { ERROR_TAIL } from "../../activity/outbound.js";
import { outboundSend } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { opt } from "../../opt.js";

// THE OWNER'S ACTION RULES FOR WHAT AN EXTENSION'S BACKEND SENDS WITH A CARD'S CREDENTIAL (2026-11-26). A card whose
// credential stays in its extension's backend (IMAP's and Microsoft 365's senders) never hands the agent anything to send
// with, so the backend is the only place its send can happen, and it asks here first: this decides the rule, records the
// action in Activity, and on a hold drafts the approvals-queue item that names the extension as its `performer`, which the
// approvals executor hands to the backend only after it matched and spent a person's yes (approvals/approval-performers.ts).
// The verdict is the one the command guard and the credential gateway give (guard/outbound-guard.ts); nothing of the
// rule is the extension's. Before, each CLI read `actionRules` and the approval's status from workspace files the agent
// writes, while the card's password sat in the agent's environment.

type CliSpec = Extract<CapabilityContribution, { kind: "cli" }>;

// One card as the door reads it: its kind's declaration and who contributes it.
export interface DoorCard {
    readonly id: string;
    readonly spec: CliSpec;
    // The install id the extension's token resolves to.
    readonly extension: string;
    // Its `publisher.name`, which an approval's `performer` names.
    readonly performer: string;
}

export interface OutwardDoorDeps {
    readonly card: (id: string) => Promise<DoorCard | undefined>;
    // SandboxSettings.actionRules as the daemon reads them, organisation pins applied.
    readonly actionRules: () => Promise<Readonly<Record<string, AdmissionRule>>>;
    readonly propose: (item: ActionApprovalSummary) => Promise<void>;
    readonly record: (row: Omit<ActivityEvent, "id" | "at">) => Promise<void>;
    // The turn the conversation is running now, so the row folds into it.
    readonly runningTurn: (conversationId: string) => string | undefined;
    readonly newId?: () => string;
    readonly now?: () => number;
}

export interface OutwardCall {
    readonly id: string;
    readonly action: string;
    readonly conversationId?: string | undefined;
    readonly endpoint?: string | undefined;
    readonly channel?: string | undefined;
    readonly content?: string | undefined;
}

export interface OutwardAsk extends OutwardCall {
    readonly hold?: { readonly summary: string; readonly details: string; readonly digest: string } | undefined;
}

export interface OutwardOutcome extends OutwardCall {
    readonly outcome: "ok" | "error";
    readonly error?: string | undefined;
}

interface Declared {
    readonly read: boolean;
    readonly unruled: AdmissionRule | undefined;
}

// The action as the card declares it, for its tools (`commandActions`) or its gateway requests (`broker.actions`):
// undefined when it declares no such action, so an extension asks only about what Guardrails offers a rule for. While no
// rule names it, it comes to what its declarations say (`unruled`; the mail senders hold, as they always did).
const declaredAction = (spec: CliSpec, action: string): Declared | undefined => {
    const commands = (spec.commandActions ?? []).filter((entry) => entry.action === action);
    const requests = (spec.broker?.actions ?? []).filter((entry) => entry.action === action);
    if (commands.length === 0 && requests.length === 0) {
        return undefined;
    }
    return {
        read: [...commands, ...requests].every((entry) => entry.read === true),
        unruled: holdsUnruled(commands) ? "hold" : undefined,
    };
};

const resolve = async (deps: OutwardDoorDeps, caller: string, input: OutwardCall): Promise<{ card: DoorCard; declared: Declared }> => {
    const card = await deps.card(input.id);
    if (card === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `no connected card "${input.id}" of a kind an extension contributes` });
    }
    if (card.extension !== caller) {
        throw new ORPCError("FORBIDDEN", { message: `"${card.id}" is not a connection extension "${caller}" contributes` });
    }
    const declared = declaredAction(card.spec, input.action);
    if (declared === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: `the ${card.spec.id} card declares no outward action "${input.action}"` });
    }
    return { card, declared };
};

// The row in the shape a command's and a gateway request's take (activity/outbound.ts).
const rowOf = (deps: OutwardDoorDeps, card: DoorCard, declared: Declared, input: OutwardCall): Omit<ActivityEvent, "id" | "at"> => ({
    provider: card.spec.id,
    type: input.action,
    direction: "out",
    method: declared.read ? "GET" : "POST",
    endpoint: input.endpoint ?? `/${input.action.replaceAll(".", "/")}`,
    ...opt("channelId", input.channel),
    ...opt("content", input.content),
    ...opt("conversationId", input.conversationId),
    ...opt("turnId", input.conversationId === undefined ? undefined : deps.runningTurn(input.conversationId)),
});

// An approval id the queue accepts as a file name (entryId: 60 characters at most), led by the card's kind.
const approvalIdOf = (kind: string, uuid: string): string => `${kind.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20)}-${uuid}`;

/**
 * The owner's verdict on one outward action an extension's backend is about to carry out with its own card: allow;
 * deny with the rule's reason; or hold, drafted into the approvals queue for the extension to carry out once a person
 * says yes when the ask brings a draft. A refusal and a hold are recorded here; an allowed action is recorded by its
 * outcome.
 */
export const askOutward = async (deps: OutwardDoorDeps, caller: string, input: OutwardAsk): Promise<OutwardActionVerdict> => {
    const { card, declared } = await resolve(deps, caller, input);
    const verdict = guard(outboundSend, {
        provider: card.spec.id,
        type: input.action,
        rules: await deps.actionRules(),
        ...opt("unruled", declared.unruled),
    });
    if (verdict.effect === "allow") {
        return { verdict: "allow" };
    }
    const row = rowOf(deps, card, declared, input);
    if (verdict.effect === "deny") {
        await deps.record({ ...row, outcome: "error", error: verdict.reason.slice(0, ERROR_TAIL) });
        return { verdict: "deny", reason: verdict.reason };
    }
    if (input.hold === undefined) {
        return { verdict: "hold", reason: verdict.reason };
    }
    const id = approvalIdOf(card.spec.id, (deps.newId ?? randomUUID)());
    await deps.propose({
        id,
        kind: "action",
        summary: input.hold.summary,
        details: input.hold.details,
        instructions: `Carried out by the ${card.spec.catalog.name} connection itself (${card.performer}) once you approve it, with the "${card.id}" card: no agent turn runs for it, and it refuses if what it holds no longer matches what you approved.`,
        performer: { extension: card.performer, digest: input.hold.digest },
        status: "proposed",
        createdAt: (deps.now ?? Date.now)(),
    });
    await deps.record({ ...row, outcome: "error", error: `held for the owner's approval as ${id}; nothing was sent` });
    return { verdict: "hold", reason: verdict.reason, approvalId: id };
};

/** The Activity row for an action the rules allowed or a person approved, once the service answered. */
export const recordOutward = async (deps: OutwardDoorDeps, caller: string, input: OutwardOutcome): Promise<void> => {
    const { card, declared } = await resolve(deps, caller, input);
    await deps.record({ ...rowOf(deps, card, declared, input), outcome: input.outcome, ...opt("error", input.error?.slice(0, ERROR_TAIL)) });
};
