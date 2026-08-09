import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configuredVault, DEFAULT_VAULT, deleteNote, indexVault, readVault, resolveNote, vaultRoot, writeNote } from "./read-vault.js";

let workspace: string;
let root: string;

const put = async (path: string, content: string): Promise<void> => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
};

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "kb-"));
    root = join(workspace, DEFAULT_VAULT);
    await mkdir(root, { recursive: true });
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe(`vaultRoot`, () => {
    it(`uses the default folder when nothing is configured`, () => {
        expect(vaultRoot(`/work`, undefined)).toBe(`/work/knowledge`);
        expect(vaultRoot(`/work`, ``)).toBe(`/work/knowledge`);
    });

    it(`follows the owner's folder when one is set`, () => {
        expect(vaultRoot(`/work`, `my-notes`)).toBe(`/work/my-notes`);
        expect(vaultRoot(`/work`, `vaults/second-brain`)).toBe(`/work/vaults/second-brain`);
    });

    // A setting is owner-edited text; it must never be able to aim the vault outside the workspace.
    it(`refuses a setting that would leave the workspace`, () => {
        expect(vaultRoot(`/work`, `../etc`)).toBe(`/work/knowledge`);
        expect(vaultRoot(`/work`, `/etc`)).toBe(`/work/knowledge`);
    });
});

describe(`configuredVault`, () => {
    it(`reads the folder the owner chose`, async () => {
        await mkdir(join(workspace, `.intentic`), { recursive: true });
        await writeFile(join(workspace, `.intentic/extension-settings.json`), JSON.stringify({ "intentic.knowledge": { vault: `my-notes` } }));
        expect(await configuredVault(workspace)).toBe(`my-notes`);
    });

    it(`is silent when nothing has ever been set, rather than an error path`, async () => {
        expect(await configuredVault(workspace)).toBeUndefined();
        await mkdir(join(workspace, `.intentic`), { recursive: true });
        await writeFile(join(workspace, `.intentic/extension-settings.json`), `{ not json`);
        expect(await configuredVault(workspace)).toBeUndefined();
    });
});

describe(`readVault`, () => {
    it(`reads every markdown note, at any depth, with paths relative to the vault`, async () => {
        await put(`_vocabulary.md`, `---\ntype: vocabulary\n---\n`);
        await put(`person/ada-lovelace.md`, `---\ntype: person\n---\n`);
        await put(`decision/deep/nested.md`, `---\ntype: decision\n---\n`);
        expect((await readVault(root)).map((file) => file.path).toSorted()).toEqual([
            `_vocabulary.md`,
            `decision/deep/nested.md`,
            `person/ada-lovelace.md`,
        ]);
    });

    it(`ignores everything that is not a note`, async () => {
        await put(`ada.md`, `---\ntype: person\n---\n`);
        await put(`picture.png`, `not markdown`);
        await put(`notes.txt`, `not markdown`);
        expect((await readVault(root)).map((file) => file.path)).toEqual([`ada.md`]);
    });

    /* A vault synced from Obsidian carries the editor's own state, and one kept in git carries a checkout.
     * Neither is knowledge, and reading them would put hundreds of non-notes in the panel's list. */
    it(`walks past the editor's own folders and a checkout`, async () => {
        await put(`ada.md`, `---\ntype: person\n---\n`);
        await put(`.obsidian/workspace.md`, `# layout`);
        await put(`.git/COMMIT_EDITMSG.md`, `# msg`);
        await put(`node_modules/pkg/readme.md`, `# dep`);
        expect((await readVault(root)).map((file) => file.path)).toEqual([`ada.md`]);
    });

    it(`reads a vault that does not exist yet as empty, which is every vault's first state`, async () => {
        expect(await readVault(join(workspace, `nowhere`))).toEqual([]);
    });
});

describe(`resolveNote`, () => {
    it(`refuses a path that leaves the vault, and anything that is not markdown`, () => {
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

    it(`refuses to write outside the vault or as anything but a note`, async () => {
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

describe(`indexVault`, () => {
    it(`reads the folder and resolves it into a graph in one step`, async () => {
        await put(`person/ada.md`, `---\ntype: person\ntitle: Ada Lovelace\nworks_on: ["[[Intentic]]"]\n---\n`);
        await put(`project/intentic.md`, `---\ntype: project\ntitle: Intentic\n---\n`);
        const index = await indexVault(root);
        expect(index.resolve(`Ada Lovelace`)?.path).toBe(`person/ada.md`);
        expect(index.backlinks.get(`project/intentic.md`)?.map((edge) => edge.relation)).toEqual([`works_on`]);
    });
});
