import { z } from "zod";
// EVERY live surface in the sandbox the web app's ONE global panel can show. Mostly tmux sessions (the
// interactive I/O is the /system/terminal WebSocket, not oRPC), plus the agent's browser, which is not a
// terminal at all, no more than a `process` row is, but IS the same question: what is running right now,
// and can I look at it? One list, because the panel that answers that question is one panel.
//
// `shell` = a web-* session the user opened (numbered pill),
// `panel` = a panel-* dev-server session (labeled by its panel key, started via Start; running:false =
// untracked, e.g. a finished one-shot job's lingering shell), `agent` = an agent-* session the Claude agent's
// Bash commands run in (live-watchable, AI-marked in the UI; running:false once every window is a finished
// command's dead pane, which is what lets the panel sweep it), `job` = a job-* session the daemon's terminal
// runner executes user-triggered flows in (capability adds, infra check), `process` = a managed background
// process riding a panel session (an extension's declared processes, dockerd), surfaced in the panel's
// background-processes popover with read-only log views, never as a killable tab; running is the actual
// process (a lingering shell after a crash reads false). A process row that maps to an installed extension's
// declared process carries extensionId+processName, the address for its /extensions start/stop routes. The
// `{name}` kill-route param is a bare string validated in the handler (a bad name is a BAD_REQUEST) since the
// same charset gates a `tmux kill-session -t` shell-out. The agent's BROWSER is deliberately NOT one of these
// kinds: a Chromium with its own tab strip is a surface in its own right, not a pane in the terminal panel, so
// it lists from /system/browsers with the pages it has open (BrowserSessionSchema below).
//
// `activityAt` (epoch ms of the session's last output) and `exitCode` (the LAST window's exit status, absent
// while that pane still lives) describe a session beyond "it exists": the panel's work popover orders its live
// rows by the one and dates them off it, and the daemon's retention sweep ages sessions out by the same clock.
// 0 is "tmux didn't say", treated as unknown by both, never as 1970.
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
    /* WHAT THIS SESSION IS RUNNING RIGHT NOW, `pane_current_command` of its live pane, and ABSENT when it is
     * sitting at its shell prompt. Not a second spelling of `running`: that field says whether a session is a
     * live thing at all (and for a `web-*` shell it is unconditionally true, prompt or build), whereas this one
     * says whether anything is HAPPENING in it. Killing a terminal is final, so the panel confirms on this
     * field before its × ends a session that has work in it, and names the command in the question, see the
     * daemon's `foreground` (system/system.routes.ts) for why a word rather than a flag. */
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
    // The agent has parked on a command that stopped for a PERSON, an OTP prompt, a security-key touch, a
    // confirm it cannot answer, and is waiting at this session's live pane. `message` is its own account of
    // what it needs. The terminal panel renders it as a banner over that session's tab (where the prompt the
    // user has to answer already is) and its buttons settle the parked card through `POST /agent/reply` with
    // `requestId`, exactly as the chat card does. The same shape as a browser's `help` below, on purpose: the
    // two handovers differ in WHERE the person acts, not in what is being asked. Present only while open.
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
// One session's PANE HISTORY as plain text. This route exists because the browser cannot reach it any other
// way: a tmux client runs on the ALTERNATE screen, which has no scrollback of its own, so what the wheel moves
// through lives in tmux on the far side of the socket and never enters the xterm buffer the page could select.
// `lines` is how far back to ask for, tmux clamps it to the history it actually has, and `truncated` says the
// answer stopped at the request rather than at the beginning.
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
/* ---- browsers: the Chromium the agent drives through its @playwright/mcp tools ----
 *
 * A `browser-<sdk session>` Chromium (browser/browser-sessions.ts), watchable live over the
 * /system/browser-view WebSocket. It lists apart from the terminals because it is shaped differently in the one
 * way that decides a UI: a terminal is ONE stream of bytes, while a browser holds SEVERAL pages at once and the
 * question "what is the agent looking at?" only has an answer if the wire carries all of them. So `pages` is the
 * point of this schema, the view renders them as a tab strip and binds the screencast to whichever the user
 * picks, and `active` is the one the agent itself last touched (what the view follows until the user says
 * otherwise).
 *
 * `id` is opaque and minted per session, and it is what makes a tab survive a relist: it is stable for the life
 * of the page, unlike its url (the agent navigates away) or its position (a closed tab renumbers the rest). */
