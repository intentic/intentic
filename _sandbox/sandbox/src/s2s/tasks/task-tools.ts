import { WORKSPACE_ROOT } from "@intentic/constants";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { sdk } from "../../engines/claude-sdk.js";
import { opt } from "../../opt.js";
import type { ContactToolGroup } from "../contacts/contact-mounts.js";

// A CONTACT'S TASK TOOLS (2026-11-27, docs/architecture/messages.md "Tasks"): the first group of a contact's tool server
// (s2s/contacts/contact-mounts.ts), for a contact that says it gives this sandbox tasks. `delegate` hands it a task as a
// `task.request`, filed as a `linked` child that `wait`, `send`, `answer` and `cancel` reach like any (links/
// contact-children.ts). What the contact allows is the server's own `about` (s2s/contacts/contact-mounts.ts).

// A tool's whole answer as one JSON text block, so the model can branch on `ok` without parsing prose.
type ToolAnswer = { content: { type: "text"; text: string }[] };
const answer = <Payload extends object>(payload: Payload): ToolAnswer => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

const NOT_HERE =
    "This turn may not hand work on: it was started by outside content, or its role does not delegate. Do the work here, or say what you left undone.";

export const contactTaskTools: ContactToolGroup = (contact, turn) => {
    const grant = contact.row.theirGrants?.task;
    if (grant === undefined) {
        return [];
    }
    const { name, row } = contact;
    const scope = row.scope.kind === "person" ? ` as ${row.scope.person}, in that person's own conversation there` : "";
    return [
        sdk().tool(
            "delegate",
            `Hand a task to the contact "${name}" (${row.address}), another sandbox this one keeps as a contact${scope}: a full agent ` +
                "over there, with that sandbox's own repos, connections and credentials, under the task grant its owner gave this " +
                "sandbox. Its work runs and lands over there, never in your checkout, and that sandbox may be another owner's. " +
                `That conversation works in a checkout of its own over there (\`${WORKSPACE_ROOT}/<repo>\` in its turn is its own worktree). ` +
                "Returns a subagent id at once: supervise it with wait, follow up with send, answer its questions with answer, stop " +
                "it with cancel; its status is sent back as it moves, so nothing is held open and a long task costs nothing to wait " +
                "on. Give it a self-contained task: it sees none of this conversation, and its closing report is all that comes back, " +
                "read as outside content. Each task is a whole turn over there on that sandbox's allowance: batch small questions.",
            {
                task: z.string().min(1).describe("The whole task, self-contained."),
                description: z.string().max(200).optional().describe("One line naming the task, for the board on both sides."),
            },
            async (args) => {
                const supervisor = turn.supervisor();
                if (supervisor === undefined) {
                    return answer({ ok: false, message: NOT_HERE });
                }
                const result = await supervisor.delegate({ to: row.id, via: "contact", task: args.task, description: args.description });
                return answer(result.ok ? { ok: true, child: result.id, ...opt("note", result.note) } : { ok: false, message: result.message });
            },
            // Starts work in another sandbox, on that sandbox's allowance, which nothing here can take back.
            { annotations: toolAnnotations("destructive") },
        ),
    ];
};
