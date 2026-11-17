#!/usr/bin/env node
// A VALUE SPLICED INTO A COMMAND BETWEEN BARE QUOTES: `psql -c "… '${password}'"`, `printf '%s' '${stamp}'`. A quote in
// the value ends the quoting early and the rest is read as the command's own text. The shared quoters
// (@intentic/sandbox-run/quote) wrap a value once per parser it crosses. A file that imports them is taken at its word;
// any other may not write the shape on a line that builds a command (lib/quote-splices.mjs). Found by discovery, not a
// list, over every TypeScript file: the shape turns up wherever a host is driven, which is no one package.
//
// It was a suite inside @intentic/sandbox-run, which ran only when that package's tests did, and so never when the
// package that wrote the line was another one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteSplices } from "./lib/quote-splices.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

// Tests write the broken shape on purpose to assert against it, and quote.ts IS the shape. Installed, built, vendored
// and published trees are somebody else's source or a copy of this one.
const EXEMPT = /(?:\.test\.ts|\/quote\.ts)$|(?:^|\/)(?:node_modules|dist|build|coverage|refs|public|\.[^/]+)\//;

const files = subjectFiles("*.ts").filter((path) => !EXEMPT.test(path));
const texts = new Map(files.map((path) => [path, readFileSync(join(root, path), "utf8")]));
const spliced = files.flatMap((path) => quoteSplices(texts.get(path)).map(({ line, code }) => `${path}:${line}: ${code}`));

finish(
    [
        [
            `hand-rolled quoting — import { shellQuote, sqlLiteral, sqlIdentifier, envLine, dockerEnvLine } from "@intentic/sandbox-run/quote" and wrap the value, one call per parser it crosses`,
            spliced,
        ],
    ],
    [`${files.length} TypeScript files read: no value spliced into a command between bare quotes`],
);
