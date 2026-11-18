// Pins when an answer gets zod's compiled parser: a route's first three answers are parsed interpreted (`jitless`), and
// only a route that keeps answering is compiled. Counted per route, so one hot poll never compiles a route asked once,
// and the interpreted parse reads an answer exactly as the compiled one does.
import { freshImport } from "@intentic/testing/bun";
import { z } from "zod";

// The counts are module state, so each case starts from a fresh evaluation of the module.
const freshParse = (): Promise<typeof import("./answerParse")> => freshImport<typeof import("./answerParse")>(`./answerParse.ts`, import.meta.url);

describe(`answerParseOptions`, () => {
    test(`a route's first three answers are interpreted and the fourth is compiled`, async () => {
        const { answerParseOptions } = await freshParse();
        const options = [1, 2, 3, 4, 5].map(() => answerParseOptions(`agents.list`));
        expect(options).toEqual([{ jitless: true }, { jitless: true }, { jitless: true }, undefined, undefined]);
    });

    test(`each route is counted on its own`, async () => {
        const { answerParseOptions } = await freshParse();
        for (let answer = 0; answer < 4; answer += 1) {
            answerParseOptions(`agents.list`);
        }
        expect(answerParseOptions(`agents.list`)).toBeUndefined();
        expect(answerParseOptions(`GET /environment`)).toEqual({ jitless: true });
    });

    test(`an interpreted parse reads an answer as the compiled one does`, async () => {
        const { answerParseOptions } = await freshParse();
        const schema = z.object({
            id: z.string(),
            count: z.number().default(0),
            tags: z.array(z.object({ name: z.string(), at: z.string().optional() })),
            note: z.string().nullable().optional(),
        });
        const answer = { id: `a1`, tags: [{ name: `x` }, { name: `y`, at: `2026-11-18` }], note: null, extra: true };
        const interpreted = schema.parse(answer, answerParseOptions(`demo.route`));
        expect(interpreted).toEqual(schema.parse(answer));
        expect(interpreted).toEqual({ id: `a1`, count: 0, tags: [{ name: `x` }, { name: `y`, at: `2026-11-18` }], note: null });
        expect(() => schema.parse({ id: 1, tags: [] }, answerParseOptions(`demo.route`))).toThrow();
    });
});
