import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { TurnLease } from "../agent/tools/turn-mounts.js";
import { type ChildSupervisor, supervisorFor } from "../agent/subagents/children.js";
import type { ConversationActors } from "../conversations/actor/conversation-actors.js";
import { sdk } from "../engines/claude-sdk.js";
import { sdkServerDoor } from "../runtimes/daemon-tools/sdk-door.js";
import { opt } from "../opt.js";
import type { LinkListing } from "./linked-children.js";

// EACH LINKED SANDBOX AS A TURN SEES IT: a tool server named after its card, mounted on the turn's lease the way a
// connected computer's is (peers/peer-tools.ts), so every runtime reaches `mcp__<link>__delegate` and
// `mcp__<link>__about` beside `mcp__<computer>__run_command`, and a persona grants it on the same devices list. What the
// task does over there is that sandbox's terms; supervising it once handed over is the subagents tools' job (wait, send,
// answer, cancel), since it is a `linked` child of the conversation.

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

const NOT_HERE = "This turn may not hand work on: it was started by outside content, or its persona does not delegate. Do the work here, or say what you left undone.";

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
                    "sandbox has; for more hands on this sandbox's own work, spawn instead. Returns a subagent id at once: " +
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
                    "wear there, whether each waits for its owner to allow it, and how many turns an hour it takes.",
                {},
                async () => {
                    const listing = conversationId === undefined ? undefined : await deps.about(conversationId, card.id);
                    return answer(listing === undefined ? { ok: false, message: "This turn reaches no such linked sandbox." } : { ok: true, ...listing });
                },
                { annotations: toolAnnotations("read") },
            ),
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
        capability.kind === "link"
            ? [lease.open({ name: capability.id, target: { kind: "daemon", server: sdkServerDoor(linkServer(deps, capability, conversationId)) } })]
            : [],
    );
