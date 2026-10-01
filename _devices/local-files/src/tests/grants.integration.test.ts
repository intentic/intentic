import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Grant, grantFor, Grants, isHandoff, mayWrite } from "../grants.js";

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

    // Each limit is on the grant only when the app asked for it, so a grant without any reads as it always did.
    it(`carries the limits the app asked for: read-only, the pages it is handed to, and when it ends`, async () => {
        const handed = await grantFor(
            {
                token: TOKEN,
                id: `w4`,
                path: join(base, `elsewhere`, `brief.docx`),
                kind: `file`,
                readOnly: true,
                origins: [`https://app.intentic.dev`],
                expiresInMs: 5_000,
            },
            1_000,
        );
        expect(handed).toEqual({
            token: TOKEN,
            id: `w4`,
            root: join(base, `elsewhere`),
            file: `brief.docx`,
            name: `brief.docx`,
            readOnly: true,
            origins: [`https://app.intentic.dev`],
            expiresAt: 6_000,
        });
        expect(`error` in handed ? undefined : [isHandoff(handed), mayWrite(handed, `brief.docx`)]).toEqual([true, false]);
    });

    // A handoff is one document's bytes for another site; a folder is never handed over.
    it(`refuses to hand a folder to other pages`, async () => {
        expect(
            await grantFor({ token: TOKEN, id: `w5`, path: join(base, `project`), kind: `folder`, origins: [`https://app.intentic.dev`] }),
        ).toEqual({
            error: `a grant for other pages hands over one document, not a folder`,
        });
    });

    it(`refuses a path that is not there or not the kind asked for`, async () => {
        expect(await grantFor({ token: TOKEN, id: `w3`, path: join(base, `missing`), kind: `folder` })).toEqual({
            error: `${join(base, `missing`)} is not there`,
        });
        expect(await grantFor({ token: TOKEN, id: `w3`, path: join(base, `project`), kind: `file` })).toEqual({
            error: `${join(base, `project`)} is not a file`,
        });
    });
});

describe(`mayWrite`, () => {
    const folder: Grant = { token: TOKEN, id: `w1`, root: `/home/me/project`, name: `project` };
    it(`lets nothing be written through a read-only or a handed-over grant`, () => {
        expect(mayWrite(folder, `a.md`)).toBe(true);
        expect(mayWrite({ ...folder, readOnly: true }, `a.md`)).toBe(false);
        expect(mayWrite({ ...folder, file: `a.md`, origins: [`https://app.intentic.dev`] }, `a.md`)).toBe(false);
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

    // Dropped the first time anything asks after its end, so the token answers as one never granted, and whoever
    // lets go of what it held hears it end, once.
    it(`ends a grant at its end, tells its listener once, and lists only live handoffs' origins`, () => {
        let now = 0;
        const grants = new Grants(() => now);
        const ended: string[] = [];
        grants.onExpired((grant) => ended.push(grant.id));
        const handed: Grant = {
            token: TOKEN,
            id: `w1`,
            root: `/r`,
            file: `a.docx`,
            name: `a.docx`,
            origins: [`https://app.intentic.dev`],
            expiresAt: 100,
        };
        grants.add(handed);
        grants.add({ token: `b`.repeat(64), id: `w2`, root: `/r`, name: `r` });
        expect([...grants.handoffOrigins()]).toEqual([`https://app.intentic.dev`]);
        now = 99;
        expect(grants.byToken(TOKEN)).toBe(handed);
        now = 100;
        expect(grants.byToken(TOKEN)).toBeUndefined();
        expect([...grants.handoffOrigins()]).toEqual([]);
        expect(grants.all().map((grant) => grant.id)).toEqual([`w2`]);
        expect(grants.expire(handed)).toBe(false);
        expect(ended).toEqual([`w1`]);
    });

    // The app re-points a window by granting its token again: the old grant's end must not take the new one with it.
    it(`answers the grant a new one replaces, and leaves the replacement alone when the old one's time comes`, () => {
        let now = 0;
        const grants = new Grants(() => now);
        const old: Grant = { token: TOKEN, id: `w1`, root: `/old`, name: `old`, expiresAt: 100 };
        const replacement: Grant = { token: TOKEN, id: `w1`, root: `/new`, name: `new` };
        expect(grants.add(old)).toBeUndefined();
        expect(grants.add(replacement)).toBe(old);
        now = 200;
        expect(grants.expire(old)).toBe(false);
        expect(grants.byToken(TOKEN)).toBe(replacement);
    });
});
