import type { AgentEvent, PermissionMode } from "@intentic/sandbox-contract";
import { type AgentRequest, type QueryFn, runAgent } from "./agent.js";
import { EventQueue } from "./event-queue.js";
import { sumUsage, type UsageFrame } from "./turn-usage.js";

/* IMP MODE — one turn, two agents, and the delegation runs the other way round.
 *
 * The ARCHITECT holds no tools at all (see AgentRole): it reads the request, thinks, and writes what it needs
 * to know and what it wants changed — in plain words, never as commands. What it wrote then goes to an IMP: a
 * cheaper agent on the full tool surface, in the same workspace, which works out which tools serve that need,
 * runs them, and reports back. The report is the architect's next message, and it writes again.
 *
 * The point is the inversion. The usual arrangement makes the strong model spend its attention on deciding to
 * search, wording the search, and reading what comes back; here the architect states an intent in prose and
 * the results arrive unasked, so its context holds design and findings rather than tool plumbing. Nobody
 * "spawns a sub-agent" — the imp is already reading.
 *
 * ONE imp per architect round, over the whole message, and the round waits for it. An earlier version cut the
 * architect's text into paragraphs and fired an imp the moment each one closed, so an imp could work while the
 * architect was still writing. It read well and worked badly: the opening paragraph of a message is usually a
 * statement of intent ("I'll explore the workspace first"), so the first imp went exploring on a guess while a
 * second imp started on the paragraphs that said what was actually wanted — two agents, overlapping, each
 * redoing the other's work, and a transcript nobody could follow. The overlap it bought was a second or two;
 * the architect holds no tools, so its rounds are short anyway.
 *
 * The turn ends when a dispatch runs no tools at all: the architect's last message asked for nothing, so it
 * was the answer rather than a request.
 */

// The model an imp runs on when the sandbox setting names none: Anthropic's `haiku` tier alias — an alias, so
// it tracks the newest Haiku rather than pinning a version this repo would have to maintain.
export const IMP_DEFAULT_MODEL = "haiku";

// Runaway guard: an architect that keeps asking for one more thing (or an imp that keeps finding work in a
// summary) would otherwise loop until the abort signal. Hitting it is reported, never silent.
const MAX_ARCHITECT_ROUNDS = 16;

// How much of the architect's message heads the imp's card in the transcript.
const HEADLINE_CAP = 120;

// The built-ins that change the workspace, withheld from an imp while the architect is still in plan mode.
const MUTATING_TOOLS = ["Edit", "Write", "NotebookEdit"];

export interface ImpConfig {
    // The model every imp dispatch of this turn runs on — the cheap half of the pair.
    readonly model: string;
}

// Appended to the architect's system prompt. It is told the arrangement plainly, because the failure mode of a
// tool-less coding model is pretending: describing a file it never saw, or asking the USER to run a command.
const ARCHITECT_NOTE = [
    "You are the ARCHITECT of a two-agent pair, and you hold no tools: you cannot read files, run commands, search, or edit anything yourself.",
    "An imp — a fast agent with the full tool surface, working in this same workspace — reads what you write, does what it calls for, and hands you the results as your next message. It is already reading; you never have to summon it.",
    // The lesson from the first version of this note, which said "name concrete paths, commands and exact
    // edits": the architect dutifully wrote out `find …` invocations, which is both a waste of the expensive
    // model's attention and a worse tool choice than the imp would have made on its own.
    "State the NEED, not the mechanics. Say what you want to know and what you want changed, in plain words — name files, symbols and behaviour, never shell commands or tool names. Choosing how to find something is the imp's job and it is better at it than you: it knows every tool available here, and a command you dictate is one it cannot improve on.",
    "Never ask the user to run something for you, and never describe the contents of a file you have not been shown: if you need it, say so and it will arrive.",
    "A fresh imp answers each time and remembers nothing of the last one: you are the memory, so a request must carry everything needed to act on it. And ask for what you need to KNOW, not for raw material to sift — an imp that dumps twenty files back at you has spent the turn relaying instead of working.",
    // You cannot inspect the imp's method, only read its answer, so a plausible answer obtained the wrong way
    // reaches the user unchallenged. Restating the conditions is the only check available to you.
    "When correctness depends on conditions — exclusions, formats, edge cases — restate them with the request and require the imp to confirm each one: you cannot check its work yourself.",
    "Keep to intent, design and judgement. When the work is done, say so and stop — a message that asks for nothing ends the turn.",
].join("\n\n");

