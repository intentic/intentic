import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { conversationAfter, conversationEntry } from "../../../conversations/registry/agents-store.testing.js";
import { onPath } from "../../../image/on-path.js";
import { opt } from "../../../opt.js";
import { CHILD_NOTE_HEADER, CHILD_NOTE_TITLE } from "../../../sessions/vocabulary/prompt-envelope.js";
import { workspaceMemoryFiles } from "../../prompt/workspace-memory.js";
import type { TurnContext } from "../../providers/adapter.js";
import { planTurn } from "../../run/turn/turn-plan.js";
import { base, codexServices, context, turn, wire } from "../../run/turn/turn-plan.testing.js";
import { type ChildPreambleFacts, type ChildTurn, childArtifactsDir, childNoteFor, childPreambleText } from "../starting/child-preamble.js";
import { withBrief } from "../starting/child-brief.js";
import { CHILDREN } from "../child-records.js";
import { childRecordOf } from "../child-spec.js";
import { noteSpawnedChild, openSpawnedChild, settleSpawnedChild } from "../subagents.js";

// The child's artifacts folder as the note names it, built from the workspace root the way child-preamble.ts does.
const ARTIFACTS = join(WORKSPACE_ROOT, STATE_DIR, "records", "artifacts", "subagents", "sub-kid");

// What the sandbox tells every spawned child with its brief (child-preamble.ts): made of facts read as the turn is
// planned, on the turns that carry the brief and only those, once each.

const PARENT = "conv-lead";
const BRIEF = "Port the renderer to wgpu and keep the golden images passing.";
const CODEX = { provider: "codex", model: "gpt-5.1-codex" } as const;

const FACTS: ChildPreambleFacts = {
    childId: "sub-kid",
    parentId: PARENT,
    memory: { kept: ["AGENTS.md"], notGiven: ["game/AGENTS.md"] },
    claudeMd: false,
    landing: "parent",
    artifacts: ARTIFACTS,
    siblings: [
        { id: "sub-net", task: "Netcode rollback", status: "running", after: undefined, files: ["game/net/a.rs", "game/net/b.rs", "game/net/c.rs", "game/net/d.rs"] },
        { id: "sub-ui", task: "Lobby screen", status: "pending", after: ["you", "sub-net"], files: [] },
    ],
    moreSiblings: 2,
    after: ["sub-art"],
    tools: { queue: true, quiet: true, base: true, digest: true },
};

const words = (text: string): number => text.split(/\s+/u).filter((word) => word !== "").length;

describe("the note's text", () => {
    it("says each fact it was given, in a few plain lines", () => {
        expect(childPreambleText(FACTS)).toBe(
            [
                CHILD_NOTE_HEADER,
                "",
                "You are `sub-kid`, a subagent of `conv-lead`. The sandbox adds this note to every subagent's first message; your parent wrote only the task.",
                "",
                "- Instructions: `AGENTS.md` is already in your instructions: do not read it again. Not in your instructions, so read a repository's own before you change it: `game/AGENTS.md`.",
                "- Your work: do not commit or push. When your turn ends, the sandbox brings your changes into your parent's checkout, uncommitted; any that clash with your parent's edits wait on your branch for your parent to merge.",
                `- Artifacts (screenshots, logs, probe scripts) go in \`${ARTIFACTS}/\`, never in a repository.`,
                "- You started once `sub-art` had finished: its work is in your checkout already.",
                "- Siblings, your parent's other subagents, as they stood when this turn began (`agents show <id>` for now):",
                '  - `sub-net` ("Netcode rollback"): running; changed, not landed: `game/net/a.rs`, `game/net/b.rs`, `game/net/c.rs`, 1 more',
                '  - `sub-ui` ("Lobby screen"): pending, starts after you, `sub-net`',
                "  - and 2 more (`agents ls`)",
                "  Ask your parent before you edit a file a sibling is changing.",
                "- Builds and tests:",
                "  - The heavy-command queue sets build and test parallelism (cargo's `-j` and test threads included) and takes turns across conversations: pass no `-j` and take no turns by hand.",
                "  - `quiet -- <command>` for anything you time: benchmarks, profiles, steady captures.",
                "  - `base run <command>` runs a command at the commit your work started from: your before, beside your after.",
                "  - A failing test run ends with a digest marking each failure new or also failing at main: report that, do not re-derive it.",
                "- Report: your final message is what your parent reads. End it with these four parts:",
                "  1. Files changed.",
                "  2. Checks run and each one's result; for a failure, whether it is new or also fails at main.",
                "  3. Decisions you took that the task left open.",
                "  4. What you did not verify.",
            ].join("\n"),
        );
        expect(words(childPreambleText(FACTS))).toBeLessThanOrEqual(350);
    });

    it("names only the tools installed, and nothing it was not given", () => {
        const bare = childPreambleText({
            ...FACTS,
            memory: { kept: [], notGiven: [] },
            claudeMd: true,
            landing: "judged",
            siblings: [],
            moreSiblings: 0,
            after: undefined,
            tools: { queue: true, quiet: false, base: false, digest: false },
        });
        expect(bare).toContain("- Instructions: No `AGENTS.md` is on your path. Claude Code loads `CLAUDE.md` files by itself.");
        expect(bare).toContain("When your turn ends, your changes wait on your branch for your parent to review and merge.");
        expect(bare).toContain("- Siblings: none; your parent has no other subagents right now.");
        expect(bare).toContain("- Builds and tests:\n  - The heavy-command queue sets build and test parallelism");
        expect(bare).not.toContain("quiet --");
        expect(bare).not.toContain("base run");
        expect(bare).not.toContain("digest");
        expect(bare).not.toContain("You started once");
        expect(childPreambleText({ ...FACTS, tools: { queue: false, quiet: false, base: false, digest: false } })).not.toContain("Builds and tests");
    });
});

