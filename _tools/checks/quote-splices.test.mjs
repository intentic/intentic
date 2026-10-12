// Pins what quote-splices reads as a hand-quoted splice into a command: a value between bare quotes on a line that
// builds one, in a file that does not import the shared quoters, and never in prose or a line that builds nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { importsQuoters, quoteSplices } from "./lib/quote-splices.mjs";

// The splice that shipped in _tools/desktop-smoke-windows/src/tier-engine.ts (de07fdb5f): a stamp with a quote in it
// ends printf's quoting early.
const SHIPPED = "    const wrote = await run(`docker`, [`exec`, container, `sh`, `-c`, `printf '%s' '${stamp}' > ${MARKER}`]);";

test("a value between bare quotes on a line that builds a command is a splice", () => {
    assert.deepEqual(quoteSplices(`const stamp = \`moved \${Date.now()}\`;\n${SHIPPED}`), [{ line: 2, code: SHIPPED.trim() }]);
    assert.equal(quoteSplices('await host.exec(`psql -c "ALTER ROLE app PASSWORD \'${password}\'"`);').length, 1);
});

test("a file that imports the quoters is taken at its word", () => {
    const text = `import { shellQuote } from "@intentic/sandbox-run/quote";\n${SHIPPED}`;
    assert.equal(importsQuoters(text), true);
    assert.deepEqual(quoteSplices(text), []);
});

test("prose, a splice that builds no command, and a value the quoters wrap are not splices", () => {
    assert.deepEqual(quoteSplices(`// never printf '%s' '\${stamp}' by hand\n * sh -c "'\${x}'"`), []);
    assert.deepEqual(quoteSplices("const label = `'${name}' is ready`;"), []);
    assert.deepEqual(quoteSplices("await run(`sh`, [`-c`, `printf '%s' ${shellQuote(stamp)} > ${MARKER}`]);"), []);
});

test("a carrier that dropped its import of the quoters is told apart from one that kept it", () => {
    assert.equal(importsQuoters(`import { envLine } from "@intentic/sandbox-run/quote";`), true);
    assert.equal(importsQuoters(`import { envLine } from "./env-line.js";`), false);
});
