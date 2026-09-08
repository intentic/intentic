import { errorMessage } from "@intentic/base/errors";
import { buildIndex, type KnowledgeIndex } from "../notes/index-notes.js";
import { formatFrontmatter } from "../notes/frontmatter.js";
import { factsOf, type NoteFile, parseNote, type ParsedNote } from "../notes/note.js";
import { search } from "../notes/query.js";
import { configuredFolder, knowledgeRoot, readNotes, writeNote } from "../notes/read-notes.js";
import { selectVault, type VaultConnection, vaultConnections } from "../obsidian/connection.js";
import {
    isVaultError,
    relaxTlsFor,
    vaultAppend,
    vaultDelete,
    vaultInfo,
    vaultOpen,
    vaultRead,
    vaultSearch,
    vaultWalk,
    vaultWrite,
} from "../obsidian/rest.js";
import { type Args, flag, flagAll, has, number, parseArgs } from "./args.js";
import { linkFields, slugify } from "./note-shape.js";

// The `obsidian` CLI, live access to the owner's Obsidian vault over its Local REST API, beside `kb` on the agent's
// PATH. It parses and writes vault notes with the knowledge base's own parser, so `pull`/`push` keep a note the same
// typed object. Writing needs the owner's write switch on; exit codes match `kb`'s.

const USAGE = `obsidian: your Obsidian vault, live, through its Local REST API.

  obsidian status                is the vault reachable, and may I write to it
  obsidian vaults                every connected vault, by the name --vault takes
  obsidian ls [folder]           the markdown files in the vault
  obsidian read <file>           one note: its facts, its links, its text
  obsidian find <words…>         search the vault                    [--limit --context]
  obsidian open <file>           bring it to the front in Obsidian

  obsidian write <file> --body … write a note                        [--type --tag --link rel=target --title]
  obsidian append <file> --body … add to the end of a note
  obsidian rm <file>             delete a note

  obsidian pull <file…> | --all  copy vault notes into this workspace's knowledge folder   [--into]
  obsidian push <name…>          copy knowledge notes into the vault                       [--into]

pull and push are the bridge to \`kb\`: a note that crosses keeps its header, its tags and its [[links]], so
whichever side it lands on can read it. Writing to the vault needs the card's write switch on; pulling never
does, since it only writes here.

Add --json to any of these. --vault <name> picks one when more than one is connected.`;

// Shaping an answer.

const out = (value: string): void => {
    process.stdout.write(`${value}\n`);
};

interface Run {
    readonly args: Args;
    readonly vault: VaultConnection;
    readonly json: boolean;
}

const emit = (run: Run, json: unknown, text: string): void => out(run.json ? JSON.stringify(json, undefined, 2) : text);

const fail = (run: Run, message: string, code = 2): number => {
    emit(run, { error: message }, `obsidian: ${message}`);
    return code;
};

// A vault path read as a note the knowledge parser understands; only the text matters here.
const asNote = (path: string, content: string): ParsedNote => parseNote({ path, content, modifiedAt: 0, sizeBytes: content.length });

const chips = (note: ParsedNote): string =>
    [note.type, ...note.tags.map((tag) => `#${tag}`)].filter((chip) => chip !== undefined && chip !== "").join(" ");

const noteText = (note: ParsedNote, body: boolean): string =>
    [
        note.path,
        [note.title, chips(note)].filter((part) => part !== "").join("  ·  "),
        ...factsOf(note).map(([key, values]) => `  ${key}: ${values.join(", ")}`),
        ...(note.links.length === 0 ? [] : ["links to:", ...note.links.map((link) => `  → ${link.relation ?? "mentions"}  ${link.target}`)]),
        ...(body ? ["", note.body.trim()] : []),
    ].join("\n");

const noteJson = (note: ParsedNote): unknown => ({
    path: note.path,
    title: note.title,
    type: note.type,
    tags: note.tags,
    aliases: note.aliases,
    facts: Object.fromEntries(factsOf(note)),
    links: note.links.map((link) => ({ relation: link.relation, target: link.target })),
    body: note.body,
});

// A path the vault accepts from a loosely named note: "Ada" becomes "<card folder>/Ada.md"; anything already
// path-shaped is left as typed.
const vaultPath = (run: Run, name: string): string => {
    const into = flag(run.args, "into") ?? run.vault.folder;
    const withExtension = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
    if (withExtension.includes("/") || into === "") {
        return withExtension.replace(/^\/+/, "");
    }
    return `${into}/${withExtension}`;
};

