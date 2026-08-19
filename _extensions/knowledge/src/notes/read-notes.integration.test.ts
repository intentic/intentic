import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configuredFolder, DEFAULT_FOLDER, deleteNote, indexNotes, readNotes, resolveNote, knowledgeRoot, writeNote } from "./read-notes.js";

let workspace: string;
let root: string;

const put = async (path: string, content: string): Promise<void> => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
};

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "kb-"));
    root = join(workspace, DEFAULT_FOLDER);
    await mkdir(root, { recursive: true });
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe(`knowledgeRoot`, () => {
    it(`uses the default folder when nothing is configured`, () => {
        expect(knowledgeRoot(`/work`, undefined)).toBe(`/work/knowledge`);
        expect(knowledgeRoot(`/work`, ``)).toBe(`/work/knowledge`);
    });

    it(`follows the owner's folder when one is set`, () => {
        expect(knowledgeRoot(`/work`, `my-notes`)).toBe(`/work/my-notes`);
        expect(knowledgeRoot(`/work`, `notes/second-brain`)).toBe(`/work/notes/second-brain`);
    });

    // A setting is owner-edited text; it must never be able to aim the knowledge base outside the workspace.
    it(`refuses a setting that would leave the workspace`, () => {
        expect(knowledgeRoot(`/work`, `../etc`)).toBe(`/work/knowledge`);
        expect(knowledgeRoot(`/work`, `/etc`)).toBe(`/work/knowledge`);
    });
});

describe(`configuredFolder`, () => {
    it(`reads the folder the owner chose`, async () => {
        await mkdir(join(workspace, `.intentic/config`), { recursive: true });
        await writeFile(
            join(workspace, `.intentic/config/extension-settings.json`),
            JSON.stringify({ "intentic.knowledge": { folder: `my-notes` } }),
        );
        expect(await configuredFolder(workspace)).toBe(`my-notes`);
    });

    it(`is silent when nothing has ever been set, rather than an error path`, async () => {
        expect(await configuredFolder(workspace)).toBeUndefined();
        await mkdir(join(workspace, `.intentic/config`), { recursive: true });
        await writeFile(join(workspace, `.intentic/config/extension-settings.json`), `{ not json`);
        expect(await configuredFolder(workspace)).toBeUndefined();
    });
});

describe(`readNotes`, () => {
    it(`reads every markdown note, at any depth, with paths relative to the knowledge base`, async () => {
        await put(`_vocabulary.md`, `---\ntype: vocabulary\n---\n`);
        await put(`person/ada-lovelace.md`, `---\ntype: person\n---\n`);
        await put(`decision/deep/nested.md`, `---\ntype: decision\n---\n`);
        expect((await readNotes(root)).map((file) => file.path).toSorted()).toEqual([
            `_vocabulary.md`,
            `decision/deep/nested.md`,
            `person/ada-lovelace.md`,
        ]);
    });

    it(`ignores everything that is not a note`, async () => {
        await put(`ada.md`, `---\ntype: person\n---\n`);
        await put(`picture.png`, `not markdown`);
        await put(`notes.txt`, `not markdown`);
        expect((await readNotes(root)).map((file) => file.path)).toEqual([`ada.md`]);
    });

    /* A knowledge base synced from Obsidian carries the editor's own state, and one kept in git carries a checkout.
     * Neither is knowledge, and reading them would put hundreds of non-notes in the panel's list. */
    it(`walks past the editor's own folders and a checkout`, async () => {
        await put(`ada.md`, `---\ntype: person\n---\n`);
        await put(`.obsidian/workspace.md`, `# layout`);
        await put(`.git/COMMIT_EDITMSG.md`, `# msg`);
        await put(`node_modules/pkg/readme.md`, `# dep`);
        expect((await readNotes(root)).map((file) => file.path)).toEqual([`ada.md`]);
    });

    it(`reads a knowledge base that does not exist yet as empty, which is every knowledge base's first state`, async () => {
        expect(await readNotes(join(workspace, `nowhere`))).toEqual([]);
    });
});

describe(`resolveNote`, () => {
    it(`refuses a path that leaves the knowledge base, and anything that is not markdown`, () => {
        expect(resolveNote(root, `../escape.md`)).toBeUndefined();
        expect(resolveNote(root, `/etc/passwd.md`)).toBeUndefined();
        expect(resolveNote(root, `ada.txt`)).toBeUndefined();
        expect(resolveNote(root, `person/ada.md`)).toBe(join(root, `person/ada.md`));
    });
});

describe(`writeNote and deleteNote`, () => {
    it(`creates the folders a new note needs`, async () => {
        expect(await writeNote(root, `person/ada.md`, `---\ntype: person\n---\nHello.`)).toBe(true);
        expect(await readFile(join(root, `person/ada.md`), `utf8`)).toContain(`Hello.`);
    });

    it(`refuses to write outside the knowledge base or as anything but a note`, async () => {
        expect(await writeNote(root, `../escaped.md`, `x`)).toBe(false);
        expect(await writeNote(root, `run.sh`, `x`)).toBe(false);
    });

    it(`deletes a note, and answers false for one that was never there`, async () => {
        await put(`ada.md`, `---\ntype: person\n---\n`);
        expect(await deleteNote(root, `ada.md`)).toBe(true);
        expect(await deleteNote(root, `ada.md`)).toBe(false);
        expect(await deleteNote(root, `../escaped.md`)).toBe(false);
    });
});

describe(`indexNotes`, () => {
    it(`reads the folder and resolves it into a graph in one step`, async () => {
        await put(`person/ada.md`, `---\ntype: person\ntitle: Ada Lovelace\nworks_on: ["[[Intentic]]"]\n---\n`);
        await put(`project/intentic.md`, `---\ntype: project\ntitle: Intentic\n---\n`);
        const index = await indexNotes(root);
        expect(index.resolve(`Ada Lovelace`)?.path).toBe(`person/ada.md`);
        expect(index.backlinks.get(`project/intentic.md`)?.map((edge) => edge.relation)).toEqual([`works_on`]);
    });
});
