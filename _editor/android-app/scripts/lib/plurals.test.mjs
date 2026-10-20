import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../../../_tools/constants/src/node.mjs";
import { quantities, RULES } from "./plurals.mjs";

test(`each language's quantities pick the form the web shows for the same count`, () => {
    assert.deepEqual(quantities(`en`, 2, `k`), [[`one`, 0], [`other`, 1]]);
    assert.deepEqual(quantities(`fr`, 2, `k`), [[`one`, 0], [`many`, 1], [`other`, 1]]);
    assert.deepEqual(quantities(`pl`, 3, `k`), [[`one`, 0], [`few`, 1], [`many`, 2], [`other`, 2]]);
    assert.deepEqual(quantities(`pl`, 2, `k`), [[`one`, 0], [`few`, 1], [`many`, 1], [`other`, 1]]);
});

test(`a form Android would never show stops the run`, () => {
    assert.throws(() => quantities(`en`, 3, `k`), /never shows form 0/);
});

// The rules here mirror the web's: read i18n.ts's own functions (their TypeScript types stripped) and compare them on
// every count a plural is likely to meet.
test(`the mirrored rules answer as i18n.ts's pluralRules do`, async () => {
    const source = readFileSync(join(repoRoot(import.meta.url), `_editor/ui/src/i18n/i18n.ts`), `utf8`);
    const literal = source.match(/const pluralRules = (\{[\s\S]*?\n\});/)?.[1];
    assert.ok(literal, `i18n.ts still declares pluralRules as an object literal`);
    const javascript = `export default ${literal.replaceAll(/\/\/.*$/gm, ``).replaceAll(/:\s*number/g, ``)}`;
    const { default: web } = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);
    assert.deepEqual(Object.keys(web).toSorted(), Object.keys(RULES).toSorted());
    for (const [locale, rule] of Object.entries(RULES)) {
        for (let count = 0; count <= 250; count++) {
            for (const length of [2, 3]) {
                assert.equal(rule(count, length), web[locale](count, length), `${locale} ${count} of ${length}`);
            }
        }
    }
});
