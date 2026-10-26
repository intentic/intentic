import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { browserServerOfTool, holdBrowserSession, openBrowserSession } from "./browser-sessions.js";
import { ROUTED_BROWSER_SERVER } from "../tools/browser-tools.js";
import { z } from "zod";

const BrowserCallSchema = z.object({ account: z.string().optional() });

const holdBrowserCall = (held: Map<string, () => void>, key: string, name: string, signal: AbortSignal): void => {
    const release = holdBrowserSession(name);
    const cleanup = (): void => {
        signal.removeEventListener("abort", cleanup);
        release();
        held.delete(key);
    };
    held.set(key, cleanup);
    if (signal.aborted) {
        cleanup();
    } else {
        signal.addEventListener("abort", cleanup, { once: true });
    }
};

// Hooks that register or refresh a browser session: PreToolUse fires before Chromium launches, so the session appears
// at the start of navigation; PostToolUse stamps activity so a long turn keeps reading as active.
// ports/passkeys are the per-turn owner-to-port and owner-to-passkey-store maps from browser-tools.ts; accounts is the
// router's account-to-owner map, needed since a routed tool name alone doesn't say whose browser.
export const browserSessionHooks = (
    ports: Record<string, number>,
    passkeys: Record<string, string> = {},
    accounts: Record<string, string> = {},
    // Conversation this turn belongs to; carried on every record so the reaper can close by owner.
    owner?: string,
) => {
    const matcher = "mcp__.+__browser_.+";
    const touch = (server: string | undefined, sessionId: string): string | undefined => {
        const port = server === undefined ? undefined : ports[server];
        if (server === undefined || port === undefined) {
            return;
        }
        return openBrowserSession({ sessionId, server, port, passkeyStore: passkeys[server], owner });
    };
    const held = new Map<string, () => void>();
    const hooks: HookCallbackMatcher = {
        matcher,
        hooks: [async (input, _toolUseId, { signal }) => {
            if (input.hook_event_name === "PreToolUse" || input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") {
                const called = browserServerOfTool(input.tool_name);
                const parsed = BrowserCallSchema.safeParse(input.tool_input);
                const account = parsed.success ? parsed.data.account : undefined;
                const server = called === ROUTED_BROWSER_SERVER ? (account === undefined ? undefined : accounts[account]) : called;
                const name = touch(server, input.session_id);
                const key = input.tool_use_id;
                held.get(key)?.();
                held.delete(key);
                if (input.hook_event_name === "PreToolUse" && name !== undefined) {
                    holdBrowserCall(held, key, name, signal);
                }
            }
            return {};
        }],
    };
    return { PreToolUse: [hooks], PostToolUse: [hooks], PostToolUseFailure: [hooks] } satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;
};
