import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Grant, Grants } from "../grants.js";
import { askerOf, localServer } from "../testing.js";

// The explorer's four verbs over a real folder, driven as the editor sends them, with the app that trashes played by
// the test: what each does on disk, and every refusal a window is shown instead.

const FOLDER = `f`.repeat(64);
const DOCUMENT = `d`.repeat(64);
const READER = `r`.repeat(64);

let base: string;
let root: string;
// What the app was asked to trash, and what it answers.
let trashed: string[];
let answer: () => Promise<void>;
let ask: ReturnType<typeof askerOf>;
beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), `local-files-verbs-`)));
    root = join(base, `project`);
    mkdirSync(join(root, `docs`, `drafts`), { recursive: true });
    mkdirSync(join(root, `.git`));
    mkdirSync(join(base, `outside`));
    writeFileSync(join(root, `docs`, `a.md`), `# a`);
    writeFileSync(join(root, `docs`, `drafts`, `b.md`), `# b`);
    writeFileSync(join(root, `notes.txt`), `notes`);
    writeFileSync(join(root, `.git`, `HEAD`), `ref: refs/heads/main`);
    symlinkSync(`a.md`, join(root, `docs`, `a-link.md`));
    symlinkSync(join(base, `outside`), join(root, `out`));
    trashed = [];
    answer = async () => undefined;
    const grants = new Grants();
    const folder: Grant = { token: FOLDER, id: `w1`, root, name: `project` };
    grants.add(folder);
    grants.add({ token: DOCUMENT, id: `w2`, root, file: `notes.txt`, name: `notes.txt` });
    grants.add({ ...folder, token: READER, id: `w3`, readOnly: true });
    ask = askerOf(
        localServer(grants, {
            ask: async (verb, path) => {
                trashed.push(`${verb} ${path}`);
                await answer();
            },
        }),
    );
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

// A verb as the editor calls it, answered as status and body.
const call = async (method: string, route: string, body: Readonly<Record<string, string>>, token = FOLDER): Promise<[number, unknown]> => {
    const answered = await ask(route, { method, token, body: JSON.stringify(body), headers: { "content-type": `application/json` } });
    return [answered.status, await answered.json()];
};
const move = (from: string, to: string, token?: string) => call(`POST`, `/workspace/move`, { from, to }, token);
const copy = (from: string, to: string, token?: string) => call(`POST`, `/workspace/copy`, { from, to }, token);
const mkdir = (path: string, token?: string) => call(`POST`, `/workspace/dir`, { path }, token);
const remove = (path: string, token?: string) => call(`DELETE`, `/workspace/entry`, { path }, token);

describe(`a new folder`, () => {
    it(`is made with every missing folder above it, and one already there is the answer`, async () => {
        expect(await mkdir(`docs/new/deeper`)).toEqual([200, { ok: true }]);
        expect(lstatSync(join(root, `docs`, `new`, `deeper`)).isDirectory()).toBe(true);
        expect(await mkdir(`docs`)).toEqual([200, { ok: true }]);
    });

    it(`is refused where a file has the name`, async () => {
        expect(await mkdir(`notes.txt`)).toEqual([409, { error: `“notes.txt” already exists.` }]);
    });
});

describe(`a move`, () => {
    it(`renames, and moves into a folder it makes`, async () => {
        expect(await move(`notes.txt`, `todo.txt`)).toEqual([200, { ok: true }]);
        expect(await move(`docs/drafts`, `archive/2026/drafts`)).toEqual([200, { ok: true }]);
        expect([existsSync(join(root, `notes.txt`)), readFileSync(join(root, `todo.txt`), `utf8`)]).toEqual([false, `notes`]);
        expect(readFileSync(join(root, `archive`, `2026`, `drafts`, `b.md`), `utf8`)).toBe(`# b`);
    });

    // The link goes, not what it points at.
    it(`moves a link as the link`, async () => {
        expect(await move(`docs/a-link.md`, `docs/still-a-link.md`)).toEqual([200, { ok: true }]);
        expect(readlinkSync(join(root, `docs`, `still-a-link.md`))).toBe(`a.md`);
        expect(readFileSync(join(root, `docs`, `a.md`), `utf8`)).toBe(`# a`);
    });

    it(`never lands on a name that is taken, into itself, or from nothing`, async () => {
        expect(await move(`notes.txt`, `docs/a.md`)).toEqual([409, { error: `“a.md” already exists.` }]);
        expect(await move(`docs`, `docs/drafts/docs`)).toEqual([400, { error: `“docs” can't be moved into itself.` }]);
        expect(await move(`gone.txt`, `here.txt`)).toEqual([404, { error: `“gone.txt” isn't there.` }]);
        expect([readFileSync(join(root, `notes.txt`), `utf8`), readFileSync(join(root, `docs`, `a.md`), `utf8`)]).toEqual([`notes`, `# a`]);
    });
});

