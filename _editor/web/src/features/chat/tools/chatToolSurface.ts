import type { MarkdownDecorator } from "@intentic/ui/markdown";
import { inject, type InjectionKey } from "vue";

// What a card can reach beyond itself, injected rather than imported, so a published conversation renders the
// same card with nothing to click instead of a second copy. Absent capabilities offer nothing; they never throw.
export interface ChatSurface {
    // A workspace path as something an `<img>` can show, or undefined; not optional, every surface answers it.
    readonly imageUrl: (path: string) => string | undefined;
    // Open a workspace file, at a line where known; absent means paths render as text, not buttons.
    readonly openFile?: (path: string, line?: number) => void;
    // Decorates a document's prose with workspace links; keeps the query client out of a published page's bundle.
    readonly decorate?: MarkdownDecorator;
    // The live shell behind a command card, and the door onto it; both or neither.
    readonly commandTerminal?: () => string | undefined;
    readonly watchTerminal?: (session: string) => void;
    // The live browser behind a browser card, on the same terms.
    readonly commandBrowser?: () => string | undefined;
    readonly watchBrowser?: (session: string) => void;
    // Route to a delegation's transcript; a string, not RouterLink, since the card may render with no router.
    readonly subagentRoute?: (toolId: string) => string;
    // How a route is entered without a page load; present wherever `subagentRoute` is.
    readonly navigate?: (route: string) => void;
}

// Nothing to follow: no pictures, nothing clickable. Used by published pages and cards mounted outside the chat.
const INERT_SURFACE: ChatSurface = { imageUrl: () => undefined };

// `Symbol.for`: survives a hot reload of this module, so a surface mounted after one still finds its provider
// (useChat-view.ts has the incident).
export const CHAT_SURFACE: InjectionKey<ChatSurface> = Symbol.for(`intentic.chat-surface`);

export const useChatSurface = (): ChatSurface => inject(CHAT_SURFACE, INERT_SURFACE);