export const BrowserPageSchema = z.object({
    id: z
        .string()
        .describe(
            "Stable for the life of the page, which is what lets a tab survive a refresh of this list. Its address changes as the agent navigates and its position changes when a sibling closes.",
        ),
    // The page's own title. Absent mid-navigation, which is exactly when a tab still needs to render.
    title: z.string().optional().describe("The page's title. Absent mid-navigation, which is exactly when a tab still has to be drawn."),
    url: z.string().describe("Where it is."),
    // The page the agent last drove, on a finished session, the one it ended on. Exactly one page has it.
    active: z.boolean().describe("The one the agent last touched, or for a finished session, the one it ended on. Exactly one page has this."),
});
export const BrowserSessionSchema = z.object({
    name: z.string().describe("Its id, and what the close route takes."),
    // The pill's text: the active page's title, else its host, else which browser this is.
    label: z.string().describe("What to call it on screen: the open page's title, or its site, or which browser this is."),
    // Which MCP server drives it: `web` (the credential-free browser) or a logged-in capability's id, the
    // difference between a throwaway page and one signed in as the user, which is worth saying out loud.
    server: z
        .string()
        .describe(
            "Which browser drives it: the credential-free one, or a signed-in account's. The difference between a throwaway page and one logged in as you, which is worth saying out loud.",
        ),
    // False once that Chromium is gone (the turn ended, the agent closed it, it crashed). A finished session
    // still lists for a while, with the pages it had, the record of where the agent went.
    running: z
        .boolean()
        .describe("Whether it is still open. A closed one is listed for a while with the pages it had, as the record of where the agent went."),
    activityAt: z.number().describe("When it last did anything, in milliseconds."),
    // When that Chromium went away, for the "closed 20m ago" line a finished session leads with. Absent while
    // running, which is the same fact as `running`, but the view needs the timestamp, not just the flag.
    finishedAt: z.number().optional().describe("When it closed, in milliseconds. Absent while it is open."),
    // The agent has hit something only a person can clear (a captcha, a password it does not hold, a phone
    // check) and is PARKED on it: `message` is its own account of what it needs, in the user's language. The
    // Browsers view renders it as a banner over the live stage, where "Take control" already is, and its
    // buttons settle the parked card through `POST /agent/reply` with `requestId`, exactly as the chat card
    // does; the field clears when the waiter settles, never by direct edit. Present only while open.
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
/* ---- subagents: the agents an agent starts ----
 *
 * The third thing a turn spawns that the operator can be shown, after its shell and its browser, and the only
 * one that is itself an agent. Two kinds land in this one list, because from outside they are the same fact
 * (another agent, working, that you did not start):
 *   • `subagent`, the SDK's Agent/Task tool. The daemon learns of it from the SubagentStart/SubagentStop hooks
 *     and the task_* stream messages, joined on `toolUseId`.
 *   • `spawned`, a full agent the turn started through the daemon's own spawn door (children/children.ts), on
 *     ANY connected provider, Cursor's Composer, Codex, Gemini, another Claude. The daemon runs the child
 *     itself, so its whole life is reported by direct calls rather than reconstructed from hooks or stdout.
 *
 * `id` IS THE SPAWNING TOOL CALL'S id for an SDK child (the one key its meta file, its task messages and the
 * client's `parentToolUseId` nesting all carry), and the child's own conversation id for a `spawned` one (the
 * spawn door returns it, so both sides hold it). A card links to its subagent with the id it has, and the
 * subagent points back at the card the same way. The ids the transcripts are actually READ with, the SDK's
 * agent id, stay daemon-side, because no surface asks a question they answer.
 *
 * WHAT A KIND CHANGES, and it is only ever the live view: an SDK subagent has no process of its own to look
 * at, so watching it means reading its transcript; a spawned child is a conversation of its own, so its live
 * view is that conversation's stream. */
export const SubagentKindSchema = z.enum(["subagent", "spawned"]);
export type SubagentKind = z.infer<typeof SubagentKindSchema>;
// running/pending/blocked are live; the rest are terminal. Deliberately the SDK's own task vocabulary
// (SDKTaskUpdatedMessage.patch.status) rather than AgentStatus: this is not a fleet card's lifecycle (no
// draft/landed/conflict), and mapping the two would invent states neither side reports. `blocked` is the one
// addition the SDK never says: a spawned child's own question/permission/plan card raises it
// (children/children.ts), and it exists because "the child needs an answer" is the one live state a parent or
// an operator acts on differently from "the child is working".
export const SubagentStatusSchema = z.enum(["pending", "running", "blocked", "completed", "failed", "killed", "paused"]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;
/* WHETHER ANYTHING CHECKED WHAT THE HELPER DID, carried beside its report rather than left for the reader to
 * assume. Computed from the helper's own tool calls, the files it edited against the checks that ran after
 * them (the daemon's child-verification.ts), so it holds on every provider rather than only where the Claude
 * hooks reach.
 *
 * The four states are deliberately not two. `verified` and `failing` each name the command that spoke, so a
 * targeted test is never read as the suite; `unproven` is the one that matters most, work changed and nothing
 * ran; and `no-code` says the helper edited nothing, which is the honest answer for a research helper and
 * must not be rendered as approval. Absent ⇒ the daemon saw no tool calls from it at all. */
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
            "The id of the tool call that started it (an SDK child) or the child's own conversation id (a spawned one); either way both sides already hold it, so a card links to its helper with the id it has and the helper points back the same way.",
        ),
    kind: SubagentKindSchema.describe(
        "What sort of helper: one the runtime's own Task tool spawned in-process, or a full agent the daemon started for the turn. It changes only how you watch it.",
    ),
    // The conversation whose turn spawned this, what the area groups its rows by, and the way back to the chat
    // the card lives in.
    conversationId: z.string().describe("The conversation whose turn started it, and the way back to the chat it belongs to."),
    // What it is and what it was asked to do: the subagent type (`Explore`, `general-purpose`) or a spawned
    // child's provider label, and the caller's one-line description. The area's row and the card's title read
    // as `Explore · Locate claimIndexer definition`.
    agentType: z.string().optional().describe("What kind of helper it is."),
    description: z.string().optional().describe("What it was asked to do, in one line."),
    model: z.string().optional().describe("Which model it runs on."),
    // Which provider serves a `spawned` child (its AgentProvider id), so the row can wear the right logo. An
    // SDK subagent implies its own: it runs on its parent's provider.
    provider: z.string().optional().describe("Which provider serves it, for a helper spawned across providers."),
    // How deep in the spawn tree (1 = spawned by the turn itself). From the SDK's meta.json; a subagent may
    // itself delegate, and a flat list that cannot say so reads as though the turn started all of them.
    spawnDepth: z
        .number()
        .optional()
        .describe(
            "How deep in the chain it sits, where one means the turn itself started it. A helper can start helpers, and a flat list that could not say so would read as though the turn started all of them.",
        ),
    // Backgrounded: the parent went on working instead of waiting for it. This is the whole reason the list
    // exists, a backgrounded child used to be invisible until its result landed, sometimes minutes later.
    background: z
        .boolean()
        .optional()
        .describe(
            "The parent carried on working instead of waiting for it. This is the whole reason the list exists: such a helper used to be invisible until its result landed, sometimes minutes later.",
        ),
    status: SubagentStatusSchema.describe(
        "How it is going. Blocked means it needs an answer, which a parent and an operator act on differently from it simply working.",
    ),
    startedAt: z.number().describe("When it started, in milliseconds."),
    endedAt: z.number().optional().describe("When it finished, in milliseconds. Absent while it works."),
    activityAt: z.number().describe("When it last did anything, in milliseconds."),
    // What it has spent and done so far (task_progress). Tokens are the child's own, so a parent's cost line and
    // the sum of its children's are two different true numbers.
    tokens: z
        .number()
        .optional()
        .describe("What it has spent. Its own, so a parent's cost and the sum of its helpers' are two different true numbers."),
    toolUses: z.number().optional().describe("How many tools it has used."),
    lastTool: z.string().optional().describe("The last one it reached for."),
    // Its report, the last assistant message (SubagentStop) or the task summary. The answer to "what did it
    // conclude?" without opening the transcript, which is the question a finished child is read for.
    summary: z
        .string()
        .optional()
        .describe("Its report: what it concluded, without opening its record. The question a finished helper gets read for."),
    error: z.string().optional().describe("Why it failed, when it did."),
    // Whether anything checked the work behind that report (SubagentVerificationSchema). Filled once it ends:
    // a standing read while it is still working would be a verdict on a job half done.
    verification: SubagentVerificationSchema.optional().describe("Whether anything proved the work its report describes."),
});
export type SubagentSession = z.infer<typeof SubagentSessionSchema>;
export const SubagentsListSchema = z.object({
    sessions: z.array(SubagentSessionSchema).describe("Every helper this sandbox's conversations have started."),
});
export type SubagentsList = z.infer<typeof SubagentsListSchema>;
export const SubagentIdParamSchema = z.object({ id: z.string() });
