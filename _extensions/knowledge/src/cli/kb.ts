import { errorMessage } from "@intentic/base/errors";
import { formatFrontmatter } from "../notes/frontmatter.js";
import { buildIndex, type BrokenLink, overviewOf, type NoteEdge, type KnowledgeIndex } from "../notes/index-notes.js";
import { factsOf, type ParsedNote } from "../notes/note.js";
import { neighbourhood, search } from "../notes/query.js";
import { configuredFolder, readNotes, knowledgeRoot, writeNote } from "../notes/read-notes.js";
import { type Drift, VOCABULARY_PATH, VOCABULARY_TYPE } from "../notes/vocabulary.js";
import { type Args, flag, flagAll, has, number, parseArgs } from "./args.js";
import { linkFields, slugify, wikiLink } from "./note-shape.js";

// The `kb` CLI on the agent's PATH, driving the same parser/resolver/index the panel uses, so an answer can't disagree
// with what the panel shows. Every line leads with the note's path; `--json` gives a program the same content. Exit
// codes: 0 found, 1 nothing, 2 couldn't run.

const USAGE = `kb, the knowledge base: notes, the things in them, and how they connect.

  kb find <words…>            search names, facts and prose        [--type --tag --linked-to --limit]
  kb list                     every note, newest first             [--type --tag --limit]
  kb read <name>              one note, with what it links to and what links to it
  kb links <name>             just the connections, both directions
  kb graph <name>             everything within a few steps        [--depth]
  kb new <title>              write a correctly shaped note        [--type --tag --link rel=target --body --path]
  kb set <name> <field> [v…]  replace a header field (no value clears it)
  kb link <name> <rel> <to>   connect two notes by a named relationship
  kb check                    broken links, orphans, vocabulary drift, unreadable headers
  kb vocab                    the kinds and relationships this knowledge base has adopted

A <name> is anything that names a note: its title, an alias, its filename or its path.
Add --json to any of these. Knowledge folder: $KB_FOLDER (default "knowledge/" in the workspace).`;

// Shaping an answer.

const chips = (note: ParsedNote): string =>
    [note.type, ...note.tags.map((tag) => `#${tag}`)].filter((chip) => chip !== undefined && chip !== "").join(" ");

const arrow = (edge: NoteEdge, index: KnowledgeIndex, direction: "out" | "in"): string => {
    const other = direction === "out" ? edge.to : edge.from;
    const name = other === undefined ? `${edge.target} (not written yet)` : (index.byPath.get(other)?.title ?? other);
    const relation = edge.relation ?? "mentions";
    return `  ${direction === "out" ? "→" : "←"} ${relation}  ${name}${other === undefined ? "" : `  ${other}`}`;
};

const connections = (note: ParsedNote, index: KnowledgeIndex): string[] => {
    const out = (index.outgoing.get(note.path) ?? []).map((edge) => arrow(edge, index, "out"));
    const back = (index.backlinks.get(note.path) ?? []).map((edge) => arrow(edge, index, "in"));
    return [...(out.length === 0 ? [] : ["links to:", ...out]), ...(back.length === 0 ? [] : ["linked from:", ...back])];
};

const noteText = (note: ParsedNote, index: KnowledgeIndex, body: boolean): string =>
    [
        note.path,
        [note.title, chips(note)].filter((part) => part !== "").join("  ·  "),
        ...factsOf(note).map(([key, values]) => `  ${key}: ${values.join(", ")}`),
        ...(body ? ["", note.body.trim(), ""] : []),
        ...connections(note, index),
    ].join("\n");

// JSON shape of one note: the same facts the text form carries, for a program reading this.
const noteJson = (note: ParsedNote, index: KnowledgeIndex): unknown => ({
    path: note.path,
    title: note.title,
    type: note.type,
    tags: note.tags,
    aliases: note.aliases,
    facts: Object.fromEntries(factsOf(note)),
    body: note.body,
    linksTo: (index.outgoing.get(note.path) ?? []).map((edge) => ({ relation: edge.relation, target: edge.target, path: edge.to })),
    linkedFrom: (index.backlinks.get(note.path) ?? []).map((edge) => ({ relation: edge.relation, from: edge.from })),
    modifiedAt: note.modifiedAt,
});

