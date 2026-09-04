import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { hasSecretReferences, type NamedSecret, resolveSecretReferences } from "../secrets/secret-registry.js";
import { DETAIL_MAX } from "../secrets/secret-uses.js";

/* THE SHELL EXIT: where a `{{secret:name}}` reference becomes the real value, and the ONLY place inside a
 * command's journey where it does.
 *
 * The read path (agent-redaction.ts, the terminal filter) masks every stored value TO this token, so the
 * model can carry a credential through its context without ever holding it: read a config, see the reference,
 * write the reference into a curl body or a `komodo write/UpdateStack` payload, and the value is spliced in
 * here, after the permission card was shown and after the command gate ran, both of which therefore read and
 * display the agent's own reference-form line, never the value. Whatever the command echoes back is masked to
 * the reference again on the way in, closing the loop.
 *
 * Deliberately NOT wired into Edit/Write: a file at rest keeps the reference. A resolved value belongs in
 * transit (a request body, a keystroke) or at a destination outside the workspace; a workspace file holding
 * the raw value is one commit away from publishing it. The agent is told this rule in the system prompt, and
 * a heredoc that routes a reference into a file through THIS exit is an explicit, carded, audited act rather
 * than an accident.
 *
 * An unknown name is a HARD refusal, not a pass-through: a reference that survives as literal text is a
 * config holding "{{secret:...}}" where a credential should be, discovered only when the deploy 401s. The
 * refusal lists what exists, which is also how the model discovers the names it may use.
 *
 * Substitution is textual, standing exactly where the token stood, inside whatever quoting the agent chose.
 * A value containing a character that fights that quoting (a single quote inside a single-quoted body) breaks
 * the command visibly, which is the acceptable rare case; no env-var indirection survives quoting at all
 * (`'{"key":"$VAR"}'` sends the literal dollar). */

export interface SecretUseReport {
    readonly name: string;
    readonly lane: "shell" | "code" | "browser";
    readonly detail?: string;
    // Who released it, for a name the owner put behind a named approver. Absent on an ungated use, which is
    // nearly all of them: the row records a person only where a person was actually asked.
    readonly approvedBy?: string;
}

/* WHAT THE TURN HANDS EVERY SECRET-TOUCHING SEAM: the registry to read, the audit trail to feed, and the
 * approval gate to clear. `used` is fire-and-forget, persisting the row is the daemon's problem, never the
 * tool call's; `release` is the opposite, its answer decides whether the exit happens at all.
 *
 * `release` TAKES THE WHOLE LIST rather than one name at a time, because one command can carry several
 * references and the owner should be asked once per credential, not once per token. Names that share a
 * subject (`reddit/password` and `reddit/totp` are both the `reddit` capability) are one question; different
 * subjects are asked in turn. Ungated names cost nothing: the gate answers allow without reading a file when
 * no policy covers them. */
export interface SecretAccess {
    readonly list: () => Promise<readonly NamedSecret[]>;
    readonly used: (use: SecretUseReport) => void;
    readonly release: (
        names: readonly string[],
        lane: "shell" | "code" | "browser",
        detail: string,
    ) => Promise<{ readonly ok: true; readonly approvedBy?: Readonly<Record<string, string>> } | { readonly refusal: string }>;
}

// The audit row's "used where", from the agent's own command line, which is reference-form by construction.
// One head, not the whole line: enough to answer "used in what", without archiving shell history twice.
const commandDetail = (command: string): string => {
    const head = command.trim().replaceAll(/\s+/g, " ");
    return head.length <= DETAIL_MAX ? head : `${head.slice(0, DETAIL_MAX)}…`;
};

export type ResolvedCommand = { readonly command: string } | { readonly refusal: string };

/* Resolve a command's references against the registry, reporting each name used. Reads the registry only when
 * a token is present at all, the overwhelmingly common command names no secret and must not pay a vault read.
 * A registry that cannot be read refuses rather than passing the token through: both roads lose the command,
 * and this one says why.
 *
 * The JS execution backend is the second caller and the reason `lane` is a parameter: a script is the same
 * kind of transit a command line is, the reference resolves on the way into the subprocess, the audit row
 * says which exit spent it. */
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
    /* THE APPROVAL GATE, between "every name resolved" and "the value goes out".
     *
     * AFTER the all-names-known check, deliberately: a command naming one gated secret and one that does not
     * exist is a broken command, and asking a person to release a credential for it would spend their
     * attention on a turn that was going to fail anyway. BEFORE the audit rows, equally deliberately: the
     * ledger records what LEFT, and a refused resolution never left, so a row here would make the inventory's
     * "last used" a record of attempts. */
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

/* The no-tmux arm of the exit. When terminals are on, resolution rides INSIDE the tmux wrapper's own rewrite
 * (agent-terminals.ts), hook order across separate matchers is the SDK's, and two rewriters of one command
 * must compose in OUR order, so they are one pipeline there. This standalone matcher exists for the
 * configuration where that pipeline never runs and a Bash command would otherwise carry its token literally. */
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
