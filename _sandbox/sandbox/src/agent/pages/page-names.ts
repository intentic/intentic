// The page tools' names, apart from the tools themselves, so the stream reading drafts and the permission gate can name
// them without loading what the tools carry (a browser, the store).

export const SHOW_PAGE_TOOL = "show_page";
export const ASK_PAGE_TOOL = "ask_page";

// The two as the model calls them: mounted on the `ui` server beside `ask`.
export const PAGE_TOOL_NAMES: ReadonlySet<string> = new Set([`mcp__ui__${SHOW_PAGE_TOOL}`, `mcp__ui__${ASK_PAGE_TOOL}`]);
