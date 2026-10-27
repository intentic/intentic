#!/usr/bin/env node
// A `defineModel` name is a plain string literal, never a template literal. vue-tsc 3 reads either, but the TypeScript 7
// content mappers (`@vue/content-mapper` 4, and the Rust port of it) write the name into their virtual code as it is
// spelled, and a backticked one comes out as code that does not parse: measured 2026-10-26 on _editor/web, 33 such names
// in 25 components made 77 syntax errors, and a syntax error stops the checker before it checks a single type. Those
// mappers are what lets tsrs or tsgo check the app in seconds where vue-tsc takes minutes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

// `defineModel(` or `defineModel<T>(`, then a backtick as the first argument.
const BACKTICKED = /defineModel\s*(?:<[^()]*?>)?\s*\(\s*`/g;

const subjects = subjectFiles("*.vue");
const findings = subjects.flatMap((path) => {
    const text = readFileSync(join(root, path), "utf8");
    return [...text.matchAll(BACKTICKED)].map((match) => `${path}:${text.slice(0, match.index).split("\n").length}`);
});

finish(
    [["a `defineModel` named with a template literal, which the TypeScript 7 Vue content mappers turn into code that does not parse: name it with a plain string", findings]],
    [`${subjects.length} Vue components read: every \`defineModel\` name is a plain string`],
);