// Appended to every imp dispatch's system prompt. Its whole job is to turn prose into the right tool calls and
// results back into prose — the judgement belongs to the architect, the tool choice belongs to the imp.
const IMP_NOTE = [
    "You are an IMP: the hands of an architect who holds no tools. You are given what the architect just wrote. Work out what it needs, choose the tools that serve it, run them, and report back to the architect.",
    "Serve the need, not the phrasing: “I need to see how X works” is an instruction to find X and show it. “Change Y to Z” is an instruction to make that edit. The architect describes intent and does not know which tools exist — picking them is entirely yours.",
    "Use the right tool rather than the shell: Read, Grep and Glob for looking at code, and Bash for things that genuinely are commands (tests, builds, git, package managers). Shelling out to find/cat/ls for something a dedicated tool does is slower and noisier.",
    "Do not make design decisions, do not improve on what was asked, and never address the user — the architect is your reader.",
    "Report concretely and briefly: what you did, then the excerpts, output and findings that matter, with real paths and line numbers. Quote what you actually read; never summarize a file you did not open.",
    "Where the architect states a condition, confirm each one in your report and say how you met it — it cannot see your work, so an unconfirmed condition is one it has to assume you ignored.",
    "If nothing is called for — the message is a conclusion, a summary, or a question for the user — then run no tools at all and reply exactly: NOTHING TO DO.",
].join("\n\n");

// Prefixed to a dispatch while the architect is still in plan mode. The tools that edit files are withheld for
// the same round (MUTATING_TOOLS), so this states a posture the tool surface already enforces for file writes.
const PLAN_NOTE =
    "The architect is still planning and the user has approved nothing yet: investigate and report only. Change nothing — no edits, and no commands that write, install, publish or push.";

// The card's title: the architect's first real line, capped.
const headline = (text: string): string => {
    const line =
        text
            .split("\n")
            .find((entry) => entry.trim() !== "")
            ?.trim() ?? "";
    return line.length > HEADLINE_CAP ? `${line.slice(0, HEADLINE_CAP)}…` : line;
};

// The architect's request for one round. Deliberately narrow: no tools, no MCP servers, no plugins, no shell
// env, no output-cleaner settings — nothing here runs a command — and no steering queue, which this
// orchestrator drains itself at round boundaries. The credentials, model and reasoning controls are the
// turn's own, because the architect IS the turn's model.
const architectRequest = (request: AgentRequest, prompt: string, sessionId: string | undefined, mode: PermissionMode): AgentRequest => ({
    role: "architect",
    prompt,
    cwd: request.cwd,
    signal: request.signal,
    permissionMode: mode,
    systemAppend: request.systemAppend === undefined ? ARCHITECT_NOTE : `${request.systemAppend}\n\n${ARCHITECT_NOTE}`,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.oauthToken !== undefined ? { oauthToken: request.oauthToken } : {}),
    ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
    ...(request.authToken !== undefined ? { authToken: request.authToken } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
});

// One dispatch's request: the turn's whole tool surface (tools, MCP servers, plugins, shell env, cleaner
// settings) on the imp's own cheap model. `effort`/`thinking` are deliberately NOT inherited — the architect
// is the half that was given room to think.
//
// An imp NEVER prompts for permission. A card it raised would park the whole turn on a question with no
// context for the person answering it ("allow Bash?" — for what?), pile up one card per command, and leave the
// architect waiting behind it; and if the turn settled first, the answer had nowhere to go ("could not record
// your decision"). The container is the isolation boundary — the same bet the daemon's own default posture
// makes. What the user actually gates is the architect's plan, and plan mode still means something here: the
// tools that change files are withheld for as long as it lasts (and PLAN_NOTE says so), rather than each call
// being put to the user.
const impRequest = (request: AgentRequest, imp: ImpConfig, prompt: string, mode: PermissionMode): AgentRequest => ({
    role: "imp",
    prompt,
    cwd: request.cwd,
    signal: request.signal,
    permissionMode: "bypassPermissions",
    model: imp.model,
    systemAppend: IMP_NOTE,
    disallowedTools: [...(request.disallowedTools ?? []), ...(mode === "plan" ? MUTATING_TOOLS : [])],
    ...(request.oauthToken !== undefined ? { oauthToken: request.oauthToken } : {}),
    ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
    ...(request.authToken !== undefined ? { authToken: request.authToken } : {}),
    ...(request.tools !== undefined ? { tools: request.tools } : {}),
    ...(request.sdkServers !== undefined ? { sdkServers: request.sdkServers } : {}),
    ...(request.plugins !== undefined ? { plugins: request.plugins } : {}),
    ...(request.cliEnv !== undefined ? { cliEnv: request.cliEnv } : {}),
    ...(request.outputCleaners !== undefined ? { outputCleaners: request.outputCleaners } : {}),
    ...(request.outputHoldout !== undefined ? { outputHoldout: request.outputHoldout } : {}),
    ...(request.filterBackend !== undefined ? { filterBackend: request.filterBackend } : {}),
});

