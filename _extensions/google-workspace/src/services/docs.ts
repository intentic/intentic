import { readFile } from "node:fs/promises";
import { type Args, flag, positional, required } from "../cli/args.js";
import { type Command, type CommandGroup, printJson } from "../cli/command.js";
import { row } from "../cli/format.js";
import { type GoogleDoc, documentText } from "../google/doc-text.js";
import { call } from "../google/request.js";

const API = "https://docs.googleapis.com/v1/documents";

/* WHAT THIS DOES AND DOES NOT DO WITH A GOOGLE DOC. Read it, make one, add to the end of it, swap text
 * throughout it. Not: styling, tables, images, comments, suggestions.
 *
 * That is a deliberate stop rather than an unfinished job. The Docs API expresses editing as a batch of
 * index-addressed mutations against a document whose indices every earlier mutation in the same batch has
 * already moved, correct use of it means maintaining an offset model of a document nobody in this process can
 * see. The four verbs below need no such model, and they are what "put the summary in a doc and share it"
 * actually requires. Anything past them belongs to a person with the document open. */

const textOf = async (args: Args): Promise<string> => {
    const file = flag(args, "from");
    return file === undefined ? required(args, "text") : readFile(file, "utf8");
};

const read: Command = {
    name: "read",
    summary: "Read a document as text",
    usage: "gw docs read <documentId>",
    run: async (ctx) => {
        const doc = await call<GoogleDoc>(ctx.session, { url: `${API}/${encodeURIComponent(positional(ctx.args, 1, "A document id"))}` });
        if (ctx.json) {
            printJson(ctx, doc);
            return;
        }
        ctx.out(`# ${doc.title ?? "(untitled)"}`);
        ctx.out("");
        ctx.out(documentText(doc));
    },
};

const create: Command = {
    name: "create",
    summary: "Make a document, optionally with content",
    usage: 'gw docs create --title "…" [--text "…" | --from FILE]',
    writes: true,
    run: async (ctx) => {
        const doc = await call<{ documentId: string; title?: string }>(ctx.session, {
            method: "POST",
            url: API,
            body: { title: required(ctx.args, "title") },
        });
        const given = flag(ctx.args, "text") !== undefined || flag(ctx.args, "from") !== undefined;
        const body = given ? await textOf(ctx.args) : "";
        if (body !== "") {
            await call(ctx.session, {
                method: "POST",
                url: `${API}/${encodeURIComponent(doc.documentId)}:batchUpdate`,
                body: { requests: [{ insertText: { location: { index: 1 }, text: body } }] },
            });
        }
        ctx.out(row(doc.documentId, doc.title ?? "", `https://docs.google.com/document/d/${doc.documentId}/edit`));
    },
};

const append: Command = {
    name: "append",
    summary: "Add text to the end of a document",
    usage: 'gw docs append <documentId> --text "…" | --from FILE',
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A document id");
        const text = await textOf(ctx.args);
        await call(ctx.session, {
            method: "POST",
            url: `${API}/${encodeURIComponent(id)}:batchUpdate`,
            // endOfSegmentLocation is what spares this from computing the document's length first, and from
            // being wrong about it the moment somebody else is typing in the same document.
            body: { requests: [{ insertText: { endOfSegmentLocation: {}, text: text.startsWith("\n") ? text : `\n${text}` } }] },
        });
        ctx.out(`appended ${text.length} characters to ${id}`);
    },
};

const replace: Command = {
    name: "replace",
    summary: "Swap every occurrence of some text",
    usage: 'gw docs replace <documentId> --find "old" --with "new" [--case]',
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A document id");
        const answer = await call<{ replies?: { replaceAllText?: { occurrencesChanged?: number } }[] }>(ctx.session, {
            method: "POST",
            url: `${API}/${encodeURIComponent(id)}:batchUpdate`,
            body: {
                requests: [
                    {
                        replaceAllText: {
                            containsText: { text: required(ctx.args, "find"), matchCase: ctx.args.flags.has("case") },
                            replaceText: flag(ctx.args, "with") ?? "",
                        },
                    },
                ],
            },
        });
        ctx.out(`replaced ${answer.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0} occurrences in ${id}`);
    },
};

export const docsGroup: CommandGroup = {
    name: "docs",
    summary: "Docs — read, create, append, find-and-replace",
    commands: [read, create, append, replace],
};
