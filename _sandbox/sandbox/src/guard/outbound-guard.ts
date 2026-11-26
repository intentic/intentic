import { holdsUnruled } from "@intentic/extension-manifest";
import type { AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import { classifyCommand, type DeclaredCommand, type OutboundCall } from "../activity/outbound.js";
import { outboundSend } from "./actions.js";
import { guard } from "./guard.js";
import { opt } from "../opt.js";

// The owner's action rules on an outward action, wherever the sandbox sees one: the shared command guard reads a command
// of an extension's own tool, and the credential gateway reads a request on its way to the service
// (capabilities/broker/broker-actions.ts). A hold refuses and points at the approvals queue instead of parking an
// unattended turn. Both classify by what the enabled extensions declare (activity/outbound.ts), so neither knows a
// provider.

const DRAFT_REDIRECT =
    "Instead of sending directly, write the message as an approval into .intentic/config/approvals/ (the approvals skill " +
    "has the format): the owner approves before anything posts, and that approval is what this rule asks for.";

/**
 * The refusal the owner's rules give one classified action, a deny's reason or a hold's redirect, else undefined.
 * `unruled` is what it comes to while no rule names it (its declaration's, holdsUnruled): allow unless it says hold.
 */
export const actionRefusal = (
    rules: Readonly<Record<string, AdmissionRule>>,
    call: Pick<OutboundCall, "provider" | "type">,
    unruled?: AdmissionRule,
): string | undefined => {
    if (Object.keys(rules).length === 0 && unruled === undefined) {
        return undefined;
    }
    const verdict = guard(outboundSend, { provider: call.provider, type: call.type, rules, ...opt("unruled", unruled) });
    if (verdict.effect === "allow") {
        return undefined;
    }
    return verdict.effect === "hold" ? `${verdict.reason}. ${DRAFT_REDIRECT}` : verdict.reason;
};

/**
 * The owner's action rules on one command, whatever runtime runs it: the refusal for a declared outward command (a send)
 * the rules deny or hold, or that holds while no rule names it (`unruled: "hold"`), else undefined. Read inside the shared command guard (command-guard.ts), so every runtime's
 * gate checks it; until 2026-10-25 only the Claude Code loop's Bash hook did, and "hold posts as approvals" was ignored
 * on Codex, Cursor, OpenCode and Pi.
 */
export const outboundRefusal = (
    rules: Readonly<Record<string, AdmissionRule>>,
    command: string,
    commands: readonly DeclaredCommand[],
): string | undefined => {
    const call = classifyCommand(commands, command);
    if (call === undefined) {
        return undefined;
    }
    const declared = commands.filter((entry) => entry.provider === call.provider && entry.action === call.type);
    return actionRefusal(rules, call, holdsUnruled(declared) ? "hold" : undefined);
};