// The verbs.

interface Run {
    readonly args: Args;
    readonly root: string;
    readonly json: boolean;
}

const out = (value: string): void => {
    process.stdout.write(`${value}\n`);
};
const emit = (run: Run, json: unknown, text: string): void => out(run.json ? JSON.stringify(json, undefined, 2) : text);

// Never resolves silently to nothing: a missing name is echoed back with the closest names the knowledge base does
// hold.
const findNote = (index: KnowledgeIndex, name: string): ParsedNote | { readonly missing: string; readonly near: readonly string[] } => {
    const found = index.resolve(name) ?? index.byPath.get(name);
    return found ?? { missing: name, near: search(index, { query: name, limit: 5 }).map((hit) => `${hit.title}  ${hit.path}`) };
};

const isNote = (value: ParsedNote | { missing: string }): value is ParsedNote => !("missing" in value);

const findVerb = (run: Run, index: KnowledgeIndex): number => {
    const hits = search(index, {
        query: run.args.positionals.join(" "),
        type: flag(run.args, "type"),
        tag: flag(run.args, "tag"),
        linkedTo: flag(run.args, "linked-to"),
        limit: number(run.args, "limit", 25),
    });
    if (hits.length === 0) {
        emit(run, { hits: [] }, "nothing in the knowledge base matches.");
        return 1;
    }
    emit(
        run,
        { hits },
        hits
            .map((hit) =>
                [
                    `${hit.path}`,
                    `  ${[hit.title, [hit.type, ...hit.tags.map((tag) => `#${tag}`)].filter(Boolean).join(" ")].filter(Boolean).join("  ·  ")}`,
                    hit.snippet === undefined ? undefined : `  ${hit.snippet}`,
                ]
                    .filter((line) => line !== undefined)
                    .join("\n"),
            )
            .join("\n"),
    );
    return 0;
};

const readVerb = (run: Run, index: KnowledgeIndex, withBody: boolean): number => {
    const name = run.args.positionals.join(" ");
    if (name === "") {
        emit(run, { error: "which note?" }, "which note? kb read <name>");
        return 2;
    }
    const found = findNote(index, name);
    if (!isNote(found)) {
        emit(
            run,
            found,
            [`no note named "${found.missing}".`, ...(found.near.length === 0 ? [] : ["closest:", ...found.near.map((line) => `  ${line}`)])].join(
                "\n",
            ),
        );
        return 1;
    }
    emit(run, noteJson(found, index), noteText(found, index, withBody));
    return 0;
};

const graphVerb = (run: Run, index: KnowledgeIndex): number => {
    const view = neighbourhood(index, run.args.positionals.join(" "), number(run.args, "depth", 2));
    if (view.focus === undefined) {
        emit(run, view, "no such note.");
        return 1;
    }
    const depth = number(run.args, "depth", 2);
    emit(
        run,
        view,
        [
            `${view.nodes.length} notes within ${depth} ${depth === 1 ? "step" : "steps"} of ${view.focus}`,
            "",
            "notes:",
            // Leading dots show how far out a note sits, so the neighbourhood's shape reads at a glance.
            ...view.nodes.map(
                (node) =>
                    `  ${node.depth === 0 ? "" : `${"·".repeat(node.depth)} `}${node.title}${node.type === undefined ? "" : `  (${node.type})`}  ${node.path}`,
            ),
            "",
            "connections:",
            ...view.edges.map((edge) => `  ${edge.from} —${edge.relation ?? "mentions"}→ ${edge.to}`),
            ...(view.omitted === 0 ? [] : ["", `  … ${view.omitted} more neighbours not shown`]),
        ].join("\n"),
    );
    return 0;
};

