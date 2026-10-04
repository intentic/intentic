import { z } from "zod";
import type { AgentEvent, AgentReply, AskQuestion } from "@intentic/sandbox-contract";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";
import type { PiEvent, PiProcess } from "./pi-rpc.js";

// Pi's extension UI sub-protocol (its rpc.md, "Extension UI Protocol") onto the runtime-neutral agent UI lane
// (sandbox-contract events/agent-ui.ts) and the question card every runtime shares:
// - `notify` is a notice; `setStatus` a status entry by its key; `setWidget` a status entry too, its lines joined, under
//   a `widget:` key so it never replaces a status of the same name. Placement (above or below the editor) has no
//   counterpart beside a composer, so it is dropped.
// - `select`, `confirm` and `input` park on a question card, the same card, registry and dismissal Codex's questions and
//   the ask tool use, and the pick goes back as `extension_ui_response`. An unattended turn's card waits for the owner
//   like any other card. A dismissal is the protocol's `cancelled`.
// - `editor` (a multi-line text editor over a prefill) has no card that fits, so it keeps the honest floor: cancelled,
//   which the extension reads as the user dismissing it.
// - `setTitle` names a terminal tab, and the conversation's title is the owner's; `set_editor_text` would write into the
//   person's composer over whatever they are typing. Both are dropped.

// What a dialog needs from the turn: where its card parks, whose conversation it is raised on, and the turn's cancel.
export interface PiDialogContext {
    readonly cards: Pick<ParkedCards, "create">;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
}

// A dialog parked on a card: `ask` streams the card and the resolved frame, then sends Pi its reply. Kept apart from the
// frames so the caller can hold its watchdog for exactly as long as a person is being waited on.
export interface PiDialog {
    readonly ask: () => AsyncGenerator<AgentEvent>;
}

// What answering one request produced: the frames to stream, and for a dialog the card it parks on.
export interface PiUiAnswer {
    readonly frames: readonly AgentEvent[];
    readonly dialog?: PiDialog;
}

// A dialog's common fields. Pi resolves one carrying `timeout` (ms) by itself once it passes, and never says so.
const dialogFields = {
    id: z.string(),
    title: z.string().catch(""),
    timeout: z.number().positive().optional().catch(undefined),
};

// The requests this lane reads, parsed at the door. Anything else (setTitle, set_editor_text, a method a later Pi adds)
// fails the parse and is dropped. A dialog's own fields fall back rather than fail, since Pi is blocked on its reply:
// only one with no id to answer by is dropped.
const PiUiRequestSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("select"), ...dialogFields, options: z.array(z.string()).catch([]) }),
    z.object({ method: z.literal("confirm"), ...dialogFields, message: z.string().optional().catch(undefined) }),
    z.object({ method: z.literal("input"), ...dialogFields, placeholder: z.string().optional().catch(undefined) }),
    z.object({ method: z.literal("editor"), ...dialogFields }),
    // Pi's notifyType is info, warning or error, the lane's own three; anything else reads as info, its default.
    z.object({ method: z.literal("notify"), message: z.string(), notifyType: z.enum(["info", "warning", "error"]).catch("info") }),
    // An absent text clears the entry.
    z.object({ method: z.literal("setStatus"), statusKey: z.string(), statusText: z.string().optional() }),
    z.object({ method: z.literal("setWidget"), widgetKey: z.string(), widgetLines: z.array(z.string()).optional() }),
]);
type PiUiRequest = z.infer<typeof PiUiRequestSchema>;
type PiDialogRequest = Extract<PiUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

// The header every card from a Pi extension wears: the protocol never says which extension asked.
const HEADER = "Pi extension";
const YES = "Yes";
const NO = "No";

const cancelled = (id: string) => ({ type: "extension_ui_response", id, cancelled: true }) as const;

// The one question a dialog asks, or undefined for the dialog with no card that fits.
const questionOf = (request: PiDialogRequest): AskQuestion | undefined => {
    switch (request.method) {
        case "select":
            return { question: request.title, header: HEADER, multiSelect: false, options: request.options.map((label) => ({ label, description: "" })) };
        case "confirm":
            return {
                question: request.message === undefined || request.message === "" ? request.title : `${request.title}\n\n${request.message}`,
                header: HEADER,
                multiSelect: false,
                options: [
                    { label: YES, description: "" },
                    { label: NO, description: "" },
                ],
            };
        case "input":
            // No options: the card's own free-text answer is the input, and the placeholder says what it wants.
            return {
                question: request.placeholder === undefined || request.placeholder === "" ? request.title : `${request.title} (${request.placeholder})`,
                header: HEADER,
                multiSelect: false,
                options: [],
            };
        case "editor":
            return undefined;
    }
};

// The reply Pi is waiting for, in the shape its method expects. A confirm answered in the person's own words rather
// than Yes or No is not a yes.
const responseOf = (request: PiDialogRequest, question: AskQuestion, reply: Extract<AgentReply, { kind: "question" }>) => {
    const pick = reply.cancelled === true ? undefined : reply.answers?.[question.question]?.[0];
    if (pick === undefined) {
        return cancelled(request.id);
    }
    return request.method === "confirm"
        ? { type: "extension_ui_response", id: request.id, confirmed: pick === YES }
        : { type: "extension_ui_response", id: request.id, value: pick };
};

const parkDialog = (proc: PiProcess, request: PiDialogRequest, question: AskQuestion, context: PiDialogContext): PiDialog => ({
    async *ask() {
        const { id, wait } = context.cards.create("question", { kind: "question", requestId: "", cancelled: true }, context.conversationId);
        yield { kind: "question", requestId: id, questions: [question] };
        // Pi's own timeout resolves the dialog on its side; the card goes with it.
        const signal = request.timeout === undefined ? context.signal : AbortSignal.any([context.signal, AbortSignal.timeout(request.timeout)]);
        const { reply, resolved } = await wait(signal);
        // The resolved frame first, so a replayed transcript freezes the card before anything that follows it.
        yield resolved;
        // A dialog Pi already resolved by its own timeout wants no reply; an unknown id would only be noise to it.
        if (!signal.aborted || context.signal.aborted) {
            proc.send(responseOf(request, question, reply));
        }
    },
});

// Answers one `extension_ui_request`: the frames it maps to, and the dialog to park on when it asks a person.
export const answerExtensionUi = (proc: PiProcess, event: PiEvent, context: PiDialogContext): PiUiAnswer => {
    const parsed = PiUiRequestSchema.safeParse(event);
    if (!parsed.success) {
        return { frames: [] };
    }
    const request = parsed.data;
    switch (request.method) {
        case "notify":
            return { frames: request.message.trim() === "" ? [] : [{ kind: "agent_notice", level: request.notifyType, text: request.message }] };
        case "setStatus":
            return { frames: [{ kind: "agent_status", key: request.statusKey, text: request.statusText ?? null }] };
        case "setWidget":
            return { frames: [{ kind: "agent_status", key: `widget:${request.widgetKey}`, text: request.widgetLines?.join("\n") ?? null }] };
        default: {
            const question = questionOf(request);
            if (question === undefined) {
                proc.send(cancelled(request.id));
                return { frames: [] };
            }
            return { frames: [], dialog: parkDialog(proc, request, question, context) };
        }
    }
};