describe(`a copy`, () => {
    it(`copies a folder whole, its links as the links they are`, async () => {
        expect(await copy(`docs`, `docs-copy`)).toEqual([200, { ok: true }]);
        expect(readFileSync(join(root, `docs-copy`, `drafts`, `b.md`), `utf8`)).toBe(`# b`);
        expect(readlinkSync(join(root, `docs-copy`, `a-link.md`))).toBe(`a.md`);
        expect(readFileSync(join(root, `docs`, `a.md`), `utf8`)).toBe(`# a`);
    });

    it(`never writes over anything, nor into itself`, async () => {
        expect(await copy(`notes.txt`, `docs/a.md`)).toEqual([409, { error: `“a.md” already exists.` }]);
        expect(await copy(`docs`, `docs/drafts/again`)).toEqual([400, { error: `“docs” can't be copied into itself.` }]);
        expect(readFileSync(join(root, `docs`, `a.md`), `utf8`)).toBe(`# a`);
    });
});

describe(`a delete`, () => {
    // The system's trash, through the app, with the entry's own place on disk: nothing is erased here.
    it(`asks the app to move the entry to the trash, and answers with no trash id`, async () => {
        expect(await remove(`docs/drafts`)).toEqual([200, { ok: true }]);
        expect(await remove(`docs/a-link.md`)).toEqual([200, { ok: true }]);
        expect(trashed).toEqual([`trash ${join(root, `docs`, `drafts`)}`, `trash ${join(root, `docs`, `a-link.md`)}`]);
        expect(existsSync(join(root, `docs`, `drafts`, `b.md`))).toBe(true);
    });

    it(`answers nothing there as done, without asking`, async () => {
        expect(await remove(`gone.txt`)).toEqual([200, { ok: true }]);
        expect(trashed).toEqual([]);
    });

    // An app that could not, or never answered (one from before the trash), leaves the entry where it was.
    it(`refuses with the app's words when the app could not, and removes nothing itself`, async () => {
        answer = async () => {
            throw new Error(`The Recycle Bin is turned off for this drive.`);
        };
        expect(await remove(`notes.txt`)).toEqual([503, { error: `The Recycle Bin is turned off for this drive.` }]);
        expect(readFileSync(join(root, `notes.txt`), `utf8`)).toBe(`notes`);
    });
});

describe(`what no window may change`, () => {
    it(`refuses all four in a document's own window`, async () => {
        const refused: [number, unknown] = [403, { error: `A document opened on its own can't change its folder.` }];
        expect(await mkdir(`new`, DOCUMENT)).toEqual(refused);
        expect(await move(`notes.txt`, `renamed.txt`, DOCUMENT)).toEqual(refused);
        expect(await copy(`notes.txt`, `copied.txt`, DOCUMENT)).toEqual(refused);
        expect(await remove(`notes.txt`, DOCUMENT)).toEqual(refused);
        expect(trashed).toEqual([]);
    });

    it(`refuses all four in a read-only window`, async () => {
        const refused: [number, unknown] = [403, { error: `This window was opened read-only.` }];
        expect(
            await Promise.all([
                mkdir(`new`, READER),
                move(`notes.txt`, `x.txt`, READER),
                copy(`notes.txt`, `y.txt`, READER),
                remove(`notes.txt`, READER),
            ]),
        ).toEqual([refused, refused, refused, refused]);
    });

    it(`refuses the folder itself, a version history, and Intentic's own records`, async () => {
        expect(await remove(`.`)).toEqual([403, { error: `That's the folder this window opened; it can't be changed from here.` }]);
        expect(await remove(`.git`)).toEqual([403, { error: `“.git” is kept by Git or Intentic, so it can't be changed here.` }]);
        expect(await move(`notes.txt`, `.git/notes.txt`)).toEqual([
            403,
            { error: `“.git” is kept by Git or Intentic, so it can't be changed here.` },
        ]);
        expect(await mkdir(`sub/.intentic/config`)).toEqual([403, { error: `“.intentic” is kept by Git or Intentic, so it can't be changed here.` }]);
        expect(existsSync(join(root, `.git`, `HEAD`))).toBe(true);
    });

    // Nothing outside the folder, by spelling or through a link that leads out.
    it(`refuses a path that leaves the folder`, async () => {
        expect(await move(`notes.txt`, `../outside/notes.txt`)).toEqual([400, { error: `invalid path` }]);
        expect(await move(`notes.txt`, `out/notes.txt`)).toEqual([400, { error: `outside this folder` }]);
        expect(await copy(`docs`, `out/docs`)).toEqual([400, { error: `outside this folder` }]);
        expect(await mkdir(`out/made`)).toEqual([400, { error: `outside this folder` }]);
        expect(await remove(`out/anything`)).toEqual([400, { error: `outside this folder` }]);
        expect(existsSync(join(base, `outside`, `notes.txt`))).toBe(false);
        expect(trashed).toEqual([]);
    });
});
