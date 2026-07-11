/* Cross-provider delegation via the shell: the Claude primary agent drives the user's connected Codex/Grok
 * accounts through their CLIs (`codex exec`, `opencode run`) from its ordinary Bash tool. The note below is
 * appended to the system prompt only for providers with a usable credential this turn, so a disconnected
 * provider is never offered. Shell-based on purpose: children run inside the agent's tmux session (watchable
 * live in the terminal panel, detached past the soft timeout with a follow log) and compose with everything
 * Bash can do — the container is the isolation boundary, same as every other agent command. */

export interface DelegationTargets {
    // The first connected Codex account's CODEX_HOME — streamAgent also injects it into the shell env, so
    // the codex CLI is pre-authenticated without the note naming any path.
    readonly codexHome?: string;
    // OpenCode's XDG_DATA_HOME (the credential root) when xAI/Grok is connected. Inlined per command in the
    // note — exporting XDG_DATA_HOME globally would redirect unrelated tools' data dirs.
    readonly openCodeXdg?: string;
    // The bare xAI model id the note names (`--model xai/<grokModel>`), resolved live from OpenCode's catalog
    // so it tracks xAI's renames. Absent ⇒ point the agent at `opencode models` to pick a current one.
    readonly grokModel?: string;
}

export const delegationNote = (targets: DelegationTargets): string | undefined => {
    if (targets.codexHome === undefined && targets.openCodeXdg === undefined) {
        return undefined;
    }
    const codex =
        targets.codexHome !== undefined
            ? "\n- Codex (OpenAI) — pre-authenticated via CODEX_HOME in your env:\n" +
              "  `codex exec --sandbox danger-full-access --skip-git-repo-check --cd <dir> '<task>'`\n" +
              "  It prints its thread id; continue that thread with `codex exec --sandbox danger-full-access resume <threadId> '<follow-up>'`."
            : "";
    const grokModelFlag = targets.grokModel !== undefined ? `--model xai/${targets.grokModel} ` : "";
    const grokModelHint = targets.grokModel !== undefined ? "" : ` List xAI's current models with \`opencode models\` and pass one as \`--model xai/<id>\`.`;
    const grok =
        targets.openCodeXdg !== undefined
            ? `\n- Grok (xAI) via OpenCode:\n` +
              `  \`XDG_DATA_HOME=${targets.openCodeXdg} opencode run ${grokModelFlag}'<task>'\`\n` +
              `  Continue a session with \`--session <id>\`. Set XDG_DATA_HOME per command exactly as shown; never export it.${grokModelHint}`
            : "";
    return (
        "## Delegating to other coding agents\n\n" +
        "The user's connected agent accounts are runnable from your shell. Delegates see none of this " +
        "conversation — give them a self-contained prompt with every path, requirement, and constraint. " +
        "Long runs detach into your tmux session after the soft timeout and hand back a follow log; tail it or " +
        "check back later." +
        codex +
        grok
    );
};
