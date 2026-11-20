// browsing: what the sandbox's browsers remember of where they went (an index per browser profile), and the search
// engine's suggestions for what is being typed into the address bar. The address bar itself is drawn and ranked in the
// editor; these are the two things it cannot know on its own.
import { z } from "zod";

// The search engines the address bar can send a query to. Brave is the default: an index of its own, no account.
export const SEARCH_ENGINES = ["brave", "google", "duckduckgo", "bing", "kagi"] as const;
export const SearchEngineSchema = z.enum(SEARCH_ENGINES);
export type SearchEngine = z.infer<typeof SearchEngineSchema>;
export const DEFAULT_SEARCH_ENGINE: SearchEngine = "brave";

// Where each engine takes a query, and how a results page names it: the editor builds the address from `search`, and the
// sandbox reads a visited results page back into a search term with `host` and `param`.
export interface SearchEngineInfo {
    readonly name: string;
    // The query, URL-encoded, goes on the end.
    readonly search: string;
    readonly host: string;
    // The query parameter a results page carries the search in.
    readonly param: string;
}

export const SEARCH_ENGINE_INFO = {
    brave: { name: "Brave", search: "https://search.brave.com/search?q=", host: "search.brave.com", param: "q" },
    google: { name: "Google", search: "https://www.google.com/search?q=", host: "www.google.com", param: "q" },
    duckduckgo: { name: "DuckDuckGo", search: "https://duckduckgo.com/?q=", host: "duckduckgo.com", param: "q" },
    bing: { name: "Bing", search: "https://www.bing.com/search?q=", host: "www.bing.com", param: "q" },
    kagi: { name: "Kagi", search: "https://kagi.com/search?q=", host: "kagi.com", param: "q" },
} as const satisfies Readonly<Record<SearchEngine, SearchEngineInfo>>;

// A browser profile's key: `_own` for the person's own window, `web` for the agents' credential-free browser, or a
// signed-in account's id. One index per profile; the person's own history is `_own`'s alone.
export const OWN_BROWSING_PROFILE = "_own";
export const BrowsingProfileSchema = z
    .string()
    .regex(/^[\w.-]{1,80}$/)
    .describe("Which browser's history: `_own` for your own window, `web` for the agents' browser, or a signed-in account's id.");

export const BrowsingEntrySchema = z.object({
    url: z.string().describe("The page's address, as the browser committed it."),
    title: z.string().optional().describe("The page's title when last seen. Absent for a page that never gave one."),
    visits: z.number().int().nonnegative().describe("How many times it was visited."),
    typed: z.number().int().nonnegative().describe("How many of those visits were typed into the address bar rather than reached by a link."),
    last: z.number().describe("When it was last visited, in milliseconds."),
    frecency: z
        .number()
        .nonnegative()
        .describe("How much it is worth suggesting: how often and how recently it was visited, typed visits counting more. Only comparable within one answer."),
});
export type BrowsingEntry = z.infer<typeof BrowsingEntrySchema>;

export const BrowsingTermSchema = z.object({
    term: z.string().describe("What was searched for."),
    count: z.number().int().positive().describe("How many times."),
    last: z.number().describe("When it was last searched for, in milliseconds."),
});
export type BrowsingTerm = z.infer<typeof BrowsingTermSchema>;

export const BrowsingHistoryQuerySchema = z.object({
    profile: BrowsingProfileSchema,
    since: z
        .string()
        .max(200)
        .optional()
        .describe("The cursor a previous answer gave, to be told only what changed after it. Absent, or one the sandbox no longer recognises, answers the whole index."),
});
export type BrowsingHistoryQuery = z.infer<typeof BrowsingHistoryQuerySchema>;

export const BrowsingHistorySchema = z.object({
    profile: z.string().describe("Whose history this is."),
    cursor: z.string().describe("Hand this back as `since` to be told only what changes after this answer."),
    full: z.boolean().describe("True when this is the whole index, which replaces whatever the caller held; false when it is only what changed since the cursor given."),
    entries: z
        .array(BrowsingEntrySchema)
        .describe("The pages: on a full answer the most worth suggesting, best first and at most a few thousand; otherwise each page added or changed since the cursor."),
    removed: z.array(z.string()).describe("Addresses forgotten since the cursor. Always empty on a full answer."),
    terms: z.array(BrowsingTermSchema).describe("Searches made, most recent first: every one on a full answer, otherwise those added or changed since the cursor."),
    profiles: z.array(z.string()).describe("Every profile the sandbox holds a history for, so a history page can offer the others."),
});
export type BrowsingHistory = z.infer<typeof BrowsingHistorySchema>;

// What to forget: some addresses, everything visited in a stretch of time, or all of it. Spelled out rather than inferred
// from which fields are present, so a call that forgot its arguments cannot clear everything by accident.
export const BrowsingForgetSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("urls"),
        urls: z.array(z.string()).min(1).max(1000).describe("The addresses to forget, exactly as the history lists them."),
    }),
    z.object({
        kind: z.literal("range"),
        from: z.number().describe("The start of the stretch, in milliseconds, included."),
        to: z.number().describe("Its end, in milliseconds, excluded."),
    }),
    z.object({ kind: z.literal("all") }),
]);
export type BrowsingForget = z.infer<typeof BrowsingForgetSchema>;

export const BrowsingForgetInputSchema = z.object({
    profile: BrowsingProfileSchema,
    forget: BrowsingForgetSchema.describe("What to forget."),
});
export type BrowsingForgetInput = z.infer<typeof BrowsingForgetInputSchema>;

export const BrowsingForgetResultSchema = z.object({
    removed: z.number().int().nonnegative().describe("How many addresses left the history entirely."),
});
export type BrowsingForgetResult = z.infer<typeof BrowsingForgetResultSchema>;

export const SearchSuggestQuerySchema = z.object({
    q: z.string().min(1).max(200).describe("What has been typed so far."),
    engine: SearchEngineSchema.describe("Whose suggestions: the search engine the address bar sends queries to."),
});
export type SearchSuggestQuery = z.infer<typeof SearchSuggestQuerySchema>;

export const SearchSuggestionsSchema = z.object({
    q: z.string().describe("The text these suggestions are for, so a late answer can be told from a current one."),
    suggestions: z.array(z.string()).describe("What the engine suggests searching for, best first. Empty when it had nothing, or did not answer in time."),
});
export type SearchSuggestions = z.infer<typeof SearchSuggestionsSchema>;

// Whether an agent's turn is recorded as it drives a browser window, kept with the conversation's artifacts (the
// daemon's browser/media/recordings.ts, read at the turn's browser calls). Off by default: every turn's browsing kept as
// video is disk nobody asked for.
export const RecordAgentBrowsingSchema = z
    .boolean()
    .default(false)
    .describe(
        "Record the browser window as an agent's turn drives it, and keep the video with that conversation's artifacts. Only windows the sandbox streams the new way are recorded, and without sound.",
    );
