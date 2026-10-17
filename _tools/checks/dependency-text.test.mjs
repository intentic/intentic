// Pins what dependency-text reads as a branch on another program's words: a failure's message or a child's stderr
// compared, searched or pattern-tested, however it is spelled, and never once a comment quotes it, the code reads
// structure instead, or the site says why the words must stay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { textBranches } from "./lib/text-branches.mjs";

const lines = (text) => textBranches(text).map(({ line }) => line);

test("a failure's message is judged however it is compared, searched or tested", () => {
    assert.deepEqual(
        lines(
            [
                `if (error instanceof TypeError && error.message === "fetch failed") {}`,
                `if ("fetch failed" === error.message) {}`,
                `return error.message.includes("already exists");`,
                `return error.message?.startsWith("fatal:");`,
                `return errorMessage(error).startsWith("fetch failed");`,
                `return errorMessage(cause(error)).includes("ECONNRESET");`,
                `return /database is locked/i.test(error.message);`,
                `const counters = RETRY.exec(event.message);`,
                `return ASKS.test(event.message.trim());`,
            ].join("\n"),
        ),
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
});

test("a child's stderr is judged however it is read", () => {
    assert.deepEqual(
        lines(
            [
                `if (admin.code !== 0 && !admin.stderr.includes("already exists")) {}`,
                `return /no server running on/m.test(stderrOf(error) ?? "");`,
                `return LOCK_CONTENTION.test(stderr);`,
                `const named = /Unable to create '([^']+)'/.exec(stderr)?.[1];`,
                `return stderr.trim().endsWith("not found");`,
            ].join("\n"),
        ),
        [1, 2, 3, 4, 5],
    );
});

test("structure, our own fields and a comment quoting the shape are not branches on words", () => {
    assert.deepEqual(
        lines(
            [
                `if (errnoCode(error) === "ENOENT") {}`,
                `if (exitCodeOf(error) === 128 && isFetchNetworkFailure(error)) {}`,
                `const message = error.message;`,
                `throw new Error(error.message);`,
                `log.warn({ stderr: result.stderr.text });`,
                `// never error.message.includes("fetch failed"): Bun words it differently`,
                `/**`,
                ` * /no server running/.test(stderr)`,
                ` */`,
            ].join("\n"),
        ),
        [],
    );
});

test("a site that says why is excused, on its line or in the comment block above it, and only with a reason", () => {
    assert.deepEqual(lines(`return /x/.test(stderr); // allow(dependency-text): tmux has no code for it; a miss rethrows`), []);
    assert.deepEqual(lines(`// allow(dependency-text): tmux has no code for it; a miss rethrows\nreturn /x/.test(stderr);`), []);
    assert.deepEqual(lines(`// allow(dependency-text):\nreturn /x/.test(stderr);`), [2]);
    // Another check's pragma excuses nothing here.
    assert.deepEqual(lines(`// allow(silent-catch): unrelated\nreturn /x/.test(stderr);`), [2]);
});