const brokenLine = (link: BrokenLink): string => `  ${link.from} → [[${link.target}]]${link.relation === undefined ? "" : ` (${link.relation})`}`;
const driftLine = (drift: Drift): string => `  ${drift.word}  ×${drift.uses}  ${drift.notes.join(" ")}`;

// One named block, or nothing when it's empty, so a clean knowledge base prints one line, not seven empty headings.
const section = (heading: string, lines: readonly string[]): string[] => (lines.length === 0 ? [] : ["", heading, ...lines]);

const checkVerb = (run: Run, index: KnowledgeIndex): number => {
    const report = overviewOf(index);
    const body = [
        ...section(`links to notes nobody has written (${report.broken.length}):`, report.broken.map(brokenLine)),
        ...section(
            `notes nothing links to and which link to nothing (${report.orphans.length}):`,
            report.orphans.map((path) => `  ${path}`),
        ),
        ...section(
            `notes with no type, invisible to every typed question (${report.untyped.length}):`,
            report.untyped.map((path) => `  ${path}`),
        ),
        ...section(`kinds the vocabulary has not adopted:`, report.typeDrift.map(driftLine)),
        ...section(`relationships the vocabulary has not adopted:`, report.relationDrift.map(driftLine)),
        ...section(
            `headers this reader could not parse:`,
            report.unreadable.map((entry) => `  ${entry.path}  ${entry.keys.join(", ")}`),
        ),
        ...section(
            `names that match more than one note:`,
            report.ambiguous.map((entry) => `  ${entry.name}  ${entry.notes.join(" ")}`),
        ),
    ];
    const tally = `${report.noteCount} notes, ${report.linkCount} links.`;
    emit(run, report, body.length === 0 ? `${tally} Nothing to fix.` : [tally, ...body].join("\n"));
    // Never a failure exit: drift and unwritten notes are the knowledge base's to-do list, not a broken build.
    return 0;
};

const vocabVerb = (run: Run, index: KnowledgeIndex): number => {
    const { vocabulary } = index;
    if (vocabulary.path === undefined) {
        emit(
            run,
            vocabulary,
            `this knowledge base has adopted no vocabulary yet, write ${VOCABULARY_PATH} with type: ${VOCABULARY_TYPE} to start one.`,
        );
        return 1;
    }
    const note = index.byPath.get(vocabulary.path);
    emit(
        run,
        vocabulary,
        [
            `${vocabulary.path}`,
            `kinds: ${vocabulary.types.join(", ")}`,
            `relationships: ${vocabulary.relations.join(", ")}`,
            "",
            (note?.body ?? "").trim(),
        ].join("\n"),
    );
    return 0;
};

// The verbs that write.

const newVerb = async (run: Run, index: KnowledgeIndex): Promise<number> => {
    const title = run.args.positionals.join(" ").trim();
    if (title === "") {
        emit(run, { error: "what is it called?" }, `what is it called? kb new "Ada Lovelace" --type person`);
        return 2;
    }
    const type = flag(run.args, "type");
    // Foldered by kind when given, flat otherwise; no pluralising, since a guessed plural is often wrong.
    const path = flag(run.args, "path") ?? `${type === undefined ? "" : `${type}/`}${slugify(title)}.md`;
    const existing = index.byPath.get(path);
    if (existing !== undefined) {
        emit(run, { error: "already there", path }, `${path} already exists, kb set, or pick another --path.`);
        return 2;
    }
    const fields = new Map<string, string[]>([
        ...(type === undefined ? [] : ([["type", [type]]] as [string, string[]][])),
        ["title", [title]],
        ...(flagAll(run.args, "tag").length === 0 ? [] : ([["tags", [...flagAll(run.args, "tag")]]] as [string, string[]][])),
        ...linkFields(flagAll(run.args, "link")),
    ]);
    const body = flag(run.args, "body") ?? "";
    if (!(await writeNote(run.root, path, formatFrontmatter(fields, body === "" ? "" : `${body}\n`)))) {
        emit(run, { error: "bad path", path }, `${path} is not a markdown file inside the knowledge base.`);
        return 2;
    }
    emit(run, { path, title, type }, `wrote ${path}`);
    return 0;
};

