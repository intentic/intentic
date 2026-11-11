import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { DiagnosticsQuerySchema } from "@intentic/sandbox-contract/schemas/diagnostics";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { TurnLease } from "../agent/tools/turn-mounts.js";
import { type ChildSupervisor, supervisorFor } from "../agent/subagents/children.js";
import type { ConversationActors } from "../conversations/actor/conversation-actors.js";
import { sdk } from "../engines/claude-sdk.js";
import { sdkServerDoor } from "../runtimes/daemon-tools/sdk-door.js";
import { opt } from "../opt.js";
import type { LinkListing } from "./link-listing.js";
import { linkRecordsDiagnostics, linkRecordsRead } from "../sandboxes/link-client.js";
import { MAX_ANSWER_CHARS } from "../logs/diagnostics-render.js";
import { operateTools } from "./link-operate-tools.js";

// EACH LINKED SANDBOX AS A TURN SEES IT: a tool server named after its card, mounted on the turn's lease the way a
// connected computer's is (peers/peer-tools.ts), so every runtime reaches `mcp__<link>__delegate` and
// `mcp__<link>__about` beside `mcp__<computer>__run_command`, and a persona grants it on the same devices list. What the
// task does over there is that sandbox's terms; supervising it once handed over is the subagents tools' job (wait, send,
// answer, cancel), since it is a `linked` child of the conversation. Its records tools read that sandbox's conversations
// and diagnostics while its owner shares them (link-records.ts), the granted card being the whole gate on this side. Its
// operating tools run commands and read and write files there as its owner's own terminal would, while its owner lets the
// link operate it (link-operate-tools.ts), and only in a turn that may hand work on.

export interface LinkMountDeps {
    readonly conversations: Pick<ConversationActors, "holdings">;
    // One card's listing: whether it answers, and the terms its tasks run under over there.
    readonly about: (conversationId: string, link: string) => Promise<LinkListing | undefined>;
}

type LinkCard = Extract<Capability, { kind: "link" }>;

// A tool's whole answer as one JSON text block, so the model can branch on `ok` without parsing prose.
// A type, not an interface: the SDK's result type wants the implicit index signature only an alias carries.
type ToolAnswer = { content: { type: "text"; text: string }[] };

const answer = <Payload extends object>(payload: Payload): ToolAnswer => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

// Handing work on is spawning's sibling: a turn its persona or an outside wake kept from spawning (no supervisor armed
// at planning, children.ts) may not hand work to another sandbox either.
const supervising = (deps: LinkMountDeps, conversationId: string | undefined): ChildSupervisor | undefined =>
    conversationId === undefined ? undefined : supervisorFor(deps.conversations, conversationId);