// The verbs that read.

const statusVerb = async (run: Run): Promise<number> => {
    const info = await vaultInfo(run.vault);
    if (isVaultError(info)) {
        emit(run, { vault: run.vault.name, url: run.vault.url, reachable: false, ...info }, `obsidian: ${info.error}`);
        return 2;
    }
    emit(
        run,
        { vault: run.vault.name, url: run.vault.url, reachable: true, authenticated: info.authenticated ?? true, writable: run.vault.write },
        [
            `${run.vault.name}  ${run.vault.url}`,
            `  reachable, ${info.authenticated === false ? "but the key was refused" : "key accepted"}`,
            `  ${run.vault.write ? "writing is allowed" : "READ ONLY, turn the write switch on in the Obsidian card to change that"}`,
            `  new notes go to ${run.vault.folder === "" ? "the vault root" : run.vault.folder}`,
        ].join("\n"),
    );
    return 0;
};

const lsVerb = async (run: Run): Promise<number> => {
    const files = await vaultWalk(run.vault, (run.args.positionals[0] ?? "").replace(/^\/+|\/+$/g, ""));
    if (isVaultError(files)) {
        return fail(run, files.error);
    }
    if (files.length === 0) {
        emit(run, { files: [] }, "no markdown files there.");
        return 1;
    }
    emit(run, { files }, files.join("\n"));
    return 0;
};

const readVerb = async (run: Run): Promise<number> => {
    const name = run.args.positionals.join(" ");
    if (name === "") {
        return fail(run, "which note? obsidian read <file>");
    }
    const path = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
    const content = await vaultRead(run.vault, path);
    if (isVaultError(content)) {
        return fail(run, content.error, content.status === 404 ? 1 : 2);
    }
    const note = asNote(path, content);
    emit(run, noteJson(note), noteText(note, true));
    return 0;
};

const findVerb = async (run: Run): Promise<number> => {
    const query = run.args.positionals.join(" ");
    if (query === "") {
        return fail(run, "what for? obsidian find <words…>");
    }
    const hits = await vaultSearch(run.vault, query, number(run.args, "context", 120));
    if (isVaultError(hits)) {
        return fail(run, hits.error);
    }
    const limited = hits.slice(0, number(run.args, "limit", 25));
    if (limited.length === 0) {
        emit(run, { hits: [] }, "nothing in the vault matches.");
        return 1;
    }
    emit(
        run,
        { hits: limited },
        limited
            .map((hit) =>
                [
                    hit.filename,
                    ...(hit.matches ?? [])
                        .slice(0, 3)
                        .flatMap((match) => (match.context === undefined ? [] : [`  ${match.context.replaceAll("\n", " ").trim()}`])),
                ].join("\n"),
            )
            .join("\n"),
    );
    return 0;
};

const openVerb = async (run: Run): Promise<number> => {
    const name = run.args.positionals.join(" ");
    if (name === "") {
        return fail(run, "which note? obsidian open <file>");
    }
    const path = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
    const result = await vaultOpen(run.vault, path);
    if (isVaultError(result)) {
        return fail(run, result.error);
    }
    emit(run, { opened: path }, `opened ${path} in Obsidian.`);
    return 0;
};

// The verbs that write to the vault.

// The one gate that matters: named after the switch the owner actually sees, not "permission denied".
const refuseReadOnly = (run: Run, verb: string): number =>
    fail(run, `this vault is connected read-only: turn on "Let the agent write notes" in the Obsidian card to ${verb}.`);

