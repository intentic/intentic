import type { HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { inWorktree, type IsolationPlan } from "./isolation.js";
import { redirectCommand, worktreeRedirectHooks } from "./worktree-redirect.js";

const plan: IsolationPlan = {
    worktree: "/history/worktrees/abc",
    root: "/work",
    mirrors: ["node_modules", "intentic/node_modules", "intentic/_editor/web/node_modules", "intentic/_editor/web/dist"],
    overlays: "/history/overlays/abc",
};

// The tool input a PreToolUse hook actually returns, or undefined when it declined to rewrite anything.
const rewritten = async (
    toolName: string,
    toolInput: Record<string, unknown>,
    hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = worktreeRedirectHooks(plan),
): Promise<Record<string, unknown> | undefined> => {
    const hook = hooks.PreToolUse?.[0]?.hooks[0];
    const result = await hook?.(
        { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s" } as unknown as HookInput,
        undefined,
        { signal: new AbortController().signal },
    );
    return (result as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } } | undefined)?.hookSpecificOutput?.updatedInput;
};

test("a main-root path becomes the same path inside the conversation's worktree", () => {
    expect(inWorktree("/work/intentic/_editor/web/src/main.ts", plan)).toBe("/history/worktrees/abc/intentic/_editor/web/src/main.ts");
    // The root itself is the worktree root — `ls /work` must list the agent's own tree, not the shared one.
    expect(inWorktree("/work", plan)).toBe("/history/worktrees/abc");
});

test("the subtrees that mean the main checkout on both sides survive the redirect", () => {
    // Daemon state: chat transcripts live here and ~/.claude/projects symlinks into it, so a per-worktree copy
    // is a lost transcript.
    expect(inWorktree("/work/.intentic/sessions/claude/projects/x.jsonl", plan)).toBe("/work/.intentic/sessions/claude/projects/x.jsonl");
    // Every installed dependency tree, at each depth the plan recorded.
    expect(inWorktree("/work/node_modules/.bin/tsgo", plan)).toBe("/work/node_modules/.bin/tsgo");
    expect(inWorktree("/work/intentic/node_modules/vue/index.js", plan)).toBe("/work/intentic/node_modules/vue/index.js");
    expect(inWorktree("/work/intentic/_editor/web/node_modules/x", plan)).toBe("/work/intentic/_editor/web/node_modules/x");
    // Build output is mirrored on the same terms, so it carves out on the same terms — a `dist` entry the
    // worktree only has because the main tree does must not be looked for inside the worktree.
    expect(inWorktree("/work/intentic/_editor/web/dist/index.js", plan)).toBe("/work/intentic/_editor/web/dist/index.js");
});

test("paths outside the workspace root are the same file in both trees and are left alone", () => {
    expect(inWorktree("/tmp/scratch.txt", plan)).toBe("/tmp/scratch.txt");
    expect(inWorktree("/root/.claude/memory/MEMORY.md", plan)).toBe("/root/.claude/memory/MEMORY.md");
    // The deliberate main-tree door an isolated turn uses when it genuinely means the shared checkout.
    expect(inWorktree("/mnt/intentic-main/intentic/x.ts", plan)).toBe("/mnt/intentic-main/intentic/x.ts");
    // A sibling whose name merely starts with the root's.
    expect(inWorktree("/workspace/x", plan)).toBe("/workspace/x");
});

test("every built-in that takes a path as structured input is redirected, under its own field name", async () => {
    expect(await rewritten("Edit", { file_path: "/work/intentic/x.ts", old_string: "a", new_string: "b" })).toEqual({
        file_path: "/history/worktrees/abc/intentic/x.ts",
        old_string: "a",
        new_string: "b",
    });
    expect((await rewritten("Write", { file_path: "/work/new.ts", content: "x" }))?.["file_path"]).toBe("/history/worktrees/abc/new.ts");
    expect((await rewritten("NotebookEdit", { notebook_path: "/work/n.ipynb" }))?.["notebook_path"]).toBe("/history/worktrees/abc/n.ipynb");
    // Readers and searchers too: an Edit that lands in the worktree while Read answers from the main tree
    // reads to the agent as an edit that silently did not apply.
    expect((await rewritten("Read", { file_path: "/work/intentic/x.ts" }))?.["file_path"]).toBe("/history/worktrees/abc/intentic/x.ts");
    expect((await rewritten("Grep", { pattern: "x", path: "/work/intentic" }))?.["path"]).toBe("/history/worktrees/abc/intentic");
});

