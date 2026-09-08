import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { PersistedAgent } from "../../agents/registry/agents-store.js";
import { scopedTarget, type WorkspaceScopeDeps, workspaceRootFor } from "./workspace-scope.js";

// Whose copy of the workspace a read means, and the three failures that resolution can produce.
// Runs on disk, not mocked: whether the checkout exists is the question being answered.

const agent = (over: Partial<PersistedAgent>): PersistedAgent =>
    ({ id: "c-1", provider: "claude", harness: "claude-code", repos: [], status: "idle", updatedAt: 0, ...over }) as PersistedAgent;

const setup = async (): Promise<{ main: string; worktrees: string; deps: WorkspaceScopeDeps }> => {
    const base = await mkdtemp(join(tmpdir(), "scope-"));
    const main = join(base, "work");
    const worktrees = join(base, "worktrees");
    await mkdir(main, { recursive: true });
    await mkdir(worktrees, { recursive: true });
    const entries = new Map<string, PersistedAgent>();
    entries.set("isolated", agent({ id: "isolated", branch: "agent/isolated" }));
    entries.set("shared-mode", agent({ id: "shared-mode" }));
    entries.set("archived", agent({ id: "archived", branch: "agent/archived" }));
    return {
        main,
        worktrees,
        deps: { main, entry: (id) => entries.get(id), worktreeDir: (id) => join(worktrees, id) },
    };
};

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
    } catch (error) {
        return error instanceof ORPCError ? error.code : `not-an-orpc-error`;
    }
    return `did-not-throw`;
};

describe("workspaceRootFor", () => {
    it("answers with the shared tree when no conversation is named", async () => {
        const { main, deps } = await setup();
        expect(await workspaceRootFor(deps, undefined)).toBe(main);
    });

    it("answers with the conversation's own checkout when it has one", async () => {
        const { worktrees, deps } = await setup();
        await mkdir(join(worktrees, "isolated"), { recursive: true });
        expect(await workspaceRootFor(deps, "isolated")).toBe(join(worktrees, "isolated"));
    });

    // Working directly in /work isn't an error: /work IS the conversation's tree, so a link from it needs no mode
    // check.
    it("sends a shared-workspace conversation back to the shared tree", async () => {
        const { main, deps } = await setup();
        expect(await workspaceRootFor(deps, "shared-mode")).toBe(main);
    });

    // Archiving drops the checkout but keeps the branch; a stale link must read as "cleaned up", not "no such file".
    it("says so specifically when the checkout is gone rather than reporting a missing file", async () => {
        const { deps } = await setup();
        expect(await codeOf(() => workspaceRootFor(deps, "archived"))).toBe("PRECONDITION_FAILED");
    });

    it("refuses an id the registry doesn't know, and one that isn't an id at all", async () => {
        const { deps } = await setup();
        expect(await codeOf(() => workspaceRootFor(deps, "nobody"))).toBe("NOT_FOUND");
        expect(await codeOf(() => workspaceRootFor(deps, "../../etc"))).toBe("BAD_REQUEST");
    });
});

describe("scopedTarget", () => {
    it("reads the conversation's own file when it has one: the file it wrote and hasn't landed", async () => {
        const { worktrees, deps } = await setup();
        await mkdir(join(worktrees, "isolated", "docs"), { recursive: true });
        await writeFile(join(worktrees, "isolated", "docs", "plan.md"), "agent's own");
        const { target, shared } = await scopedTarget(deps, "isolated", "docs/plan.md");
        expect(target).toBe(join(worktrees, "isolated", "docs", "plan.md"));
        expect(shared).toBe(false);
    });

    it("prefers the conversation's version over the shared tree's file of the same name", async () => {
        const { main, worktrees, deps } = await setup();
        await mkdir(join(worktrees, "isolated"), { recursive: true });
        await writeFile(join(main, "README.md"), "shared");
        await writeFile(join(worktrees, "isolated", "README.md"), "edited by the agent");
        const { target } = await scopedTarget(deps, "isolated", "README.md");
        expect(target).toBe(join(worktrees, "isolated", "README.md"));
    });

    it("falls back to the shared tree for a path the checkout doesn't carry, and reports that it did", async () => {
        const { main, worktrees, deps } = await setup();
        await mkdir(join(worktrees, "isolated"), { recursive: true });
        await writeFile(join(main, "only-here.md"), "shared only");
        const { target, shared } = await scopedTarget(deps, "isolated", "only-here.md");
        expect(target).toBe(join(main, "only-here.md"));
        expect(shared).toBe(true);
    });

    it("applies the escape guard inside the checkout, not just inside /work", async () => {
        const { deps, worktrees } = await setup();
        await mkdir(join(worktrees, "isolated"), { recursive: true });
        expect(await codeOf(() => scopedTarget(deps, "isolated", "../../etc/passwd"))).toBe("BAD_REQUEST");
    });

    it("keeps the daemon's own credential state unreachable through a scoped read", async () => {
        const { deps, worktrees } = await setup();
        await mkdir(join(worktrees, "isolated"), { recursive: true });
        expect(await codeOf(() => scopedTarget(deps, "isolated", ".intentic/identity/owner.json"))).toBe("NOT_FOUND");
    });

    // A symlink escapes with no `../` in the path; lexically the target looks contained though its bytes are elsewhere.
    it("refuses a path whose bytes are outside the workspace because a symlink leaves it", async () => {
        const { main, deps } = await setup();
        const elsewhere = await mkdtemp(join(tmpdir(), "scope-elsewhere-"));
        await writeFile(join(elsewhere, "token.json"), '{"token":"secret"}');
        await symlink(elsewhere, join(main, "escape"));
        await symlink(join(elsewhere, "token.json"), join(main, "direct.json"));

        expect(await codeOf(() => scopedTarget(deps, undefined, "escape/token.json"))).toBe("BAD_REQUEST");
        expect(await codeOf(() => scopedTarget(deps, undefined, "direct.json"))).toBe("BAD_REQUEST");
    });

    it("still serves a symlink that stays inside the workspace", async () => {
        const { main, deps } = await setup();
        await mkdir(join(main, "real"), { recursive: true });
        await writeFile(join(main, "real", "a.ts"), "export const a = 1;");
        await symlink(join(main, "real"), join(main, "linked"));

        const { target } = await scopedTarget(deps, undefined, "linked/a.ts");
        expect(target).toBe(join(main, "linked", "a.ts"));
    });

    it("does not refuse a path that does not exist yet: a write creates one", async () => {
        const { main, deps } = await setup();
        const { target } = await scopedTarget(deps, undefined, "new/nested/file.ts");
        expect(target).toBe(join(main, "new", "nested", "file.ts"));
    });
});