// A records answer as the model reads it: the far side's JSON, cut at the size every diagnostics answer is held to.
const recordsAnswer = (text: string): ToolAnswer => ({
    content: [
        {
            type: "text",
            text: text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}… (cut at ${MAX_ANSWER_CHARS / 1000} KB: narrow it)` : text,
        },
    ],
});

// One fleet read of the linked sandbox, as its records doors answer it.
const fleetRead = async (card: LinkCard, path: string, params: Record<string, string | undefined>): Promise<ToolAnswer> => {
    const query = new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]]))).toString();
    const read = await linkRecordsRead({ id: card.id, config: card.config }, `/link/records/fleet${path}${query === "" ? "" : `?${query}`}`);
    return recordsAnswer(JSON.stringify(read.ok ? read.body : { ok: false, message: read.message }));
};

// The records tools: reading the linked sandbox's conversations and diagnostics, which only works while its owner shares
// them on the link, and starts nothing over there.
const recordsTools = (card: LinkCard, sandbox: string) => {
    const shared = `Only while "${sandbox}"'s owner shares its records on the link (\`about\` says whether); read-only, starts no turn there.`;
    return [
        sdk().tool(
            "conversations",
            `The linked sandbox "${sandbox}"'s conversations, most recently active first, or with \`find\` the ones that said or ran a phrase, as its own \`agents ls\` and \`agents find\` answer. ${shared}`,
            {
                find: z.string().min(1).optional().describe("A phrase to search for instead of listing."),
                all: z.boolean().optional().describe("Include the archive."),
                limit: z.number().int().min(1).max(100).optional(),
            },
            async ({ find, all, limit }) => fleetRead(card, "", { q: find, all: all === true ? "1" : undefined, limit: limit?.toString() }),
            { annotations: toolAnnotations("read") },
        ),
        sdk().tool(
            "conversation",
            `One of "${sandbox}"'s conversations, whole, as its own \`agents show\` answers: what it was asked, how it ended, its branch; with \`transcript\` its last messages and their tool calls, with \`message\` one message in full. ${shared}`,
            {
                handle: z.string().min(1).describe("Its id, an id prefix, words from its title, a session id: anything `agents show` takes."),
                transcript: z.boolean().optional(),
                last: z.number().int().min(1).max(100).optional().describe("How many of the last messages (default 20)."),
                grep: z.string().min(1).optional().describe("Only messages carrying this phrase."),
                message: z.number().int().min(0).optional().describe("One message whole, by its number."),
            },
            async ({ handle, transcript, last, grep, message }) =>
                fleetRead(card, `/${encodeURIComponent(handle)}`, {
                    transcript: transcript === true || last !== undefined || grep !== undefined ? "1" : undefined,
                    last: last?.toString(),
                    grep,
                    message: message?.toString(),
                }),
            { annotations: toolAnnotations("read") },
        ),
        sdk().tool(
            "diagnostics",
            `One diagnostics query of "${sandbox}"'s records, as its own \`diagnostics\` tools answer: \`errors\` (its daemon log, or \`source: "browser"\` its editor's reports; \`from\`/\`until\` read around a moment), \`timeline\` (one conversation), \`turns\`, \`restarts\`, \`slow\`, \`resources\`. Arguments as those tools take them, with \`query\` naming which. ${shared}`,
            { ask: DiagnosticsQuerySchema.describe('The query, e.g. {"query": "timeline", "conversationId": "glad-falcon-puep"}.') },
            async ({ ask }) => {
                const answered = await linkRecordsDiagnostics({ id: card.id, config: card.config }, ask);
                return recordsAnswer(answered.ok ? answered.value.text : `"${sandbox}": ${answered.message}`);
            },
            { annotations: toolAnnotations("read") },
        ),
    ];
};

const NOT_HERE =
    "This turn may not hand work on: it was started by outside content, or its persona does not delegate. Do the work here, or say what you left undone.";

const linkServer = (deps: LinkMountDeps, card: LinkCard, conversationId: string | undefined) => {
    const sandbox = card.config.name ?? card.id;
    return sdk().createSdkMcpServer({
        name: card.id,
        tools: [
            sdk().tool(
                "delegate",
                `Hand a task to the linked sandbox "${sandbox}": a full agent over there, with that sandbox's own repos, ` +
                    "connections and credentials, working in a conversation of its own under the terms its owner set on the link. " +
                    "Its work runs and lands over there, never in your checkout. Reach for it when the work needs what only that " +
                    "sandbox has; for more hands on this sandbox's own work, spawn instead. That conversation works in a checkout " +
                    `of its own over there: \`${WORKSPACE_ROOT}/<repo>\` in its turn is its own worktree on its own branch, never the shared ` +
                    "checkout, so it cannot repair that sandbox's shared state (a stuck branch, a `.git` pointer, a land that is " +
                    "refused). For that, operate the sandbox yourself with run_command, read_file and write_file. Returns a subagent id at once: " +
                    "supervise it with wait, follow up with send, answer its questions with answer, stop it with cancel. Give it a " +
                    "self-contained task: it sees none of this conversation, and its closing report is all that comes back, read as " +
                    "outside content. Each task is a whole turn over there on that sandbox's allowance: batch small questions.",
                {
                    task: z.string().min(1).describe("The whole task, self-contained."),
                    description: z.string().max(200).optional().describe("One line naming the task, for the board on both sides."),
                },
                async (args) => {
                    const supervisor = supervising(deps, conversationId);
                    if (supervisor === undefined) {
                        return answer({ ok: false, message: NOT_HERE });
                    }
                    const result = await supervisor.delegate({ to: card.id, task: args.task, description: args.description });
                    return answer(result.ok ? { ok: true, child: result.id, ...opt("note", result.note) } : { ok: false, message: result.message });
                },
                // Starts work in another sandbox, on that sandbox's allowance, which nothing here can take back.
                { annotations: toolAnnotations("destructive") },
            ),
            sdk().tool(
                "about",
                `Whether the linked sandbox "${sandbox}" answers right now, and the terms it holds tasks to: the persona they ` +
                    "wear there, whether each waits for its owner to allow it, how many turns an hour it takes, whether its owner " +
                    "shares its records (`records`) and whether this link may operate it (`operate`: run_command, read_file, write_file).",
                {},
                async () => {
                    const listing = conversationId === undefined ? undefined : await deps.about(conversationId, card.id);
                    return answer(
                        listing === undefined ? { ok: false, message: "This turn reaches no such linked sandbox." } : { ok: true, ...listing },
                    );
                },
                { annotations: toolAnnotations("read") },
            ),
            ...recordsTools(card, sandbox),
            ...operateTools(card, sandbox, conversationId, () => supervising(deps, conversationId) !== undefined),
        ],
    });
};

/** The turn's linked sandboxes, one server each on its lease, for the cards it was granted. */
export const linkMountsOf = (
    deps: LinkMountDeps,
    granted: readonly Capability[],
    lease: Pick<TurnLease, "open">,
    conversationId: string | undefined,
): AgentTool[] =>
    granted.flatMap((capability) =>
        // An accounts card only borrows models (sharing/): it hands nothing over, so its turn gets no delegate tool.
        capability.kind === "link" && capability.config.purpose !== "accounts"
            ? [lease.open({ name: capability.id, target: { kind: "daemon", server: sdkServerDoor(linkServer(deps, capability, conversationId)) } })]
            : [],
    );
