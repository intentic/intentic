import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExisting, resolveWritable } from "./paths.js";

// A folder with a document, a subfolder, a link that stays inside and two that lead out (one to a file, one to a
// folder), beside a sibling folder the links point into.
let base: string;
let root: string;
beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), `local-files-paths-`)));
    root = join(base, `project`);
    mkdirSync(join(root, `docs`), { recursive: true });
    mkdirSync(join(base, `secrets`));
    writeFileSync(join(root, `docs`, `a.md`), `# a`);
    writeFileSync(join(base, `secrets`, `key.txt`), `secret`);
    symlinkSync(join(root, `docs`, `a.md`), join(root, `inside.md`));
    symlinkSync(join(base, `secrets`, `key.txt`), join(root, `key.txt`));
    symlinkSync(join(base, `secrets`), join(root, `secrets`));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe(`resolveExisting`, () => {
    it(`finds a file, and a link that stays inside as what it points at`, async () => {
        expect(await resolveExisting(root, `docs/a.md`)).toEqual({ kind: `found`, abs: join(root, `docs`, `a.md`) });
        expect(await resolveExisting(root, `inside.md`)).toEqual({ kind: `found`, abs: join(root, `docs`, `a.md`) });
    });

    it(`says missing for nothing there, and refuses what leads out by a link or by spelling`, async () => {
        expect(await resolveExisting(root, `docs/b.md`)).toEqual({ kind: `missing` });
        expect(await resolveExisting(root, `key.txt`)).toEqual({ kind: `refused`, why: `outside this folder` });
        expect(await resolveExisting(root, `secrets/key.txt`)).toEqual({ kind: `refused`, why: `outside this folder` });
        expect(await resolveExisting(root, `../secrets/key.txt`)).toEqual({ kind: `refused`, why: `invalid path` });
    });
});

describe(`resolveWritable`, () => {
    it(`lands a new file under an existing folder inside, and an existing one where it really is`, async () => {
        expect(await resolveWritable(root, `docs/new/b.md`)).toEqual({ kind: `found`, abs: join(root, `docs`, `new`, `b.md`) });
        expect(await resolveWritable(root, `inside.md`)).toEqual({ kind: `found`, abs: join(root, `docs`, `a.md`) });
    });

    // The write that matters most to refuse: a new file under a linked folder that leads out of the root.
    it(`refuses a write through a link out, whether the file exists yet or not`, async () => {
        expect(await resolveWritable(root, `key.txt`)).toEqual({ kind: `refused`, why: `outside this folder` });
        expect(await resolveWritable(root, `secrets/new.txt`)).toEqual({ kind: `refused`, why: `outside this folder` });
        expect(await resolveWritable(root, ``)).toEqual({ kind: `refused`, why: `invalid path` });
    });
});
