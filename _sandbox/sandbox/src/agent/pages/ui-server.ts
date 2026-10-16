import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AskQuestion, RequestDocument } from "@intentic/sandbox-contract/events/requests";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../../engines/claude-sdk.js";
import { pageTools, type PageToolsDeps } from "./page-tools.js";
import { imageBlock, loadAttachments } from "../prompt/attachment-images.js";
import { answerFiles, formatAnswers } from "../../sessions/vocabulary/question-answers.js";
import { opt } from "../../opt.js";

// The `ui` server: `ask`, a question card the turn parks on until a person answers it, beside the page tools where the
// owner leaves them on. One server for every loop that mounts it, the Claude Code loop's in-process one (agent.ts) and
// the door's (daemon-servers.ts), so a question reads and answers the same whichever runtime asked it.

export interface AskToolDeps {
    readonly cards: Pick<ParkedCards, "create">;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
    // The turn's working folder, which the answer's attached files are named against.
    readonly cwd: string;
    readonly push: (event: AgentEvent) => void;
    // The turn's latest write-up, read when the question is asked, since a question about it needs it.
    readonly document?: () => RequestDocument | undefined;
    // What follows an answer the agent then acts on (the harness's rebase), told whether anything was answered.
    readonly answered?: (answered: boolean) => Promise<void>;
}

// The API's own ceiling on one picture, base64; a bigger one stays a path for the Read tool, which downsizes.
const MAX_ANSWER_IMAGE_BASE64 = 5 * 1024 * 1024;

export const ASK_TOOL_DESCRIPTION =
    'Ask the user 1-4 clarifying multiple-choice questions and wait for their answers. Use this whenever you need the user to choose between options before proceeding. Each question has 2-4 options; do NOT add an "Other" option: a free-text choice is provided automatically. Set multiSelect when several options may be picked together.';

export const askTool = (deps: AskToolDeps) =>
    sdk().tool(
        "ask",
        ASK_TOOL_DESCRIPTION,
        {
            questions: z
                .array(
                    z.object({
                        question: z.string(),
                        header: z.string(),
                        // Defaulted as in the built-in AskUserQuestion, whose call site the model was trained on.
                        multiSelect: z.boolean().default(false),
                        options: z
                            .array(z.object({ label: z.string(), description: z.string(), preview: z.string().optional() }))
                            .min(2)
                            .max(4),
                    }),
                )
                .min(1)
                .max(4),
        },
        async (args) => {
            // SAFETY: the schema above is AskQuestion's own shape, multiSelect defaulted; zod spells an absent preview
            // `string | undefined` where AskQuestion leaves it out.
            const questions = args.questions as AskQuestion[];
            // Named with its conversation: dismissing this ends the turn immediately, not on a second request.
            const { id, wait } = deps.cards.create("question", { kind: "question", requestId: "", cancelled: true }, deps.conversationId);
            // The turn's latest write-up rides along, already in hand, since a question about it needs it.
            const document = deps.document?.();
            deps.push({ kind: "question", requestId: id, questions, ...opt("document", document) });
            const { reply, resolved } = await wait(deps.signal);
            // Picks belong in the frame log too, not just the tool result: a replayed transcript freezes the card with
            // them.
            deps.push(resolved);
            // Rebase happens before the model acts on the answer, announced to the transcript, not folded into what it
            // reads.
            await deps.answered?.(!reply.cancelled && reply.answers !== undefined);
            // Pictures attached to the answer ride the result natively, so the model sees them without a Read; the text
            // names every file either way, and an unreadable or oversized one only by path.
            const { images } = await loadAttachments({ attachments: answerFiles(questions, reply, deps.cwd) }, true);
            const seen = images.filter((image) => image.data.length <= MAX_ANSWER_IMAGE_BASE64).map(imageBlock);
            return { content: [{ type: "text" as const, text: formatAnswers(questions, reply, deps.cwd) }, ...seen] };
        },
        // An answer rebases the conversation's tree (the harness's `answered`), so it must not run beside reads.
        { annotations: toolAnnotations("write") },
    );

/**
 * The `ui` server itself. A custom MCP tool, not the Claude Code built-in, since the built-in's picker has nowhere to
 * render headless; the Claude loop aliases it onto the built-in's name so the model's trained call site still works.
 * alwaysLoad keeps it out of the Claude loop's tool search; other runtimes read no such flag.
 */
export const uiServer = (deps: { readonly ask: AskToolDeps; readonly pages: PageToolsDeps | undefined }): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "ui",
        alwaysLoad: true,
        // The page tools beside `ask` (agent/pages/page-tools.ts), only where the owner leaves them on: off, the turn is
        // not offered them at all.
        tools: [...(deps.pages === undefined ? [] : pageTools(deps.pages)), askTool(deps.ask)],
    });
