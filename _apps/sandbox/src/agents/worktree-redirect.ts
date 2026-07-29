import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { type IsolationPlan, inWorktree } from "./isolation.js";

/* WHEN THE MOUNTS CANNOT BE BUILT — the same guarantee, enforced one layer up.
 *
 * isolation.ts makes an isolated turn's worktree BE the workspace root by bind-mounting it over /work, so an
 * absolute path the agent inherited from a memory, a CLAUDE.md, a user message or its own earlier turn simply
 * names its own space. That needs CAP_SYS_ADMIN, and a container launched without it (docker's default seccomp
 * refuses both `unshare --mount` and the user-namespace fallback) gets NO namespace at all. The turn then runs
 * cwd'd into its worktree while /work stays the shared checkout — writable, at the exact path everything names.
 *
 * That is not a theoretical gap. It is what put a whole extension package and a new source file into the main
 * tree, unattributed, while three agents believed they were working on their own branches: the Changes panel
 * showed edits `land` had never seen (agents/origins.ts), and the worktrees they were supposed to be in stayed
 * empty.
 *
 * So when the mounts are unavailable the redirect moves to the only other layer that dictates a path: the tool
 * call itself. Every absolute path under the workspace root is rewritten into the conversation's worktree
 * before the tool runs — silently, with nothing refused and nothing to remember. The agent is not told to
 * avoid /work and not blocked from it; /work simply resolves to its own tree, which is what the namespace
 * would have done. Writing to the main checkout on purpose stays possible through MAIN_MOUNT, exactly as it is
 * under a real namespace.
 *
 * This is deliberately the same bet browser-artifacts.ts makes about screenshot filenames, for the same
 * reason: a convention only holds for the agents that happen to read it, so the layer that decides the path
 * has to decide it. The difference from a guard is the point — a refusal costs the agent a retry and teaches
 * it nothing, while a rewrite costs it nothing at all.
 *
 * SECOND-BEST ON PURPOSE. A namespace covers every path a process can produce; this covers the paths that
 * arrive as tool input. A subprocess that computes a path itself (a script reading $PWD's parent, a tool with
 * its own config) still reaches the shared tree. Restoring CAP_SYS_ADMIN is the fix; this is what keeps a
 * degraded container honest until it is recreated.
 */

// Regex-escape a path for embedding in the command matcher below.
const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/* Absolute root paths inside a shell command. A Bash tool call is one opaque string, so the rewrite has to
 * find the paths in it — and the workspace root is a distinctive enough token to do that safely:
 *
 *  - the lookbehind refuses a root that is part of a LONGER path (`/mnt/intentic-main/work`, `./work`), which
 *    is what keeps the deliberate main-tree door (MAIN_MOUNT) working under the redirect;
 *  - the trailing class stops at the characters that end a word in shell — whitespace, quotes, and the
 *    separators that follow a path in real command lines — so `cd /work/intentic && …` and `ls "/work/x";`
 *    both yield the path and nothing after it.
 */
const commandPaths = (root: string): RegExp => new RegExp(String.raw`(?<![\w./-])${escapeRegExp(root)}(?:/[^\s'"\`;:,)\]}]*)?`, "g");

/* HEREDOC BODIES ARE CONTENT, NOT PATHS — the one place this rewrite must keep its hands off.
 *
 * `cat > x.md <<'EOF' … EOF` and `python3 - <<'PY' … PY` are how an agent writes a FILE through the shell,
 * and the body is data on its way to disk. A workspace path in there is almost never a path the command will
 * act on; it is documentation, a comment, a test fixture, a commit message. Rewriting it corrupts the file
 * that gets written, silently, with a path that is meaningless outside one conversation.
 *
 * This was first shipped as an accepted tradeoff ("a path named in prose is far more often one the agent is
 * about to use"). That was wrong, and it took about an hour to prove: the very commit adding this feature had
 * three shell scripts' comments rewritten mid-edit, each left naming a worktree that will not exist tomorrow.
 * The redirect's whole promise is that the agent cannot tell the difference — a rewrite it can SEE in its own
 * output breaks that promise more thoroughly than the missing mount ever did.
 *
 * Scanning for the delimiters is enough and needs no shell parser: `<<`, an optional `-`, an optional quote,
 * the word, then everything up to a line that is that word alone (indented too, for `<<-`). Anything that
 * confuses this scan simply leaves the region unrewritten, which is the safe direction.
 */
const HEREDOC_START = /<<-?\s*(["']?)([A-Za-z_][\w]*)\1/g;

// The [start, end) spans of every heredoc BODY in the command, in order.
const heredocSpans = (command: string): { start: number; end: number }[] => {
    const spans: { start: number; end: number }[] = [];
    for (const match of command.matchAll(HEREDOC_START)) {
        const word = match[2];
        if (word === undefined) {
            continue;
        }
        // The body opens on the line after the one carrying the delimiter, and runs to a line holding the
        // word alone. An unterminated heredoc (the agent's command was truncated) protects the rest.
        const bodyStart = command.indexOf("\n", match.index + match[0].length);
        if (bodyStart === -1) {
            continue;
        }
        const terminator = new RegExp(String.raw`^[ \t]*${word}[ \t]*$`, "m");
        const rest = terminator.exec(command.slice(bodyStart));
        spans.push({ start: bodyStart, end: rest === null ? command.length : bodyStart + rest.index });
    }
    return spans;
};

// Rewrite every main-root path in a shell command, outside heredoc bodies. Shared by the Bash hook and
// exported for the terminal wrapper, which composes the command line that a tmux pane actually runs.
export const redirectCommand = (command: string, plan: IsolationPlan): string => {
    const spans = heredocSpans(command);
    return command.replaceAll(commandPaths(plan.root), (match, ...rest) => {
        const at = rest.at(-2) as number;
        return spans.some((span) => at >= span.start && at < span.end) ? match : inWorktree(match, plan);
    });
};

/* The built-in tools that take a path as STRUCTURED input, and the field each one calls it. These are the
 * calls a rewrite can serve exactly — no parsing, no ambiguity about what is a path — which is why they are
 * enumerated rather than matched by shape. Read and the search tools are here beside the writers on purpose:
 * a turn whose Edit lands in the worktree while its Read answers from the main tree is the half-isolation
 * that agent-terminals.ts warns about, and it reads to the agent as an edit that silently did not apply.
 */
const PATH_FIELDS: Record<string, string> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    NotebookEdit: "notebook_path",
    Glob: "path",
    Grep: "path",
};

export const worktreeRedirectHooks = (plan: IsolationPlan): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PreToolUse: [
        {
            matcher: Object.keys(PATH_FIELDS).join("|"),
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    const field = PATH_FIELDS[input.tool_name];
                    if (field === undefined) {
                        return {};
                    }
                    const toolInput = input.tool_input as Record<string, unknown>;
                    const path = toolInput[field];
                    if (typeof path !== "string") {
                        return {};
                    }
                    const target = inWorktree(path, plan);
                    if (target === path) {
                        return {};
                    }
                    // No additionalContext: the agent asked for a path and gets that path's contents in its own
                    // tree, which is the whole fiction the namespace maintains for free. Narrating the swap on
                    // every call would spend context re-teaching a layout it never needed to know.
                    return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, [field]: target } } };
                },
            ],
        },
    ],
});
