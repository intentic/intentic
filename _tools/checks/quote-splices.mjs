#!/usr/bin/env node
// A VALUE SPLICED INTO A COMMAND BETWEEN BARE QUOTES: `psql -c "… '${password}'"`, `printf '%s' '${stamp}'`. A quote in
// the value ends the quoting early and the rest is read as the command's own text. The shared quoters
// (@intentic/sandbox-run/quote) wrap a value once per parser it crosses. A file that imports them is taken at its word;
// any other may not write the shape on a line that builds a command (lib/quote-splices.mjs). Found by discovery, not a
// list, over every TypeScript file: the shape turns up wherever a host is driven, which is no one package.
//
// Under it, a floor: the files that carry secrets to a host (CARRIERS) still import the quoters, so a refactor that
// drops them reads as a break rather than as a file with nothing left to flag. Whether a carrier imports them is a
// property of that file, judged in a scoped run too; a carrier that is gone is a fact about the tree, judged only when
// the whole tree is read.
//
// Both were a suite inside @intentic/sandbox-run, which ran only when that package's tests did, and so never when the
// package that wrote the line was another one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importsQuoters, quoteSplices } from "./lib/quote-splices.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles, subjectScope } from "./lib/repo.mjs";

const CARRIERS = [
    "_deploy/providers/src/backup/backup.ts",
    "_deploy/providers/src/backings/postgres-database.ts",
    "_deploy/providers/src/backings/valkey-namespace.ts",
    // The write-once .env every provider's secrets cross, Komodo's included since it became a compose-service spec
    // (2026-10-06); naming it holds the floor under all of them.
    "_deploy/providers/src/core/host-files.ts",
    "_sandbox/sandbox/src/secrets/secrets.routes.ts",
];

// Tests write the broken shape on purpose to assert against it, and quote.ts IS the shape. Installed, built, vendored
// and published trees are somebody else's source or a copy of this one.
const EXEMPT = /(?:\.test\.ts|\/quote\.ts)$|(?:^|\/)(?:node_modules|dist|build|coverage|refs|public|\.[^/]+)\//;

const files = subjectFiles("*.ts").filter((path) => !EXEMPT.test(path));
const texts = new Map(files.map((path) => [path, readFileSync(join(root, path), "utf8")]));
const spliced = files.flatMap((path) => quoteSplices(texts.get(path)).map(({ line, code }) => `${path}:${line}: ${code}`));
const unquoted = CARRIERS.flatMap((carrier) => {
    if (!texts.has(carrier)) {
        return subjectScope() === undefined ? [`${carrier}: named in CARRIERS (_tools/checks/quote-splices.mjs) and no longer in the tree: name the file that carries those secrets now`] : [];
    }
    return importsQuoters(texts.get(carrier)) ? [] : [`${carrier}: must quote through @intentic/sandbox-run/quote`];
});

finish(
    [
        [
            `hand-rolled quoting — import { shellQuote, sqlLiteral, sqlIdentifier, envLine, dockerEnvLine } from "@intentic/sandbox-run/quote" and wrap the value, one call per parser it crosses`,
            spliced,
        ],
        [`a file that carries secrets to a host no longer imports the shared quoters`, unquoted],
    ],
    [`${files.length} TypeScript files read: no value spliced into a command between bare quotes, and the ${CARRIERS.length} carriers of secrets quote through @intentic/sandbox-run/quote`],
);