// A workspace with standing rules at its root and a repository whose own rules are below where the child starts.
const workspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "child-preamble-"));
    await writeFile(join(root, "AGENTS.md"), "Never run the whole suite.\n");
    await mkdir(join(root, "game"));
    await writeFile(join(root, "game", "AGENTS.md"), "Never build with --release.\n");
    await writeFile(join(root, "game", "CLAUDE.md"), "Claude's own.\n");
    return root;
};

// A parent with this child, and siblings on its roster as the spawn engine leaves them.
const family = () => {
    const conversations = memoryFleet().conversations;
    const kid = childRecordOf({ conversationId: PARENT, cwd: WORKSPACE_ROOT }, { prompt: BRIEF, ...CODEX }, 1);
    conversations.holdings(CHILDREN).hold(PARENT, "sub-kid", kid, "sub-kid");
    const roster = { conversationId: PARENT, conversations, subagentsDir: undefined };
    openSpawnedChild(roster, { id: "sub-kid", description: "Port the renderer", ...CODEX, spawnDepth: 1 });
    openSpawnedChild(roster, { id: "sub-net", description: "Netcode rollback", ...CODEX, spawnDepth: 1 });
    openSpawnedChild(roster, { id: "sub-old", description: "Asset audit", ...CODEX, spawnDepth: 1 });
    settleSpawnedChild(conversations, "sub-old", { status: "completed", report: "Audited." });
    openSpawnedChild(roster, { id: "sub-ui", description: "Lobby screen", ...CODEX, spawnDepth: 1 });
    noteSpawnedChild(conversations, "sub-ui", { status: "pending", summary: "Waiting after `sub-kid`." });
    conversations.holdings(CHILDREN).hold(PARENT, "sub-ui", { ...childRecordOf({ conversationId: PARENT, cwd: WORKSPACE_ROOT }, { prompt: "Lobby", ...CODEX }, 1, "after"), after: ["sub-kid"] }, "sub-ui");
    const inFlight = { pathsOf: (id: string) => (id === "sub-net" ? ["game/net/rollback.rs"] : []) };
    // The parent works in a checkout of its own here, so the child's work comes back into it.
    const agents = { entry: (id: string) => (id === PARENT ? conversationEntry({ id, placement: { kind: "worktree", branch: "agent/lead", repos: [] } }) : undefined) };
    return { conversations, kid, deps: { conversations, agents, inFlight, memoryFiles: workspaceMemoryFiles } };
};

const childTurn = (root: string, over: Partial<ChildTurn> = {}): ChildTurn => ({
    conversationId: "sub-kid",
    prompt: BRIEF,
    sessionId: undefined,
    root,
    start: root,
    runtime: "codex",
    outputCleaners: "",
    ...over,
});

