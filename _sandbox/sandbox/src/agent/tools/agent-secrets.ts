import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { hasSecretReferences, type NamedSecret, resolveSecretReferences } from "../../secrets/secret-registry.js";
import { DETAIL_MAX } from "../../secrets/secret-uses.js";

// The only place a `{{secret:name}}` reference becomes its real value, after the permission card and command gate have
// already seen the reference-form line. Not wired into Edit/Write: a file at rest keeps the reference, never the value.
// An unknown name is a hard refusal; substitution is textual, inside whatever quoting the agent chose.

export interface SecretUseReport {
    readonly name: string;
    readonly lane: "shell" | "code" | "browser";
    readonly detail?: string;
    // Who released it, for a name behind a named approver; absent on the ordinary ungated use.
    readonly approvedBy?: string;
}

// `used` is fire-and-forget; `release` decides whether the exit happens, and takes the whole list so the owner is asked
// once per credential (names sharing a subject), not once per token.
export interface SecretAccess {
    readonly list: () => Promise<readonly NamedSecret[]>;
    readonly used: (use: SecretUseReport) => void;
    readonly release: (
        names: readonly string[],
        lane: "shell" | "code" | "browser",
        detail: string,
    ) => Promise<{ readonly ok: true; readonly approvedBy?: Readonly<Record<string, string>> } | { readonly refusal: string }>;
}

// The audit row's "used where", from the agent's own reference-form command line; one head, not the whole line, avoids
// archiving shell history twice.
const commandDetail = (command: string): string => {
    const head = command.trim().replaceAll(/\s+/g, " ");
    return head.length <= DETAIL_MAX ? head : `${head.slice(0, DETAIL_MAX)}…`;
};

export type ResolvedCommand = { readonly command: string } | { readonly refusal: string };

// Skips the registry read when the command has no reference at all. An unreadable registry refuses rather than passing
// the token through. `lane` exists because the JS execution backend is a second caller, resolving into its own
// subprocess.
export const resolveCommandSecrets = async (command: string, secrets: SecretAccess, lane: "shell" | "code" = "shell"): Promise<ResolvedCommand> => {
    if (!hasSecretReferences(command)) {
        return { command };
    }
    let registry: readonly NamedSecret[];
    try {
        registry = await secrets.list();
    } catch {
        return { refusal: "the secret store could not be read, the reference cannot be resolved; retry, or run the command without it" };
    }
    const { text, used, unknown } = resolveSecretReferences(command, registry);
    if (unknown.length > 0) {
        const known = registry.map((secret) => secret.name);
        return {
            refusal: `no stored secret named ${unknown.map((name) => `"${name}"`).join(", ")}: ${
                known.length === 0 ? "nothing is stored yet; ask the owner to add it on the Secrets view" : `stored names: ${known.join(", ")}`
            }`,
        };
    }
    // After the all-names-known check: a command with one gated and one nonexistent name shouldn't spend anyone's
    // attention. Before the audit rows: a refused resolution never left, so recording it would corrupt last-used.
    const detail = commandDetail(command);
    const released = await secrets.release(used, lane, detail);
    if ("refusal" in released) {
        return { refusal: released.refusal };
    }
    for (const name of used) {
        const approvedBy = released.approvedBy?.[name];
        secrets.used({ name, lane, detail, ...(approvedBy !== undefined ? { approvedBy } : {}) });
    }
    return { command: text };
};

// The no-tmux arm: when terminals are on, resolution happens inside the tmux wrapper's own rewrite instead, since hook
// order across separate matchers is the SDK's to decide. This one covers the configuration where that pipeline never
// runs.
export const secretCommandHooks = (secrets: SecretAccess): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PreToolUse: [
        {
            matcher: "Bash",
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    const tool = input.tool_input as { command?: unknown };
                    if (typeof tool.command !== "string" || !hasSecretReferences(tool.command)) {
                        return {};
                    }
                    const resolved = await resolveCommandSecrets(tool.command, secrets);
                    if ("refusal" in resolved) {
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                permissionDecision: "deny",
                                permissionDecisionReason: resolved.refusal,
                            },
                        };
                    }
                    return {
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            updatedInput: { ...(tool as Record<string, unknown>), command: resolved.command },
                        },
                    };
                },
            ],
        },
    ],
});
