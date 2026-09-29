import { reported } from "./watch.js";

// Which moved paths a window is told about, whatever the platform's watcher reports.

describe(`reported`, () => {
    it(`tells a folder's own files, and a folder nobody opens appearing`, () => {
        expect([`src/a.ts`, `node_modules`, `docs/brief.onlyoffice-notes.txt`].map(reported)).toEqual([true, true, true]);
    });

    // A recursive watch (Windows, macOS) reports every install and commit inside these.
    it(`leaves out what moves inside installed packages, build output and a version history`, () => {
        expect([`node_modules/left-pad/index.js`, `dist/app.js`, `.git`, `.git/index`, `repo/.git/HEAD`].map(reported)).toEqual([false, false, false, false, false]);
    });

    // Each save's own scratch file, which the save's rename reports as the change it is.
    it(`leaves out the scratch a text save and the office editor write beside a file`, () => {
        expect([`docs/.a.md.intentic-save-1a2b3c4d.tmp`, `docs/.brief.docx.onlyoffice-1a2b3c4d.tmp`].map(reported)).toEqual([false, false]);
    });
});
