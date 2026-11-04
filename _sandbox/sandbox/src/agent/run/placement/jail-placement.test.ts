import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { IsolationPlan } from "../../../conversations/worktrees/isolation.js";
import { jailPlanOf } from "../../../conversations/worktrees/turn-sandbox.js";
import { jailDecision } from "./jail-placement.js";

// Pins the planning decision of the whole-workspace jail without a kernel: whether a turn is jailed, refused or placed as
// before, and what the plan it gets holds. The sandbox the plan builds is pinned as an argv in turn-sandbox.test.ts.

const claude = { agent: "claude", harness: "native" } as const;
const codex = { agent: "codex", harness: "native" } as const;

const asks = (wanted: boolean, available = true) => {
    const asked: string[] = [];
    return {
        asked,
        asks: {
            wanted: async () => {
                asked.push("wanted");
                return wanted;
            },
            sandboxAvailable: async () => {
                asked.push("sandboxAvailable");
                return available;
            },
        },
    };
};

test("the fixtures name the runtimes they stand for", () => {
    expect(capabilitiesOf(claude.agent, claude.harness).runtime).toBe("claude-code");
    expect(capabilitiesOf(codex.agent, codex.harness).runtime).toBe("codex");
});

test("while the jail is not wanted a turn is placed as before, whatever its runtime, and nothing else is asked", async () => {
    for (const turn of [claude, codex]) {
        const { asked, asks: fake } = asks(false, false);
        expect(await jailDecision(fake, turn)).toEqual({ jailed: false });
        expect(asked).toEqual(["wanted"]);
    }
});

test("while it is wanted a Claude Code turn is jailed", async () => {
    const { asked, asks: fake } = asks(true);
    expect(await jailDecision(fake, claude)).toEqual({ jailed: true });
    expect(asked).toEqual(["wanted", "sandboxAvailable"]);
});

test("a runtime the sandbox cannot carry is refused rather than run open", async () => {
    const { asked, asks: fake } = asks(true);
    const decision = await jailDecision(fake, codex);
    expect(decision).toEqual({ refused: expect.stringContaining("only Claude Code can run in one so far") });
    expect(asked).toEqual(["wanted"]);
});

test("a sandbox that cannot build the jail refuses the turn", async () => {
    const { asks: fake } = asks(true, false);
    expect(await jailDecision(fake, claude)).toEqual({ refused: expect.stringContaining("cannot build one (bubblewrap with user namespaces)") });
});

const base = (worktree: string): IsolationPlan => ({
    worktree,
    root: WORKSPACE_ROOT,
    mirrors: ["node_modules", "support/web/dist", "finance/node_modules"],
    overlays: `${HISTORY_ROOT}/overlays/abc`,
    fence: undefined,
});

test("a jailed plan is the turn's own plan fenced to the whole workspace: nothing narrowed, covered or masked", () => {
    for (const worktree of [`${HISTORY_ROOT}/worktrees/abc`, WORKSPACE_ROOT]) {
        const sessions = `${HISTORY_ROOT}/conversations/abc/jail-sessions`;
        const jail = { gits: `${HISTORY_ROOT}/gits`, sshSocket: "/run/intentic/ssh/c-abc.sock" };
        expect(jailPlanOf(base(worktree), sessions, jail)).toEqual({
            ...base(worktree),
            fence: { folders: [""], hidden: [], sessions, gitPointers: [], whole: jail },
        });
    }
});