describe("the note a spawned child's turn opens with", () => {
    it("is read off the sandbox: the files on its path, where its work lands, its siblings and what is installed", async () => {
        const root = await workspace();
        const { deps } = family();
        const note = await childNoteFor(deps, childTurn(root));
        const installed = { queue: await onPath("queue-run"), quiet: await onPath("quiet"), base: await onPath("base"), digest: await onPath("agent-output-filter") };

        expect(note?.title).toBe(CHILD_NOTE_TITLE);
        const text = note?.text ?? "";
        expect(text).toContain("- Instructions: `AGENTS.md` is already in your instructions: do not read it again. Not in your instructions, so read a repository's own before you change it: `game/AGENTS.md`.");
        expect(text).not.toContain("CLAUDE.md");
        expect(text).toContain("the sandbox brings your changes into your parent's checkout");
        expect(text).toContain(`go in \`${childArtifactsDir("sub-kid")}/\``);
        // Live first, then the ones that ended; this child itself is not its own sibling, and one waiting after it says so.
        expect(text).toContain('\n  - `sub-net` ("Netcode rollback"): running; changed, not landed: `game/net/rollback.rs`\n');
        expect(text).toContain('\n  - `sub-ui` ("Lobby screen"): pending, starts after you\n');
        expect(text).toContain('\n  - `sub-old` ("Asset audit"): completed\n');
        expect(text.indexOf("`sub-old`")).toBeGreaterThan(Math.max(text.indexOf("`sub-net`"), text.indexOf("`sub-ui`")));
        expect(text).not.toContain("`sub-kid` (");
        expect(text.includes("quiet --")).toBe(installed.quiet);
        expect(text.includes("base run")).toBe(installed.base);
        expect(text.includes("heavy-command queue")).toBe(installed.queue);
        expect(text.includes("digest")).toBe(installed.digest);
        // A Claude Code turn is told its loop reads CLAUDE.md files; the digest rides the output cleaners.
        const claude = await childNoteFor(deps, childTurn(root, { runtime: "claude-code", outputCleaners: "off" }));
        expect(claude?.text).toContain("Claude Code loads `CLAUDE.md` files by itself.");
        expect(claude?.text).not.toContain("digest");
    });

    it("rides every turn that carries the brief, a re-sent one included, and no other", async () => {
        const root = await workspace();
        const { deps, kid } = family();
        // The brief re-sent ahead of the parent's message, no model having read it yet (child-brief.ts).
        expect(await childNoteFor(deps, childTurn(root, { prompt: withBrief(kid, "There is room now: carry on.") }))).toMatchObject({ title: CHILD_NOTE_TITLE });
        // A re-run opening a fresh session on the turn that carried it: that session never read it.
        kid.briefRead = true;
        expect(await childNoteFor(deps, childTurn(root))).toMatchObject({ title: CHILD_NOTE_TITLE });
        // The same re-run resuming the session that read it, and a follow-up after it: nothing.
        expect(await childNoteFor(deps, childTurn(root, { sessionId: "thread-1" }))).toBeUndefined();
        expect(await childNoteFor(deps, childTurn(root, { prompt: "Also the shadow pass.", sessionId: "thread-1" }))).toBeUndefined();
        // A conversation no parent spawned.
        expect(await childNoteFor(deps, childTurn(root, { conversationId: "conv-lead" }))).toBeUndefined();
    });
});

describe("a child's planned turn", () => {
    it("carries the note once, right above its brief, on its first turn and on a brief re-sent; never on a follow-up", async () => {
        const root = await workspace();
        const { conversations, kid } = family();
        const services = codexServices({
            conversations,
            workspace: unstubbed<Services["workspace"]>("workspace", { root }),
            agents: unstubbed<Services["agents"]>("agents", { entry: (id: string) => (id === "sub-kid" ? conversationAfter(0, { id }) : undefined) }),
            inFlight: unstubbed<Services["inFlight"]>("inFlight", { turnNote: () => undefined, pathsOf: () => [] }),
        });
        // The turn as the port hands it over: its words on the request too, where a session is resumed its id.
        const planned = async (prompt: string, sessionId?: string): Promise<string> => {
            const spec = { ...base.spec, prompt, cwd: root, ...opt("sessionId", sessionId) };
            const at: TurnContext = { ...context, base: { ...base, spec }, localCwd: root, effectiveCwd: root };
            return wire(await planTurn(services, turn({ agent: "codex", conversationId: "sub-kid", prompt }), at));
        };
        const notesIn = (text: string): number => text.split(CHILD_NOTE_HEADER).length - 1;

        const first = await planned(BRIEF);
        expect(notesIn(first)).toBe(1);
        expect(first.indexOf(CHILD_NOTE_HEADER)).toBeLessThan(first.indexOf(BRIEF));
        expect(first.split(BRIEF)).toHaveLength(2);

        const resent = await planned(withBrief(kid, "There is room now: carry on."));
        expect(notesIn(resent)).toBe(1);
        expect(resent.split(BRIEF)).toHaveLength(2);

        kid.briefRead = true;
        expect(notesIn(await planned("Also the shadow pass.", "thread-1"))).toBe(0);
        expect(notesIn(await planned(BRIEF, "thread-1"))).toBe(0);
    });
});
