import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SystemEvent, SystemEventSchema } from "@intentic/sandbox-contract";
import { DerivedTexts } from "../derived.js";
import { Grants } from "../grants.js";
import { askerOf, docxOf, localServer, xlsxOf } from "../testing.js";

// A document's text for the quick look, rendered by fileq's own readers over real files: kept in the app's cache and
// never beside the document, read back without rendering, and rendered again once the file changes.

let base: string;
let root: string;
let cache: string;
let derived: DerivedTexts;
beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), `local-files-derived-`)));
    root = join(base, `project`);
    cache = join(base, `cache`, `derived`);
    mkdirSync(root);
    for (const [name, bytes] of Object.entries({
        "plan.docx": docxOf(`Quarterly plan`, [`Ship the viewer.`]),
        "budget.xlsx": xlsxOf(`Budget`, [
            [`Item`, `Cost`],
            [`Paper`, `12`],
        ]),
        "notes.txt": new TextEncoder().encode(`plain text\n`),
    })) {
        writeFileSync(join(root, name), bytes);
    }
    derived = new DerivedTexts({ dir: cache, log: () => undefined });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe(`a document's text`, () => {
    it(`is absent until asked for, then kept where the app keeps its cache and read back from there`, async () => {
        expect(await derived.read(root, `plan.docx`)).toEqual({ present: false, path: `plan.docx`, derivable: true, state: `idle` });
        const rendered = await derived.derive(root, `plan.docx`);
        expect(rendered).toEqual({
            present: true,
            path: `plan.docx`,
            content: expect.stringContaining(`# Quarterly plan\n\nShip the viewer.`),
            state: `idle`,
            deriver: expect.stringMatching(/^docx v\d+$/),
            derivedAt: expect.any(String),
            notes: expect.any(Array),
            tokens: expect.any(Number),
            truncated: false,
            stale: false,
        });
        expect(await derived.read(root, `plan.docx`)).toEqual(rendered);
        expect(readdirSync(cache)).toEqual([expect.stringMatching(/^[0-9a-f]{40}\.json$/)]);
    });

    it(`renders a spreadsheet's sheets as tables`, async () => {
        expect(await derived.derive(root, `budget.xlsx`)).toMatchObject({
            present: true,
            content: `## Budget\n\n| Item | Cost |\n| --- | --- |\n| Paper | 12 |`,
        });
    });

    // Nothing is written into the folder being read: no shadow, no scratch file.
    it(`writes nothing into the folder it reads`, async () => {
        const before = readdirSync(root).toSorted();
        await derived.derive(root, `plan.docx`);
        await derived.derive(root, `budget.xlsx`);
        expect(readdirSync(root).toSorted()).toEqual(before);
    });

    // Keyed by the file's version: a document edited since is not answered with its old text.
    it(`is absent again once the file changes`, async () => {
        await derived.derive(root, `plan.docx`);
        writeFileSync(join(root, `plan.docx`), docxOf(`Revised plan`, [`Ship it later.`]));
        utimesSync(join(root, `plan.docx`), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
        expect(await derived.read(root, `plan.docx`)).toMatchObject({ present: false, derivable: true, state: `idle` });
        expect(await derived.derive(root, `plan.docx`)).toMatchObject({ present: true, content: expect.stringContaining(`# Revised plan`) });
    });

    it(`says when nothing reads the file, or nothing is there`, async () => {
        expect(await derived.read(root, `notes.txt`)).toEqual({ present: false, path: `notes.txt`, derivable: false, state: `undeliverable` });
        expect(await derived.derive(root, `notes.txt`)).toEqual({
            present: false,
            path: `notes.txt`,
            derivable: false,
            state: `undeliverable`,
            reason: `Nothing here reads this kind of file.`,
        });
        expect(await derived.derive(root, `gone.docx`)).toMatchObject({
            present: false,
            derivable: false,
            reason: `There is no file there to read.`,
        });
    });
});

describe(`over the window's routes`, () => {
    // A document opened on its own reads the folder it is in, and so may ask for the text of what is beside it.
    it(`renders a document beside the one a window opened, and refuses a path out of the folder`, async () => {
        const grants = new Grants();
        const token = `d`.repeat(64);
        grants.add({ token, id: `w1`, root, file: `plan.docx`, name: `plan.docx` });
        const ask = askerOf(localServer(grants, { derived }));
        const post = (path: string): Promise<Response> =>
            ask(`/workspace/derive`, { method: `POST`, token, body: JSON.stringify({ path }), headers: { "content-type": `application/json` } });
        expect(await (await post(`budget.xlsx`)).json()).toMatchObject({ present: true, path: `budget.xlsx` });
        expect(await (await ask(`/workspace/derived?path=budget.xlsx`, { token })).json()).toMatchObject({ present: true, path: `budget.xlsx` });
        const out = await post(`../elsewhere.docx`);
        expect([out.status, await out.json()]).toEqual([400, { error: `invalid path` }]);
    });

    // A pane that read `deriving` has nothing else to wake it: the text lands in the app's cache, which no watch sees.
    // So a rendering that ends is said on every window's event stream that can see the file, as a daemon says it.
    it(`says on the window's event stream when a document's text lands`, async () => {
        const grants = new Grants();
        const token = `e`.repeat(64);
        grants.add({ token, id: `w2`, root, name: `project` });
        const ask = askerOf(localServer(grants, { derived }));
        const stop = new AbortController();
        const stream = await ask(`/events`, { token, signal: stop.signal });
        const frames = framesOf(stream);
        expect((await frames.next()).value).toMatchObject({ kind: `hello` });
        await ask(`/workspace/derive`, {
            method: `POST`,
            token,
            body: JSON.stringify({ path: `plan.docx` }),
            headers: { "content-type": `application/json` },
        });
        expect((await frames.next()).value).toEqual({ kind: `derivedChanged`, paths: [`plan.docx`] });
        stop.abort();
    });
});

// The stream's frames as they arrive, each one read as the contract's event; heartbeats are passed over.
async function* framesOf(response: Response): AsyncGenerator<SystemEvent> {
    if (response.body === null) {
        throw new Error(`the event stream answered without a body`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = ``;
    try {
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
            text += decoder.decode(read.value, { stream: true });
            for (let end = text.indexOf(`\n\n`); end !== -1; end = text.indexOf(`\n\n`)) {
                const data = /^data: (.*)$/m.exec(text.slice(0, end))?.[1];
                text = text.slice(end + 2);
                const frame = data === undefined ? undefined : SystemEventSchema.parse(JSON.parse(data));
                if (frame !== undefined && frame.kind !== `heartbeat`) {
                    yield frame;
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
