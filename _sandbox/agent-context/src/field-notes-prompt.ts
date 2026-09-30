// The brief handed to whatever rewrites a field-notes file: the sandbox's monthly automation and the Claude Code plugin's
// /intentic:field-notes alike. It lives beside the reader (field-notes.ts) because the shape it asks for is the shape
// that reader slices by rank; a writer told anything else produces a file the reader refuses. Only the place differs
// between runtimes: what it is called, where its sessions are kept, and what reads the file back.

export interface FieldNotesPlace {
    // Whose notes, as a possessive: "this sandbox's", "this project's".
    readonly owner: string;
    // The place itself, as a noun phrase: "this sandbox", "this project".
    readonly place: string;
    // The file to rewrite, as the writer should name it.
    readonly file: string;
    // What composes the file into sessions: "the daemon", "the plugin".
    readonly reader: string;
    // Where the session corpus is and how to read it back; a paragraph of its own.
    readonly evidence: string;
    // How much history one rewrite covers: "this month's", "the latest".
    readonly period: string;
    // A span that turned up nothing new: "a month's sessions", "the sessions since the last rewrite".
    readonly quietSpan: string;
}

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const COUNTS_NOT_IMPRESSIONS =
    `Work from counts, not impressions: how MANY sessions hit a thing is what decides its rank, and one bad afternoon is ` +
    `not a standing problem.`;

export const fieldNotesPrompt = (at: FieldNotesPlace): string =>
    `Rewrite ${at.owner} field notes: \`${at.file}\`, the brief every turn opens with.\n\n` +
    `It exists because the project map cannot carry this. The map is recomputed from the TREE each conversation, so it ` +
    `already says what a scan can see — which directories exist, what each is for. Yours is the other half, drawn from ` +
    `what has actually HAPPENED here: which commands really verify in this workspace and which lie about their exit ` +
    `code, what the machine can take, where sessions lost calls to a trap the code does not mention, and how the owner ` +
    `asks for things. If a fact could be found by reading the repository, it belongs in the map and not in your file.\n\n` +
    `${at.evidence} ${COUNTS_NOT_IMPRESSIONS}\n\n` +
    `Rank by what it costs a turn NOT to know: how often sessions hit it, how much it costs when they do, and whether ` +
    `they could have found it out cheaply themselves. Rank 1 is the costliest gap. Rank on recent sessions only, and ` +
    `recount every percentage from them rather than carrying the old one forward: a trap sessions stopped hitting, because ` +
    `the code or the environment has since fixed it, drops down or out however costly it once was.\n\n` +
    `SIZE IS PART OF THE RANKING. ${capitalized(at.reader)} sends the priority table on every turn, then whole sections in rank order ` +
    `until the owner's budget runs out (4,000 characters by default, the table included), and stops at the first section ` +
    `that does not fit, so one long section silences every rank below it. Keep the table's cells to a few words, keep ` +
    `each section under about 700 characters, and split anything longer into two ranks. Leave out what every turn is ` +
    `already told elsewhere (the system prompt's working rules, the skills it lists, the search teaching): repeating it ` +
    `spends the budget twice.\n\n` +
    `VERIFY EVERY FACT AGAINST ${at.place.toUpperCase()} BEFORE YOU WRITE IT DOWN. A transcript from six weeks ago is a ` +
    `hypothesis: run the command, list the directory, check the port. A brief that is confidently wrong is worse than no ` +
    `brief, because every turn reads it and none of them will doubt it.\n\n` +
    `The file is TOON. Keep its shape, because ${at.reader} reads it by rank and sends as much as the owner's budget ` +
    `allows: a \`meta\` block, a \`priority\` table whose columns begin \`rank,id\` and whose every id is also a ` +
    `top-level key in the file, then one block per id. Ranks are integers and ids are kebab-case words.\n\n` +
    `This is a REWRITE, not a fresh start. Read the existing file first: carry forward what still holds, drop what ` +
    `${at.place.replace(/^this /, "the ")} has outgrown, re-rank on ${at.period} evidence. Finish with a short note ` +
    `saying what changed rank and why, what you added, and what you removed as no longer true — the next one of these ` +
    `should not have to rediscover your reasoning. If ${at.quietSpan} genuinely showed nothing worth changing, say so in ` +
    `one line and leave the file alone: a rewrite that says the same thing in new words costs the measurement its ` +
    `baseline for nothing.`;