// Rewrites one header field in place; the body and every other field are untouched.
const writeField = async (run: Run, index: KnowledgeIndex, name: string, field: string, values: readonly string[]): Promise<number> => {
    const found = findNote(index, name);
    if (!isNote(found)) {
        emit(run, found, `no note named "${found.missing}".`);
        return 1;
    }
    const fields = new Map<string, readonly string[]>(found.fields);
    if (values.length === 0) {
        fields.delete(field);
    } else {
        fields.set(field, values);
    }
    if (!(await writeNote(run.root, found.path, formatFrontmatter(fields, found.body)))) {
        emit(run, { error: "bad path", path: found.path }, `${found.path} is not writable as a note.`);
        return 2;
    }
    emit(run, { path: found.path, field, values }, `${found.path}  ${field}: ${values.length === 0 ? "(cleared)" : values.join(", ")}`);
    return 0;
};

const setVerb = async (run: Run, index: KnowledgeIndex): Promise<number> => {
    const [name, field, ...values] = run.args.positionals;
    if (name === undefined || field === undefined) {
        emit(run, { error: "usage" }, `kb set <name> <field> [value…]`);
        return 2;
    }
    return writeField(run, index, name, field, values);
};

const linkVerb = async (run: Run, index: KnowledgeIndex): Promise<number> => {
    const [name, relation, ...targets] = run.args.positionals;
    if (name === undefined || relation === undefined || targets.length === 0) {
        emit(run, { error: "usage" }, `kb link <name> <relationship> <other note…>`);
        return 2;
    }
    const found = findNote(index, name);
    if (!isNote(found)) {
        emit(run, found, `no note named "${found.missing}".`);
        return 1;
    }
    // Added to what's already there, deduped; replacing outright is what `kb set` is for.
    const wanted = targets.map((target) => wikiLink(index.resolve(target)?.title ?? target));
    const merged = [...new Set([...(found.fields.get(relation) ?? []), ...wanted])];
    return writeField(run, index, found.path, relation, merged);
};

// Wiring.

const workspaceRoot = (): string => process.env["WORKSPACE_ROOT"] ?? "/work";

const main = async (): Promise<number> => {
    const args = parseArgs(process.argv.slice(2));
    if (args.verb === "" || args.verb === "help" || has(args, "help")) {
        out(USAGE);
        return args.verb === "" && !has(args, "help") ? 2 : 0;
    }
    const workspace = workspaceRoot();
    const root = knowledgeRoot(workspace, process.env["KB_FOLDER"] ?? (await configuredFolder(workspace)));
    const run: Run = { args, root, json: has(args, "json") };
    // `new` is the only verb that must work on a knowledge base with no notes yet.
    const files = await readNotes(root);
    if (files.length === 0 && args.verb !== "new") {
        emit(run, { folder: root, notes: 0 }, `no notes yet in ${root}, kb new "Something" --type term starts one.`);
        return 1;
    }
    const index = buildIndex(files);
    switch (args.verb) {
        case "find":
        case "search": {
            return findVerb(run, index);
        }
        case "list": {
            return findVerb({ ...run, args: { ...args, positionals: [] } }, index);
        }
        case "read":
        case "note": {
            return readVerb(run, index, true);
        }
        case "links": {
            return readVerb(run, index, false);
        }
        case "graph": {
            return graphVerb(run, index);
        }
        case "check": {
            return checkVerb(run, index);
        }
        case "vocab": {
            return vocabVerb(run, index);
        }
        case "new": {
            return newVerb(run, index);
        }
        case "set": {
            return setVerb(run, index);
        }
        case "link": {
            return linkVerb(run, index);
        }
        default: {
            out(`kb: no verb "${args.verb}".\n\n${USAGE}`);
            return 2;
        }
    }
};

// A crash still names the knowledge base and verb, and exits 2, distinct from 1 (found nothing).
main().then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        process.stderr.write(`kb: ${errorMessage(error)}\n`);
        process.exitCode = 2;
    },
);
