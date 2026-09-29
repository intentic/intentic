import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Watches } from "./watch.js";

let dir: string;
beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), `local-files-watch-`)));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Far above the 250 ms batch: this is a hang bound, not a latency measurement.
const settled = (ms = 1500): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe(`Watches`, () => {
    it(`reports a change as a root-relative path, a new folder's contents included`, async () => {
        const batches: (readonly string[])[] = [];
        const unsubscribe = new Watches(() => undefined).subscribe(dir, (paths) => batches.push(paths));
        await settled(300);
        await mkdir(join(dir, `docs`));
        await settled(600);
        writeFileSync(join(dir, `docs`, `a.md`), `# a`);
        await settled();
        unsubscribe();
        const seen = batches.flat();
        expect(seen).toContain(`docs`);
        expect(seen).toContain(`docs/a.md`);
    });

    it(`reports nothing once the last window lets go`, async () => {
        const batches: (readonly string[])[] = [];
        const unsubscribe = new Watches(() => undefined).subscribe(dir, (paths) => batches.push(paths));
        await settled(300);
        unsubscribe();
        writeFileSync(join(dir, `late.md`), `x`);
        await settled();
        expect(batches).toEqual([]);
    });

    // An unpacked archive or a checkout: cheaper to refetch than to walk path by path, as the daemon does.
    it(`sends a burst of more than 200 paths as "everything moved"`, async () => {
        const batches: (readonly string[])[] = [];
        const unsubscribe = new Watches(() => undefined).subscribe(dir, (paths) => batches.push(paths));
        await settled(300);
        for (let index = 0; index < 250; index++) {
            writeFileSync(join(dir, `file-${index}.txt`), `x`);
        }
        await settled();
        unsubscribe();
        expect(batches).toContainEqual([]);
        expect(batches.filter((paths) => paths.length > 200)).toEqual([]);
    });

    it(`does not report what moves inside installed packages`, async () => {
        mkdirSync(join(dir, `node_modules`, `left-pad`), { recursive: true });
        const batches: (readonly string[])[] = [];
        const unsubscribe = new Watches(() => undefined).subscribe(dir, (paths) => batches.push(paths));
        await settled(300);
        writeFileSync(join(dir, `node_modules`, `left-pad`, `index.js`), `x`);
        writeFileSync(join(dir, `a.md`), `# a`);
        await settled();
        unsubscribe();
        expect(batches.flat()).toContain(`a.md`);
        expect(batches.flat().filter((path) => path.startsWith(`node_modules/`))).toEqual([]);
    });
});
