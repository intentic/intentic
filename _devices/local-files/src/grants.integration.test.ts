import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantFor, Grants, mayWrite } from "./grants.js";

const TOKEN = `a`.repeat(64);
let base: string;
beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), `local-files-grants-`)));
    mkdirSync(join(base, `project`));
    mkdirSync(join(base, `elsewhere`));
    writeFileSync(join(base, `elsewhere`, `brief.docx`), `x`);
    symlinkSync(join(base, `elsewhere`, `brief.docx`), join(base, `project`, `shortcut.docx`));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe(`grantFor`, () => {
    it(`serves a folder as itself, writable throughout`, async () => {
        const grant = await grantFor({ token: TOKEN, id: `w1`, path: join(base, `project`), kind: `folder` });
        expect(grant).toEqual({ token: TOKEN, id: `w1`, root: join(base, `project`), name: `project` });
        expect(`error` in grant ? undefined : mayWrite(grant, `docs/a.md`)).toBe(true);
    });

    // A shortcut on the desktop to a document elsewhere serves the folder the document is really in.
    it(`serves a document from the folder it really is in, and lets only it be written`, async () => {
        const grant = await grantFor({ token: TOKEN, id: `w2`, path: join(base, `project`, `shortcut.docx`), kind: `file` });
        expect(grant).toEqual({ token: TOKEN, id: `w2`, root: join(base, `elsewhere`), file: `brief.docx`, name: `brief.docx` });
        expect(`error` in grant ? undefined : [mayWrite(grant, `brief.docx`), mayWrite(grant, `other.docx`)]).toEqual([true, false]);
    });

    it(`refuses a path that is not there or not the kind asked for`, async () => {
        expect(await grantFor({ token: TOKEN, id: `w3`, path: join(base, `missing`), kind: `folder` })).toEqual({ error: `${join(base, `missing`)} is not there` });
        expect(await grantFor({ token: TOKEN, id: `w3`, path: join(base, `project`), kind: `file` })).toEqual({ error: `${join(base, `project`)} is not a file` });
    });
});

describe(`Grants`, () => {
    it(`finds a grant by its token until it is revoked`, async () => {
        const grants = new Grants();
        const grant = await grantFor({ token: TOKEN, id: `w1`, path: join(base, `project`), kind: `folder` });
        if (`error` in grant) {
            throw new Error(grant.error);
        }
        grants.add(grant);
        expect(grants.byToken(TOKEN)).toBe(grant);
        expect(grants.revoke(TOKEN)).toBe(grant);
        expect(grants.byToken(TOKEN)).toBeUndefined();
    });
});
