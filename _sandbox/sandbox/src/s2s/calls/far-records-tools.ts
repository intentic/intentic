import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { type DiagnosticsAnswer, type DiagnosticsQuery, DiagnosticsQuerySchema } from "@intentic/sandbox-contract/schemas/diagnostics";
import { z } from "zod";
import { sdk } from "../../engines/claude-sdk.js";
import { MAX_ANSWER_CHARS } from "../../logs/diagnostics-render.js";
import type { FarAnswer } from "./far-operate-tools.js";

// READING ANOTHER SANDBOX'S RECORDS, the asking side's tools: `conversations`, `conversation` and `diagnostics` on that
// sandbox's tool server, answered as its own `agents ls|find|show` and `diagnostics` answer, read-only and starting no
// turn there. One set of tools over either way of reaching it (`FarRecords`): a link card's records doors
// (links/link-mounts.ts), or a contact's `records.*` calls (s2s/calls/call-tools.ts). What may be read is the far side's word.

// One fleet read: the roster or a search (no handle), or one conversation, with its query as `agents` sends it.
export interface FarFleetAsk {
    readonly handle?: string;
    readonly query: Readonly<Record<string, string>>;
}

// How the tools reach the far sandbox's records: a fleet read answered as that sandbox answered it (its refusal of an
// unknown handle included), or why there is no answer; and one diagnostics query.
export interface FarRecords {
    readonly fleet: (ask: FarFleetAsk) => Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly message: string }>;
    readonly diagnostics: (query: DiagnosticsQuery) => Promise<FarAnswer<DiagnosticsAnswer>>;
}

// How the tools name the far sandbox: by name, as a phrase that opens a sentence (`The linked sandbox "ops"`), and when
// they answer (`shared`, one sentence).
export interface FarRecordsWords {
    readonly sandbox: string;
    readonly title: string;
    readonly shared: string;
}

// A type, not an interface: the SDK's result type wants the implicit index signature only an alias carries.
type ToolAnswer = { content: { type: "text"; text: string }[] };

// A records answer as the model reads it: the far side's JSON, cut at the size every diagnostics answer is held to.
const recordsAnswer = (text: string): ToolAnswer => ({
    content: [
        {
            type: "text",
            text: text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}… (cut at ${MAX_ANSWER_CHARS / 1000} KB: narrow it)` : text,
        },
    ],
});

// The parameters given, as a query: an unset one is left out.
const queryOf = (params: Readonly<Record<string, string | undefined>>): Record<string, string> =>
    Object.fromEntries(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])));

const fleetRead = async (far: FarRecords, ask: FarFleetAsk): Promise<ToolAnswer> => {
    const read = await far.fleet(ask);
    return recordsAnswer(JSON.stringify(read.ok ? read.body : { ok: false, message: read.message }));
};

/** The records tools of one far sandbox's server. */
export const farRecordsTools = (far: FarRecords, words: FarRecordsWords) => {
    const { sandbox, title, shared } = words;
    return [
        sdk().tool(
            "conversations",
            `${title}'s conversations, most recently active first, or with \`find\` the ones that said or ran a phrase, as its own \`agents ls\` and \`agents find\` answer. ${shared}`,
            {
                find: z.string().min(1).optional().describe("A phrase to search for instead of listing."),
                all: z.boolean().optional().describe("Include the archive."),
                limit: z.number().int().min(1).max(100).optional(),
            },
            async ({ find, all, limit }) => fleetRead(far, { query: queryOf({ q: find, all: all === true ? "1" : undefined, limit: limit?.toString() }) }),
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
                fleetRead(far, {
                    handle,
                    query: queryOf({
                        transcript: transcript === true || last !== undefined || grep !== undefined ? "1" : undefined,
                        last: last?.toString(),
                        grep,
                        message: message?.toString(),
                    }),
                }),
            { annotations: toolAnnotations("read") },
        ),
        sdk().tool(
            "diagnostics",
            `One diagnostics query of "${sandbox}"'s records, as its own \`diagnostics\` tools answer: \`errors\` (its daemon log, or \`source: "browser"\` its editor's reports; \`from\`/\`until\` read around a moment), \`timeline\` (one conversation), \`turns\`, \`restarts\`, \`slow\`, \`resources\`. Arguments as those tools take them, with \`query\` naming which. ${shared}`,
            { ask: DiagnosticsQuerySchema.describe('The query, e.g. {"query": "timeline", "conversationId": "glad-falcon-puep"}.') },
            async ({ ask }) => {
                const answered = await far.diagnostics(ask);
                return recordsAnswer(answered.ok ? answered.value.text : `"${sandbox}": ${answered.message}`);
            },
            { annotations: toolAnnotations("read") },
        ),
    ];
};
