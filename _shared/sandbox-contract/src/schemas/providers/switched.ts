import { z } from "zod";
import { AgentProviderSchema } from "../agent.js";
import { providerLabel } from "../../models/agent-catalog.js";
import { humanizeModelId } from "../../models/model-label.js";
import { providerSpec } from "../../models/provider-specs.js";
import type { SandboxNotice } from "../../events/sandbox-notice.js";

// WHEN A CONVERSATION CHANGES WHAT IT RUNS ON. A turn that goes out on another provider, account, loop or model than the
// conversation's turn before it says so once, as it starts, and the record keeps that as a row of its own: every
// window, device and reload then shows the same history. A window's own divider, drawn as a person picks, is only a
// preview of this, and it has been wrong (a stale window drew a switch that never happened). The daemon reads the
// switch off the conversation's record before and after the turn's `begin` (its agent/run/turn/turn-switch.ts).
//
// Provider, account and loop each retire the session, since a session lives on the runtime and account that minted it
// (the daemon's conversations/registry/routing.ts): the turn opens a fresh one, seeded from the record. A model alone
// keeps the session, and the new model reads the whole conversation once, on a cold cache. Effort, thinking and fast
// mode are no switch.

// What changed, named by the first of these that did.
export const SWITCH_SEGMENTS = ["provider", "account", "loop", "model"] as const;
export const SwitchSegmentSchema = z.enum(SWITCH_SEGMENTS);
export type SwitchSegment = z.infer<typeof SwitchSegmentSchema>;

export const SwitchedSchema = z.object({
    segment: SwitchSegmentSchema.describe("What changed: the provider, else the account, else the loop, else the model."),
    provider: AgentProviderSchema.describe("The provider the turn now runs on."),
    model: z.string().optional().describe("The model the turn now runs on, by id. Absent where the conversation names none."),
    account: z.string().optional().describe("What the account the turn now runs on is called in the sandbox. Absent where the sandbox has no name for it."),
    loop: z.string().optional().describe("What the loop the turn now runs through is called (Claude Code, Codex, OpenCode)."),
    fresh: z
        .boolean()
        .describe("Whether the turn opened a fresh session seeded from the record; false where it went on in the same session on another model."),
});
export type Switched = z.infer<typeof SwitchedSchema>;

export const switchedNotice = (event: Switched): Extract<SandboxNotice, { code: "switched" }> => {
    const params: Extract<SandboxNotice, { code: "switched" }>["params"] = { segment: event.segment, provider: event.provider, fresh: event.fresh };
    if (event.model !== undefined) {
        params.model = event.model;
    }
    if (event.account !== undefined) {
        params.account = event.account;
    }
    if (event.loop !== undefined) {
        params.loop = event.loop;
    }
    return { code: "switched", params };
};

/** What a provider's accounts are filed under ("Claude", "ChatGPT"), which an account the sandbox has no name for is said as. */
export const accountsLabel = (provider: string): string => providerSpec(provider)?.accountLabel ?? providerLabel(provider);

// What it switched to, named by the part that changed: an account switch said as "Switched to Claude Code" would name
// the provider the chat was already on.
const switchedTo = (event: Switched): string => {
    switch (event.segment) {
        case "provider":
            return `Switched to ${providerLabel(event.provider)}`;
        case "account":
            return event.account === undefined ? `Switched to another ${accountsLabel(event.provider)} account` : `Switched to the ${event.account} account`;
        case "loop":
            return event.loop === undefined ? "Switched to another loop" : `Switched to running through ${event.loop}`;
        case "model":
            return event.model === undefined ? "Switched to another model" : `Switched to ${humanizeModelId(event.model)}`;
    }
};

/** The transcript's line for a turn that switched what it runs on, in the English the record keeps. */
export const switchedLine = (event: Switched): string =>
    `${switchedTo(event)}: ${
        event.fresh ? "this message started a fresh session, with the conversation so far carried over." : "same session, so the model re-reads the conversation once."
    }`;