// What one dispatch produced. `report` is absent when the imp ran no tools — nothing was asked of it, which is
// how the turn ends; a report that exists is what the architect reads next.
interface Dispatch {
    readonly report: string | undefined;
    readonly usage: UsageFrame | undefined;
}

// The imp half of a turn, across all its rounds. Every dispatch is a FRESH session — the imp is stateless
// hands, and the ARCHITECT is the memory.
//
// It used to resume one session for the whole turn, so the imp would remember what it had already fetched. A
// benchmark run priced that decision: dispatches 2 and 3 re-sent the whole accumulated history and burned
// 361k of context — 49% of the turn's total — to emit 502 output tokens between them, the last of which was
// a 120k replay to say "NOTHING TO DO". Continuity is not worth re-paying for a transcript on every round,
// and it is not needed: whatever the imp must know, the architect states, because the architect is the half
// that is supposed to be holding the thread.
class Imp {
    private briefed = false;
    private dispatches = 0;

    constructor(
        private readonly config: ImpConfig,
        private readonly request: AgentRequest,
        private readonly push: (event: AgentEvent) => void,
        private readonly queryFn: QueryFn | undefined,
    ) {}

    // Hand over what the architect just wrote and wait for the work to be done.
    async run(written: string, mode: PermissionMode): Promise<Dispatch> {
        this.dispatches += 1;
        const id = `imp_${this.dispatches}`;
        let report = "";
        let toolCalls = 0;
        let failed = false;
        let carded = false;
        let usage: UsageFrame | undefined;
        // The card appears only once the imp actually does something. EVERY turn ends with a dispatch that
        // finds nothing left to do — that is how the turn knows it is over — and carding it unconditionally
        // put a "NOTHING TO DO" tile at the end of every single transcript, which reads as a mistake rather
        // than as the loop terminating.
        const card = (): void => {
            if (carded) {
                return;
            }
            carded = true;
            this.push({ kind: "tool_call", id, name: "Imp", category: "other", status: "in_progress", target: headline(written) });
        };
        const request = impRequest(this.request, this.config, this.prompt(written, mode), mode);
        for await (const event of runAgent(request, this.queryFn)) {
            switch (event.kind) {
                case "session":
                    // Dropped, not forwarded: the conversation's session is the ARCHITECT's, and this one is
                    // thrown away at the end of the dispatch.
                    break;
                case "delta":
                    report += event.text;
                    break;
                case "tool_call":
                    toolCalls += 1;
                    card();
                    this.push({ ...event, parentToolUseId: id });
                    break;
                case "tool_call_update":
                case "terminal":
                case "rate_limit_info":
                    // The work itself, its live terminal, and the account's usage window — all the user's to see.
                    this.push(event);
                    break;
                case "usage":
                    usage = sumUsage(usage, event);
                    break;
                case "error":
                    failed = true;
                    card();
                    this.push(event);
                    break;
                default:
                    // init/mode/thinking/todos/context_usage/… describe the imp's own run, not the turn's. A
                    // `permission` frame cannot arrive: an imp runs unprompted (see impRequest).
                    break;
            }
        }
        if (carded) {
            this.push({ kind: "tool_call_update", id, status: failed ? "failed" : "completed", content: [{ type: "text", text: report.trim() }] });
        }
        // A dispatch that broke must be reported UP, not swallowed: the architect asked for something and has
        // no other way to learn it didn't happen, and an architect that believes a failed request succeeded is
        // exactly the state-tracking failure this design is supposed to remove.
        if (failed) {
            return { report: `Your imp FAILED and the work was not done. ${report.trim()}`.trim(), usage };
        }
        return { report: toolCalls > 0 ? report.trim() : undefined, usage };
    }

