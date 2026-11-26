import { join } from "node:path";
import { z } from "zod";
import type { ExtensionHost } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { callingExtensionIdentity } from "./calling-extension.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// WHICH EXTENSION STARTED WHICH CONVERSATION (2026-11-26). An extension's backend starts a conversation through POST /agent
// with its own token (the pipelines extension's fix agent, say) and hears that conversation's runs end on its event stream
// (`permissions.events: ["run"]`, own.routes.ts), and no other conversation's. Recorded at the door, from the token the
// request carried, never from its body; kept under the history root, where no workspace write reaches, so a turn cannot
// make another extension hear its conversation. Keyed by the extension's identity (publisher.name), which survives an
// update and a re-install. Only a conversation the request opened is recorded: words an extension says into somebody
// else's conversation do not make it the extension's.

const StartedSchema = z.object({ extension: z.string(), at: z.number() });

export const extensionConversationsDocument = defineDocument({
    root: "history",
    path: "extension-conversations.json",
    // Travels with the conversations it names, so a moved sandbox's extension keeps hearing its own.
    portability: "carry",
    granularity: "record",
    schema: StartedSchema,
});

// Kept newest last up to this many; an extension that starts one conversation an hour fills it in three months, and a
// conversation that old has long settled.
const KEPT = 2_000;

type Started = Readonly<Record<string, z.infer<typeof StartedSchema>>>;

// One handle per history root: a handle holds what its file last read as while the file has not changed, and a run
// settles far more often than an extension starts anything.
const handles = new Map<string, ReturnType<typeof open>>();
const open = (historyRoot: string) =>
    openDocument(extensionConversationsDocument, join(historyRoot, extensionConversationsDocument.path), { fallback: (): Started => ({}) });
const fileOf = (historyRoot: string): ReturnType<typeof open> => {
    const known = handles.get(historyRoot);
    if (known !== undefined) {
        return known;
    }
    const made = open(historyRoot);
    handles.set(historyRoot, made);
    return made;
};

/** Records that `extension` (its publisher.name) started `conversationId`. */
export const recordExtensionConversation = async (historyRoot: string, conversationId: string, extension: string, now = Date.now()): Promise<void> => {
    await fileOf(historyRoot).update((started) => {
        if (started[conversationId]?.extension === extension) {
            return started;
        }
        const entries = Object.entries({ ...started, [conversationId]: { extension, at: now } }).toSorted(([, a], [, b]) => a.at - b.at);
        return Object.fromEntries(entries.slice(-KEPT));
    });
};

/** The extension (publisher.name) that started `conversationId`, or undefined for one no extension started. */
export const extensionThatStarted = async (historyRoot: string, conversationId: string): Promise<string | undefined> =>
    (await fileOf(historyRoot).read())[conversationId]?.extension;

/**
 * At POST /agent: when the request carries an extension's token and opens a conversation that does not exist yet, records
 * that extension as the one that started it. Before the turn is started, so its run cannot settle unheard.
 */
export const recordIfExtensionOpens = async (
    services: Pick<Services, "agents" | "config" | "extensionBackend"> & ExtensionHost,
    header: (name: string) => string | null | undefined,
    conversationId: string,
): Promise<void> => {
    if (services.agents.entry(conversationId) !== undefined) {
        return;
    }
    const extension = await callingExtensionIdentity(services, header);
    if (extension !== undefined) {
        await recordExtensionConversation(services.config.historyRoot, conversationId, extension);
    }
};