const writeVerb = async (run: Run): Promise<number> => {
    if (!run.vault.write) {
        return refuseReadOnly(run, "write notes");
    }
    const name = run.args.positionals.join(" ").trim();
    if (name === "") {
        return fail(run, `what is it called? obsidian write "Ada Lovelace" --type person --body "…"`);
    }
    const title = flag(run.args, "title") ?? name.replace(/\.md$/i, "").split("/").pop() ?? name;
    const path = vaultPath(run, name.includes("/") || name.toLowerCase().endsWith(".md") ? name : slugify(name));
    const type = flag(run.args, "type");
    const tags = flagAll(run.args, "tag");
    // Same header shape `kb new` writes, so the knowledge base can read this note back without translation.
    const fields = new Map<string, string[]>([
        ...(type === undefined ? [] : ([["type", [type]]] as [string, string[]][])),
        ["title", [title]],
        ...(tags.length === 0 ? [] : ([["tags", [...tags]]] as [string, string[]][])),
        ...linkFields(flagAll(run.args, "link")),
    ]);
    const body = flag(run.args, "body") ?? "";
    const result = await vaultWrite(run.vault, path, formatFrontmatter(fields, body === "" ? "" : `${body}\n`));
    if (isVaultError(result)) {
        return fail(run, result.error);
    }
    emit(run, { path, title, type }, `wrote ${path}`);
    return 0;
};

const appendVerb = async (run: Run): Promise<number> => {
    if (!run.vault.write) {
        return refuseReadOnly(run, "add to notes");
    }
    const name = run.args.positionals.join(" ").trim();
    const body = flag(run.args, "body");
    if (name === "" || body === undefined) {
        return fail(run, `obsidian append <file> --body "…"`);
    }
    const path = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
    const result = await vaultAppend(run.vault, path, `\n${body}\n`);
    if (isVaultError(result)) {
        return fail(run, result.error);
    }
    emit(run, { path }, `added to ${path}`);
    return 0;
};

const removeVerb = async (run: Run): Promise<number> => {
    if (!run.vault.write) {
        return refuseReadOnly(run, "delete notes");
    }
    const name = run.args.positionals.join(" ").trim();
    if (name === "") {
        return fail(run, "which note? obsidian rm <file>");
    }
    const path = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
    const result = await vaultDelete(run.vault, path);
    if (isVaultError(result)) {
        return fail(run, result.error, result.status === 404 ? 1 : 2);
    }
    emit(run, { deleted: path }, `deleted ${path}`);
    return 0;
};

// The bridge to the knowledge folder.

// A copy in either direction: the workspace folder and the vault can't become each other (the vault only exists while
// Obsidian is open). Paths are kept as-is, so a `[[link]]` between two crossed notes still resolves.

const pullVerb = async (run: Run, root: string): Promise<number> => {
    const explicit = run.args.positionals.filter((positional) => positional !== "");
    if (explicit.length === 0 && !has(run.args, "all")) {
        return fail(run, "which notes? obsidian pull <file…>, or --all for the whole vault.");
    }
    const wanted =
        explicit.length > 0 ? explicit.map((name) => (name.toLowerCase().endsWith(".md") ? name : `${name}.md`)) : await vaultWalk(run.vault);
    if (isVaultError(wanted)) {
        return fail(run, wanted.error);
    }
    const into = (flag(run.args, "into") ?? "").replace(/^\/+|\/+$/g, "");
    const written: string[] = [];
    const failed: { file: string; error: string }[] = [];
    for (const file of wanted) {
        const content = await vaultRead(run.vault, file);
        if (isVaultError(content)) {
            failed.push({ file, error: content.error });
            continue;
        }
        const target = into === "" ? file : `${into}/${file}`;
        if (await writeNote(root, target, content)) {
            written.push(target);
        } else {
            failed.push({ file, error: `"${target}" is not a markdown path inside the knowledge folder` });
        }
    }
    emit(
        run,
        { pulled: written, failed, folder: root },
        [
            `${written.length} note${written.length === 1 ? "" : "s"} copied into ${root}`,
            ...written.map((path) => `  ${path}`),
            ...(failed.length === 0 ? [] : ["could not copy:", ...failed.map((entry) => `  ${entry.file}, ${entry.error}`)]),
        ].join("\n"),
    );
    return written.length === 0 ? 1 : 0;
};

