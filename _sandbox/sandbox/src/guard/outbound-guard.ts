import type { AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import { classifyOutboundCall } from "../activity/outbound.js";
import { outboundSend } from "./actions.js";
import { guard } from "./guard.js";

// Enforcing half of the outbound sniffer: read by the shared command guard on every command any runtime runs.
// A hold refuses and points at the approvals queue instead of parking an unattended turn. Parses known command shapes;
// creative quoting can slip past, so this is policy, not a hard boundary.

const DRAFT_REDIRECT =
    "Instead of sending directly, write the message as an approval into .intentic/config/approvals/ (the approvals skill " +
    "has the format): the owner approves before anything posts, and that approval is what this rule asks for.";

/**
 * The owner's action rules on one command, whatever runtime runs it: the refusal for a classified outbound call (a post,
 * a send) the rules deny or hold, else undefined. Read inside the shared command guard (command-guard.ts), so every
 * runtime's gate checks it; until 2026-10-25 only the Claude Code loop's Bash hook did, and "hold posts as approvals" was
 * ignored on Codex, Cursor, OpenCode and Pi.
 */
export const outboundRefusal = (rules: Readonly<Record<string, AdmissionRule>>, command: string): string | undefined => {
    if (Object.keys(rules).length === 0) {
        return undefined;
    }
    const call = classifyOutboundCall(command);
    if (call === undefined) {
        return undefined;
    }
    const verdict = guard(outboundSend, { provider: call.provider, type: call.type, rules });
    if (verdict.effect === "allow") {
        return undefined;
    }
    return verdict.effect === "hold" ? `${verdict.reason}. ${DRAFT_REDIRECT}` : verdict.reason;
};
