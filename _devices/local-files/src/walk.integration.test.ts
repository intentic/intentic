import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listChildren, walkTree } from "./walk.js";

let base: string;
let root: string;
beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), `local-files-walk-`)));
    root = join(base, `project`);
    mkdirSync(join(root, `src`), { recursive: true });
    mkdirSync(join(root, `node_modules`, `left-pad`), { recursive: true });
    mkdirSync(join(root, `dist`));
    writeFileSync(join(root, `.gitignore`), `dist\n`);
    writeFileSync(join(root, `src`, `index.ts`), `export {};`);
    writeFileSync(join(root, `node_modules`, `left-pad`, `index.js`), ``);
    writeFileSync(join(root, `dist`, `out.js`), ``);
    writeFileSync(join(base, `outside.txt`), `x`);
    symlinkSync(join(base, `outside.txt`), join(root, `outside.txt`));
    symlinkSync(join(root, `missing`), join(root, `broken`));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe(`walkTree`, () => {
    it(`lists folders before files, opens what is tracked, and lists what is ignored unopened`, async () => {
        const walked = await walkTree(root);
        expect(walked.tree.map((entry) => [entry.name, entry.type, entry.ignored === true, entry.children?.length])).toEqual([
            [`dist`, `dir`, true, undefined],
            [`node_modules`, `dir`, true, undefined],
            [`src`, `dir`, false, 1],
            [`.gitignore`, `file`, false, undefined],
            [`broken`, `file`, false, undefined],
            [`outside.txt`, `file`, false, undefined],
        ]);
        expect(walked.hidden).toBe(0);
    });

    it(`marks a link that leads out, and one that leads nowhere`, async () => {
        const walked = await walkTree(root);
        expect(walked.tree.find((entry) => entry.name === `outside.txt`)?.link).toEqual({ to: join(base, `outside.txt`), state: `outside` });
        expect(walked.tree.find((entry) => entry.name === `broken`)?.link).toEqual({ to: join(root, `missing`), state: `broken` });
    });

    // A folder too big for what is left of the budget is left unopened whole, not half listed.
    it(`defers a folder the budget cannot hold, and counts what the root itself cut`, async () => {
        const walked = await walkTree(root, 4);
        expect(walked.tree).toHaveLength(4);
        expect(walked.hidden).toBe(2);
    });
});

describe(`listChildren`, () => {
    it(`opens an ignored folder on request, its entries ignored too`, async () => {
        expect(await listChildren(root, `node_modules`)).toEqual({
            entries: [{ name: `left-pad`, path: `node_modules/left-pad`, type: `dir`, ignored: true }],
            hidden: 0,
        });
    });

    it(`lists nothing for a path that leaves the folder`, async () => {
        expect(await listChildren(root, `../`)).toEqual({ entries: [], hidden: 0 });
    });
});
