import { z } from "zod";
// Every live surface the sandbox's one global panel can show: tmux sessions, plus the agent's browser (not a terminal,
// but the same question, what is running and can I look at it).
// shell: a session the user opened.
// panel: a repo's dev-server session, started via Start; running:false means untracked.
// agent: the agent's Bash commands; running:false once every pane is a finished command's dead one.
// job: the daemon's terminal runner executing a user-triggered flow (capability add, infra check).
// process: a managed background process, shown read-only, never as a killable tab.
export const TerminalSessionSchema = z.object({
    name: z.string().describe("Its id, and what the close route takes."),
    label: z.string().optional().describe("What to call it on screen."),
    kind: z
        .enum(["shell", "panel", "agent", "job", "process"])
        .describe(
            "What sort of thing it is: a terminal somebody opened, a repository's dev server, where an agent's commands run, a job the sandbox started, or a background process that is watched rather than typed into.",
        ),
    running: z
        .boolean()
        .describe("Whether it is alive. A finished one-shot job leaves a dead shell behind, which reads as false and is how it gets swept up."),
    activityAt: z.number().describe("When it last produced output, in milliseconds. Zero means it did not say, which is unknown rather than 1970."),
    exitCode: z.number().optional().describe("How the last thing in it ended. Absent while that pane is still alive."),
    // pane_current_command; absent at a prompt. Distinct from running, which only says the session is alive.
    command: z
        .string()
        .optional()
        .describe(
            "What is running in it right now. Absent when it is sitting at a prompt. Not a second spelling of whether it is alive: this says whether anything is happening, which is what a close button should ask about before it ends something.",
        ),
    extensionId: z.string().optional().describe("Which extension declared this process, when one did."),
    processName: z
        .string()
        .optional()
        .describe("Which of that extension's processes it is, which together with the id above addresses its start and stop routes."),
    // Agent waiting on a person (OTP, key touch, confirm); settled via POST /agent/reply. Present only while open.
    help: z
        .object({
            requestId: z.string().describe("What to send back when you answer, through the agent reply route."),
            message: z.string().describe("What the agent needs, in its own words."),
            requestedAt: z.number().describe("When it asked, in milliseconds."),
        })
        .optional()
        .describe("The agent has stopped at something only a person can clear, and is waiting at this terminal. Present only while it is waiting."),
});
export const TerminalsListSchema = z.object({
    sessions: z
        .array(TerminalSessionSchema)
        .describe("Every live surface the sandbox is holding, in one list, because the question they all answer is the same one."),
});
export type TerminalsList = z.infer<typeof TerminalsListSchema>;
export const TerminalNameParamSchema = z.object({ name: z.string().describe("Which terminal.") });
// Pane history as plain text: the browser cannot read tmux's alternate-screen scrollback any other way. `lines` bounds
// how far back to ask; `truncated` marks a request-bound stop, not history's end.
export const TerminalScrollbackQuerySchema = z.object({
    name: z.string().describe("Which terminal."),
    lines: z.coerce.number().min(1).max(100_000).default(20_000).describe("How far back to ask for. Clamped to the history that actually exists."),
});
export const TerminalScrollbackSchema = z.object({
    name: z.string().describe("Which terminal this is from."),
    // Oldest line first, wrapped lines rejoined so a copied URL or path comes back whole.
    text: z.string().describe("The history, oldest line first, with wrapped lines rejoined so a copied address or path comes back whole."),
    lines: z.number().describe("How many lines you got."),
    truncated: z.boolean().describe("It stopped because you asked for that many, not because the history ran out."),
});
export type TerminalScrollback = z.infer<typeof TerminalScrollbackSchema>;
// The Chromium the agent drives via @playwright/mcp, listed apart from terminals since it holds several pages at once,
// not one stream. `active` is the page the agent last touched.
export const BrowserPageSchema = z.object({
    id: z
        .string()
        .describe(
            "Stable for the life of the page, which is what lets a tab survive a refresh of this list. Its address changes as the agent navigates and its position changes when a sibling closes.",
        ),
    // The page's title; absent mid-navigation, when a tab still needs to render.
    title: z.string().optional().describe("The page's title. Absent mid-navigation, which is exactly when a tab still has to be drawn."),
    url: z.string().describe("Where it is."),
    // The page the agent last drove; for a finished session, the one it ended on. Exactly one page has it.
    active: z.boolean().describe("The one the agent last touched, or for a finished session, the one it ended on. Exactly one page has this."),
});
export const BrowserSessionSchema = z.object({
    name: z.string().describe("Its id, and what the close route takes."),
    // The pill's text: the active page's title, else its host, else which browser this is.
    label: z.string().describe("What to call it on screen: the open page's title, or its site, or which browser this is."),
    // Which MCP server drives it: the credential-free browser, or a signed-in capability's id.
    server: z
        .string()
        .describe(
            "Which browser drives it: the credential-free one, or a signed-in account's. The difference between a throwaway page and one logged in as you, which is worth saying out loud.",
        ),
    // False once the Chromium is gone; a finished session still lists briefly with the pages it had.
    running: z
        .boolean()
        .describe("Whether it is still open. A closed one is listed for a while with the pages it had, as the record of where the agent went."),
    activityAt: z.number().describe("When it last did anything, in milliseconds."),
    // When the Chromium closed; absent while running, for the "closed 20m ago" line.
    finishedAt: z.number().optional().describe("When it closed, in milliseconds. Absent while it is open."),
    // Agent stuck on a captcha, password or phone check; settled via POST /agent/reply. Present only while open.
    help: z
        .object({
            requestId: z.string().describe("What to send back when you answer, through the agent reply route."),
            message: z.string().describe("What the agent needs, in its own words."),
            requestedAt: z.number().describe("When it asked, in milliseconds."),
        })
        .optional()
        .describe(
            "The agent has hit something only a person can clear: a captcha, a password it does not hold, a check on your phone. Present only while it is waiting.",
        ),
    pages: z
        .array(BrowserPageSchema)
        .describe("Every page it has open. A browser holds several at once, which is the reason it is listed apart from the terminals."),
});
export type BrowserPage = z.infer<typeof BrowserPageSchema>;
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export const BrowsersListSchema = z.object({
    sessions: z.array(BrowserSessionSchema).describe("Every browser the agents have running, open or recently closed."),
});
export type BrowsersList = z.infer<typeof BrowsersListSchema>;
export const BrowserNameParamSchema = z.object({ name: z.string().describe("Which browser.") });
// Two kinds of started agent, listed together since from outside both are just another agent working that you did not
// start:
// subagent: the SDK's Agent/Task tool, tracked via SubagentStart/Stop hooks and task_* messages joined on toolUseId.
// spawned: a full child agent on any provider, started through the daemon's spawn door (children/children.ts); the
// daemon reports its life directly.
// id is the spawning tool call's id for a subagent, the child's own conversation id for a spawned one. A kind changes
// only how you watch it live.
export const SubagentKindSchema = z.enum(["subagent", "spawned"]);
export type SubagentKind = z.infer<typeof SubagentKindSchema>;
// running/pending/blocked are live, the rest terminal. Uses the SDK's own task vocabulary rather than AgentStatus.
// `blocked` is the one addition: a spawned child's question/permission/plan card raises it.
export const SubagentStatusSchema = z.enum(["pending", "running", "blocked", "completed", "failed", "killed", "paused"]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;
// Whether anything checked what the subagent did, computed from its edits against the checks that ran after them; works
// on every provider. Absent means the daemon saw no tool calls from it.
// verified / failing: names the check that spoke, so a targeted test is never read as the whole suite.
// unproven: it changed code and nothing checked it.
// no-code: it edited nothing, the honest answer for a research subagent, not to be read as approval.
export const SubagentVerificationSchema = z.object({
    state: z
        .enum(["verified", "unproven", "failing", "no-code"])
        .describe(
            "Whether anything proved its work: a check passed after its last edit, it changed code and nothing checked it, a check ran and failed, or it changed no code at all.",
        ),
    paths: z.array(z.string()).optional().describe("The code files it changed, most recent last. The first few; the record holds the rest."),
    check: z
        .string()
        .optional()
        .describe(
            "The command that spoke: the one that cleared it, or the one that failed. Named rather than summarised, so a targeted test is not read as the whole suite.",
        ),
});
export type SubagentVerification = z.infer<typeof SubagentVerificationSchema>;
export const SubagentSessionSchema = z.object({
    id: z
        .string()
        .describe(
            "The id of the tool call that started it (an SDK child) or the child's own conversation id (a spawned one); either way both sides already hold it, so a card links to its subagent with the id it has and the subagent points back the same way.",
        ),
    kind: SubagentKindSchema.describe(
        "What sort of subagent: one the runtime's own Task tool spawned in-process, or a full child agent the daemon started for the turn. It changes only how you watch it.",
    ),
    // The conversation whose turn started it; how a card links back to the chat it belongs to.
    conversationId: z.string().describe("The conversation whose turn started it, and the way back to the chat it belongs to."),
    // Subagent type (Explore, general-purpose) or a child's provider label; description is the one-line ask.
    agentType: z.string().optional().describe("What kind of subagent it is."),
    description: z.string().optional().describe("What it was asked to do, in one line."),
    model: z.string().optional().describe("Which model it runs on."),
    // Which provider serves a spawned child; an SDK subagent implies its own (its parent's).
    provider: z.string().optional().describe("Which provider serves it, for a child agent spawned across providers."),
    // How deep in the spawn tree; 1 means the turn itself started it. A subagent can itself delegate further.
    spawnDepth: z
        .number()
        .optional()
        .describe(
            "How deep in the chain it sits, where one means the turn itself started it. A subagent can start subagents, and a flat list that could not say so would read as though the turn started all of them.",
        ),
    // True when the parent kept working instead of waiting for it to finish.
    background: z
        .boolean()
        .optional()
        .describe(
            "The parent carried on working instead of waiting for it. This is the whole reason the list exists: such a subagent used to be invisible until its result landed, sometimes minutes later.",
        ),
    status: SubagentStatusSchema.describe(
        "How it is going. Blocked means it needs an answer, which a parent and an operator act on differently from it simply working.",
    ),
    startedAt: z.number().describe("When it started, in milliseconds."),
    endedAt: z.number().optional().describe("When it finished, in milliseconds. Absent while it works."),
    activityAt: z.number().describe("When it last did anything, in milliseconds."),
    // What it has spent, its own count; a parent's cost and the sum of its children's are different numbers.
    tokens: z
        .number()
        .optional()
        .describe("What it has spent. Its own, so a parent's cost and the sum of its subagents' are two different true numbers."),
    toolUses: z.number().optional().describe("How many tools it has used."),
    lastTool: z.string().optional().describe("The last one it reached for."),
    // Its report: the last assistant message or task summary, what it concluded without opening the transcript.
    summary: z
        .string()
        .optional()
        .describe("Its report: what it concluded, without opening its record. The question a finished subagent gets read for."),
    error: z.string().optional().describe("Why it failed, when it did."),
    // Filled once the subagent ends; a standing read mid-work would judge a job not yet done.
    verification: SubagentVerificationSchema.optional().describe("Whether anything proved the work its report describes."),
});
export type SubagentSession = z.infer<typeof SubagentSessionSchema>;
export const SubagentsListSchema = z.object({
    sessions: z.array(SubagentSessionSchema).describe("Every subagent and child agent this sandbox's conversations have started."),
});
export type SubagentsList = z.infer<typeof SubagentsListSchema>;
export const SubagentIdParamSchema = z.object({ id: z.string() });