    // The dispatch's prompt. The first one of a turn also carries what the user actually asked for, so the imp
    // can judge relevance; later ones get the architect's message alone, which is all a fresh imp has.
    private prompt(written: string, mode: PermissionMode): string {
        const parts = [...(mode === "plan" ? [PLAN_NOTE] : []), `The architect wrote:\n\n${written}`];
        if (this.briefed) {
            return parts.join("\n\n");
        }
        this.briefed = true;
        return [`The user asked the architect for this:\n\n${this.request.prompt}`, "---", ...parts].join("\n\n");
    }
}

// The architect's next message: what its imp brought back, anything the user steered meanwhile, and the nudge
// that makes stopping an explicit option rather than a thing it drifts into.
const nextPrompt = (report: string | undefined, steers: readonly string[]): string =>
    [
        ...(report !== undefined ? [`Your imp did this and reported back:\n\n${report}`] : []),
        ...steers.map((text) => `The user says: ${text}`),
        "Continue: say what you now need or want changed, or — if the work is done — say so and stop.",
    ].join("\n\n");

const orchestrate = async (imp: ImpConfig, request: AgentRequest, queryFn: QueryFn | undefined, push: (event: AgentEvent) => void): Promise<void> => {
    // User steers land at round boundaries (the architect is not steerable mid-round — it holds no tools, so
    // there is no gap between tool calls to inject into), collected here by a reader that ends with the queue.
    const steers: string[] = [];
    const steering = request.steering;
    const reader =
        steering === undefined
            ? undefined
            : (async () => {
                  for await (const text of steering) {
                      steers.push(text);
                  }
              })();

    let sessionId = request.sessionId;
    let mode: PermissionMode = request.permissionMode ?? "bypassPermissions";
    let prompt = request.prompt;
    const worker = new Imp(imp, request, push, queryFn);

    try {
        for (let round = 1; ; round += 1) {
            let written = "";
            let architectUsage: UsageFrame | undefined;
            for await (const event of runAgent(architectRequest(request, prompt, sessionId, mode), queryFn)) {
                switch (event.kind) {
                    case "done":
                        // One `done` ends the whole turn, not each round.
                        continue;
                    case "usage":
                        // Held to the end of the round (a round can emit several) and pushed BELOW, before the
                        // dispatch — see the ordering note there.
                        architectUsage = sumUsage(architectUsage, event);
                        continue;
                    case "session":
                        sessionId = event.sessionId;
                        break;
                    case "mode":
                        // A plan approval moves the whole pair: the imp stops being read-only from here on.
                        mode = event.mode;
                        break;
                    case "delta":
                        written += event.text;
                        break;
                    default:
                        break;
                }
                push(event);
            }
            // Close the architect's bubble BEFORE the imp starts. A client renders one assistant message as
            // thinking → tools → text, so an imp card sharing the architect's bubble is drawn ABOVE the message
            // that caused it — the work appears to happen before the request for it. `usage` is what ends a
            // bubble, so pushing the architect's here (rather than merging both halves into one frame at the
            // end) puts the imp's card and tool calls in their own bubble underneath, in causal order.
            if (architectUsage !== undefined) {
                push(architectUsage);
            }
            // The round's whole message goes to one imp, and the round waits for it.
            const dispatch = written.trim() === "" ? undefined : await worker.run(written.trim(), mode);
            if (dispatch?.usage !== undefined) {
                push(dispatch.usage);
            }
            const steered = steers.splice(0);
            if (request.signal.aborted || (dispatch?.report === undefined && steered.length === 0)) {
                return;
            }
            if (round === MAX_ARCHITECT_ROUNDS) {
                push({
                    kind: "error",
                    message: `Imp mode stopped after ${MAX_ARCHITECT_ROUNDS} architect rounds without settling — the work so far is kept. Send another message to carry on.`,
                });
                return;
            }
            prompt = nextPrompt(dispatch?.report, steered);
        }
    } finally {
        steering?.close();
        await reader;
    }
};

// Run one turn as an architect/imp pair, streaming the same AgentEvents an ordinary turn does: the architect's
// text and thinking, one `Imp` tool card per round with that imp's own tool calls beneath it, one merged
// accounting frame per round, and a single terminal `done`. Frames arrive from the architect's stream and from
// the imp's, so a queue bridges both into this generator.
export async function* runImpMode(imp: ImpConfig, request: AgentRequest, queryFn?: QueryFn): AsyncGenerator<AgentEvent> {
    const queue = new EventQueue<AgentEvent>();
    const pump = (async () => {
        try {
            await orchestrate(imp, request, queryFn, (event) => queue.push(event));
        } finally {
            queue.end();
        }
    })();
    try {
        yield* queue;
    } finally {
        await pump;
    }
    yield { kind: "done" };
}
