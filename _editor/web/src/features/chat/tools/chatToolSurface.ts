import type { SubagentSession, TranscriptTool } from "@intentic/sandbox-contract";
import type { MarkdownDecorator } from "@intentic/ui/markdown";
import { inject, type InjectionKey } from "vue";

// What a card can reach beyond itself, injected rather than imported, so a published conversation renders the
// same card with nothing to click instead of a second copy. Absent capabilities offer nothing; they never throw.
export interface ChatSurface {
    // A workspace path as something an `<img>` can show, or undefined; not optional, every surface answers it.
    readonly imageUrl: (path: string) => string | undefined;
    // Open a workspace file, at a line where known; absent means paths render as text, not buttons.
    readonly openFile?: (path: string, line?: number) => void;
    // Show a call's picture in the conversation's viewer (ChatShotViewer); absent means a picture opens as a file.
    readonly viewPicture?: (toolId: string, path: string) => void;
    // Decorates a document's prose with workspace links; keeps the query client out of a published page's bundle.
    readonly decorate?: MarkdownDecorator;
    // The live shell behind a command card, and the door onto it; both or neither.
    readonly commandTerminal?: () => string | undefined;
    readonly watchTerminal?: (session: string) => void;
    // The live browser behind a browser card, on the same terms.
    readonly commandBrowser?: () => string | undefined;
    readonly watchBrowser?: (session: string) => void;
    // A delegation's own calls, for a card whose page carried their count instead of the calls themselves. Absent
    // wherever the transcript arrives whole (a published page), where there is nothing to fetch.
    readonly toolChildren?: (toolId: string) => Promise<TranscriptTool[]>;
    // The roster's record of a subagent a card started, by its own id: how it is doing now, which outlasts the turn that
    // started a spawned one. Undefined once the roster forgets it (settled, and past the newest it keeps) or where none
    // is reachable.
    readonly subagent?: (id: string) => SubagentSession | undefined;
    // Route to a spawned subagent's own conversation, by its id, which is the conversation's; a string, not RouterLink,
    // since the card may render with no router. An in-process one has no place of its own: its work is its card's.
    readonly conversationRoute?: (id: string) => string;
    // How a route is entered without a page load; present wherever `conversationRoute` is.
    readonly navigate?: (route: string) => void;
    // Shows the subagent a card started in the chat, whichever kind: a spawned one's own conversation, an in-process
    // one's transcript in the column of the conversation whose turn ran it. Absent where there is no chat to show it in.
    readonly openSubagent?: (subagent: { readonly id: string; readonly kind: SubagentSession["kind"] }) => void;
}

// Nothing to follow: no pictures, nothing clickable. Used by published pages and cards mounted outside the chat.
const INERT_SURFACE: ChatSurface = { imageUrl: () => undefined };

// `Symbol.for`: survives a hot reload of this module, so a surface mounted after one still finds its provider
// (useChat-view.ts has the incident).
export const CHAT_SURFACE: InjectionKey<ChatSurface> = Symbol.for(`intentic.chat-surface`);

export const useChatSurface = (): ChatSurface => inject(CHAT_SURFACE, INERT_SURFACE);
