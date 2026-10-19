// Writes soft-deletes.json: the web demo's longest conversation (cnv_soft_deletes), the one the phone and long-chat
// labs inflate, reduced to what a transcript row draws. Every arm of the spike reads this file and inflates it the
// same way _tools/perf does (inflate rule in ../README.md), so all of them draw the same text.
//
//   cd _site/demo && bun --conditions=@intentic/src ../../_editor/android-native/fixture/make-fixture.ts
import { writeFileSync } from "node:fs";

// The demo reads its mode off the page address and session storage when it loads; give it an empty page.
const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
Object.assign(globalThis, {
    window: { location: { href: `http://demo.invalid/` }, sessionStorage: storage, localStorage: storage, history: { state: null, replaceState: () => undefined } },
    sessionStorage: storage,
    localStorage: storage,
});
const { REVIEW_AGENT_ID } = await import("../../../_site/demo/src/fixture/fleet.ts");
const { transcriptFor } = await import("../../../_site/demo/src/fixture/transcripts.ts");

interface Row {
    readonly role: string;
    readonly text: string;
    readonly tools: readonly { readonly name: string; readonly summary: string }[];
}

const rows: Row[] = transcriptFor(REVIEW_AGENT_ID).messages.map((row) => ({
    role: row.role,
    text: row.text ?? ``,
    tools: (row.tools ?? []).map((tool) => ({ name: tool.name, summary: tool.input === undefined ? `` : JSON.stringify(tool.input).slice(0, 160) })),
}));
// What _tools/perf/src/mobile/page-scripts.ts (inflateTranscript) appends to every assistant answer of an even copy:
// a list, a table and a TypeScript block, so the long chat carries markdown worth parsing. `{index}` is the copy.
const addition = [
    ``,
    `What changed in step {index}:`,
    ``,
    "- The `users` table gains `deleted_at`, nullable.",
    "- Every read goes through `liveUsers()`.",
    ``,
    `| file | change |`,
    `| --- | --- |`,
    `| schema.ts | +3 |`,
    ``,
    "```ts",
    `export const liveUsers = () => db.select().from(users).where(isNull(users.deletedAt));`,
    `export const retire = async (id: string) => {`,
    `    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));`,
    `};`,
    "```",
    ``,
].join(`\n`);

// The turn _tools/perf/src/chat/stream.ts streams under a long chat: a new answer row grows by `chunk` characters of
// `prose` every `everyMs`, then each of `tools` runs (`toolMs` in progress, `gapMs` after), and the next answer starts.
const stream = {
    prose: [
        `Reading the handler first, since the route and the job have to agree on what a deleted user is.`,
        ``,
        "- `liveUsers()` now filters on `deleted_at`, so every read path skips a retired row.",
        "- The purge job takes rows older than **30 days** and removes them for good.",
        ``,
        "```ts",
        `export const purge = (before: Date) => db.delete(users).where(lt(users.deletedAt, before));`,
        "```",
        ``,
        `Next I run the tests for the users module, then the migration against a copy of the schema.`,
    ].join(`\n`),
    chunk: 24,
    everyMs: 16,
    tools: [`Read`, `Bash`],
    toolMs: 50,
    gapMs: 30,
};

writeFileSync(new URL(`soft-deletes.json`, import.meta.url), `${JSON.stringify({ conversation: REVIEW_AGENT_ID, addition, stream, rows }, null, 2)}\n`);
process.stdout.write(`${rows.length} rows\n`);
