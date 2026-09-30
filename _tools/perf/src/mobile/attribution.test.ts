import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { areaOf, attribute, type CpuProfile, decodeVlq, SourceMap } from "./attribution";

// A profile of a minified bundle names `n` in `index-D0P5VUoY.js:1`; these are what turn it back into a source file.

describe(`decodeVlq`, () => {
    it(`reads base64 VLQ fields, signs and continuations included`, () => {
        expect(decodeVlq(`AAAA`)).toEqual([0, 0, 0, 0]);
        expect(decodeVlq(`AACA`)).toEqual([0, 0, 1, 0]);
        expect(decodeVlq(`D`)).toEqual([-1]);
        // 16 needs a continuation digit: `g` carries the low five bits with the continuation bit set, `B` the rest.
        expect(decodeVlq(`gB`)).toEqual([16]);
    });
});

describe(`SourceMap`, () => {
    // Line 0: column 0 → a.ts:1, column 10 → b.ts:5 named `run`. Line 1: column 4 → a.ts:3, its source line two back from
    // b.ts:5 since source lines count on across the whole map.
    const map = new SourceMap([`../src/a.ts`, `../src/b.ts`], [`run`], `AAAA,UCIAA;IDFA`);

    it(`answers the nearest mapping at or before a generated column`, () => {
        expect(map.lookup(0, 3)).toEqual({ source: `../src/a.ts`, line: 1, name: undefined });
        expect(map.lookup(0, 12)).toEqual({ source: `../src/b.ts`, line: 5, name: `run` });
        expect(map.lookup(1, 9)).toEqual({ source: `../src/a.ts`, line: 3, name: undefined });
    });

    it(`answers nothing before the first mapping of a line, or for a line it has none on`, () => {
        expect(map.lookup(1, 0)).toBeUndefined();
        expect(map.lookup(7, 0)).toBeUndefined();
    });
});

describe(`areaOf`, () => {
    it(`names an npm package, a repository area, or the path it was given`, () => {
        expect(areaOf(`../../node_modules/.pnpm/zod@4.1.0/node_modules/zod/v4/core/schemas.js`)).toBe(`npm:zod`);
        expect(areaOf(`../../node_modules/.pnpm/@vue+runtime-core@3.5.43/node_modules/@vue/runtime-core/dist/x.js`)).toBe(`npm:@vue/runtime-core`);
        expect(areaOf(`../../_editor/web/src/features/chat/transcript/ChatMessageView.vue`)).toBe(`_editor/web/src/features/chat`);
        expect(areaOf(`../../_shared/sandbox-contract/src/index.ts`)).toBe(`_shared/sandbox-contract`);
        expect(areaOf(`../elsewhere.ts`)).toBe(`elsewhere.ts`);
    });
});

describe(`attribute`, () => {
    it(`adds each sample's self time to the source its frame maps to, and keeps idle and engine time apart`, () => {
        const assets = mkdtempSync(join(tmpdir(), `perf-mobile-attribution-`));
        writeFileSync(
            join(assets, `index-x.js.map`),
            JSON.stringify({ sources: [`../../_editor/web/src/features/chat/a.ts`, `../../node_modules/zod/b.js`], names: [], mappings: `AAAA,UCIAA` }),
        );
        const frame = (functionName: string, url = ``, columnNumber = 0) => ({ functionName, url, lineNumber: 0, columnNumber });
        const profile: CpuProfile = {
            nodes: [
                { id: 1, callFrame: frame(`(idle)`) },
                { id: 2, callFrame: frame(`(program)`) },
                { id: 3, callFrame: frame(`render`, `http://x/demo/assets/index-x.js`, 2) },
                { id: 4, callFrame: frame(`parse`, `http://x/demo/assets/index-x.js`, 11) },
            ],
            samples: [1, 2, 3, 3, 4],
            timeDeltas: [5_000, 2_000, 1_000, 1_000, 3_000],
        };

        const where = attribute(profile, assets);
        expect({ total: where.totalMs, idle: where.idleMs, engine: where.engineMs }).toEqual({ total: 12, idle: 5, engine: 2 });
        expect(where.byArea).toEqual([
            [`npm:zod`, 3],
            [`_editor/web/src/features/chat`, 2],
        ]);
    });
});