test("a call that needs no redirect is passed through untouched", async () => {
    // Already in the worktree, outside the root, in a shared subtree, or carrying no path at all.
    expect(await rewritten("Read", { file_path: "/history/worktrees/abc/intentic/x.ts" })).toBeUndefined();
    expect(await rewritten("Read", { file_path: "/tmp/x.ts" })).toBeUndefined();
    expect(await rewritten("Read", { file_path: "/work/node_modules/x" })).toBeUndefined();
    expect(await rewritten("Grep", { pattern: "x" })).toBeUndefined();
    // A tool with no path field of its own must never be touched by the matcher's regex neighbours.
    expect(await rewritten("Bash", { command: "ls /work" })).toBeUndefined();
});

test("a shell command has each of its main-root paths rewritten, and nothing else", () => {
    expect(redirectCommand("cd /work/intentic && ./node_modules/.bin/vitest run", plan)).toBe(
        "cd /history/worktrees/abc/intentic && ./node_modules/.bin/vitest run",
    );
    // Several paths in one line, including a quoted one and one followed by shell punctuation.
    expect(redirectCommand(`cp "/work/a.ts" /work/b.ts; ls /work`, plan)).toBe(
        `cp "/history/worktrees/abc/a.ts" /history/worktrees/abc/b.ts; ls /history/worktrees/abc`,
    );
    // Carve-outs and look-alikes hold inside a command string exactly as they do for a structured path.
    expect(redirectCommand("/work/intentic/node_modules/.bin/tsgo -p /work/intentic/tsconfig.json", plan)).toBe(
        "/work/intentic/node_modules/.bin/tsgo -p /history/worktrees/abc/intentic/tsconfig.json",
    );
    expect(redirectCommand("grep -r x /mnt/intentic-main/intentic", plan)).toBe("grep -r x /mnt/intentic-main/intentic");
    expect(redirectCommand("echo networking", plan)).toBe("echo networking");
});

/* A heredoc body is a FILE being written through the shell, not a path the command acts on. Rewriting it
 * corrupts the file with a path meaningless outside one conversation — which is exactly what happened to
 * three scripts' comments within an hour of this feature shipping. */
test("a heredoc body is left alone — its workspace paths are content, not targets", () => {
    const doc = ["cat > notes.md <<'EOF'", "The daemon serves /work to every agent.", "EOF", "cd /work/intentic"].join("\n");
    const out = redirectCommand(doc, plan);
    // The body keeps the path it names…
    expect(out).toContain("The daemon serves /work to every agent.");
    // …while the command AFTER the terminator is redirected as usual.
    expect(out).toContain("cd /history/worktrees/abc/intentic");
});

test("heredoc detection covers the forms agents actually write", () => {
    // Unquoted delimiter, indented terminator (`<<-`), a second heredoc later in the same command, and the
    // command word before the body still being rewritten.
    const unquoted = ["python3 /work/x.py <<EOF", "path = '/work/a'", "EOF"].join("\n");
    expect(redirectCommand(unquoted, plan)).toBe(["python3 /history/worktrees/abc/x.py <<EOF", "path = '/work/a'", "EOF"].join("\n"));
    const indented = ["cat <<-'END'", "\t/work/b", "\tEND", "ls /work/c"].join("\n");
    expect(redirectCommand(indented, plan)).toContain("\t/work/b");
    expect(redirectCommand(indented, plan)).toContain("ls /history/worktrees/abc/c");
    // An unterminated heredoc protects everything after it rather than guessing where the body ended.
    expect(redirectCommand(["cat <<'EOF'", "/work/d"].join("\n"), plan)).toContain("/work/d");
});