const pushVerb = async (run: Run, index: KnowledgeIndex): Promise<number> => {
    if (!run.vault.write) {
        return refuseReadOnly(run, "copy notes into it");
    }
    const names = run.args.positionals.filter((positional) => positional !== "");
    if (names.length === 0) {
        return fail(run, "which notes? obsidian push <name…>: a title, an alias, a filename or a path.");
    }
    const into = flag(run.args, "into") ?? run.vault.folder;
    const written: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const name of names) {
        const note = index.resolve(name) ?? index.byPath.get(name);
        if (note === undefined) {
            // Never a silent miss: the closest names found come back too, so a retry beats a guess.
            const near = search(index, { query: name, limit: 3 }).map((hit) => hit.path);
            failed.push({ name, error: `no note by that name${near.length === 0 ? "" : `, closest: ${near.join(", ")}`}` });
            continue;
        }
        const target = into === "" ? note.path : `${into.replace(/^\/+|\/+$/g, "")}/${note.path}`;
        // The bytes the index was built from, not a re-serialisation, so nothing reorders or reflows on its own.
        const result = await vaultWrite(run.vault, target, note.content);
        if (isVaultError(result)) {
            failed.push({ name, error: result.error });
            continue;
        }
        written.push(target);
    }
    emit(
        run,
        { pushed: written, failed },
        [
            `${written.length} note${written.length === 1 ? "" : "s"} copied into the vault`,
            ...written.map((path) => `  ${path}`),
            ...(failed.length === 0 ? [] : ["could not copy:", ...failed.map((entry) => `  ${entry.name}, ${entry.error}`)]),
        ].join("\n"),
    );
    return written.length === 0 ? 1 : 0;
};

// Wiring.

const workspaceRoot = (): string => process.env["WORKSPACE_ROOT"] ?? "/work";

// Verbs needing the workspace index; others skip it, so neither side blocks the other.
const NEEDS_KNOWLEDGE = new Set(["push"]);

const main = async (): Promise<number> => {
    const args = parseArgs(process.argv.slice(2));
    const json = has(args, "json");
    if (args.verb === "" || args.verb === "help" || has(args, "help")) {
        out(USAGE);
        return args.verb === "" && !has(args, "help") ? 2 : 0;
    }
    const connections = vaultConnections(process.env);
    if (args.verb === "vaults") {
        if (connections.length === 0) {
            out(json ? JSON.stringify({ vaults: [] }, undefined, 2) : "no Obsidian vault is connected, add the Obsidian card in Capabilities.");
            return 1;
        }
        out(
            json
                ? JSON.stringify({ vaults: connections.map(({ apiKey: _apiKey, ...rest }) => rest) }, undefined, 2)
                : connections
                      .map((connection) =>
                          [
                              `${connection.name}  ${connection.url}`,
                              `  ${connection.write ? "read and write" : "read only"}${connection.problem === undefined ? "" : `  ·  ${connection.problem}`}`,
                          ].join("\n"),
                      )
                      .join("\n"),
        );
        return 0;
    }
    const selected = selectVault(connections, flag(args, "vault"));
    if ("error" in selected) {
        out(json ? JSON.stringify(selected, undefined, 2) : `obsidian: ${selected.error}`);
        return 2;
    }
    // Before the first request, https only; see rest.ts for why this is process-level.
    relaxTlsFor(selected.vault.url, process.env);
    const run: Run = { args, vault: selected.vault, json };
    const workspace = workspaceRoot();
    const root = knowledgeRoot(workspace, process.env["KB_FOLDER"] ?? (await configuredFolder(workspace)));
    const files: readonly NoteFile[] = NEEDS_KNOWLEDGE.has(args.verb) ? await readNotes(root) : [];
    switch (args.verb) {
        case "status": {
            return await statusVerb(run);
        }
        case "ls":
        case "list": {
            return await lsVerb(run);
        }
        case "read":
        case "note": {
            return await readVerb(run);
        }
        case "find":
        case "search": {
            return await findVerb(run);
        }
        case "open": {
            return await openVerb(run);
        }
        case "write":
        case "new": {
            return await writeVerb(run);
        }
        case "append": {
            return await appendVerb(run);
        }
        case "rm":
        case "delete": {
            return await removeVerb(run);
        }
        case "pull": {
            return await pullVerb(run, root);
        }
        case "push": {
            if (files.length === 0) {
                emit(run, { folder: root, notes: 0 }, `no notes yet in ${root}, nothing to push.`);
                return 1;
            }
            return await pushVerb(run, buildIndex(files));
        }
        default: {
            out(`obsidian: no verb "${args.verb}".\n\n${USAGE}`);
            return 2;
        }
    }
};

// A crash still names the vault and verb, and exits 2, distinct from 1 (found nothing), like `kb`.
main().then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        process.stderr.write(`obsidian: ${errorMessage(error)}\n`);
        process.exitCode = 2;
    },
);
