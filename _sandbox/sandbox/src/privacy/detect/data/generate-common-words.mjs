#!/usr/bin/env node
// Rebuilds common-words.ts: every word the name lists would read as a first name or a surname (listed, or shaped like
// one: an adjective in -ski or -cki) that is also an ordinary word in some language, so that, capitalized, it proves
// nothing on its own and completes no name ("Luna" is the moon in Spanish and Italian, "Adam" a man in Turkish, "Tom"
// "that" in Czech, "Costa" a coast). The hand-written lists in ambiguous.ts
// hold the words of Polish and English; this one holds the rest, found by counting rather than by hand.
//
// Source: the Leipzig Corpora Collection (https://wortschatz.uni-leipzig.de/en/download), its normed corpora of
// 300,000 sentences per language, licensed CC BY (© Universität Leipzig / Sächsische Akademie der Wissenschaften /
// InfAI). Only each corpus's word list (`<corpus>-words.txt`: id, word, count) is read. Download the corpora named in
// the generated file's header from https://downloads.wortschatz-leipzig.de/corpora/<corpus>.tar.gz, unpack them into
// one directory, then:
//
//   node --import tsx src/privacy/detect/data/generate-common-words.mjs <that directory>
//
// A word is ordinary in a language when that corpus writes it in lowercase at least MIN_LOWERCASE times and at least
// LOWERCASE_SHARE as often as capitalized: a name is written lowercase only by mistake, a word mostly is. German writes
// its nouns capitalized, so a German noun that is also a name (Wolf, Fuchs) is caught only where another language has
// it in lowercase; the English list does for most.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { wordInfo } from "../lexicon.js";
import { AMBIGUOUS_EN, AMBIGUOUS_PL } from "./ambiguous.js";

// About three in a million words: a word met in ordinary text, not a typo or a one-off.
const MIN_LOWERCASE = 20;
const LOWERCASE_SHARE = 0.2;
const MIN_LENGTH = 3;

const source = process.argv[2];
if (source === undefined) {
    console.error("usage: node --import tsx generate-common-words.mjs <directory with the unpacked corpora>");
    process.exit(1);
}

const wordFiles = (dir) =>
    readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? wordFiles(path) : entry.endsWith("-words.txt") ? [path] : [];
    });

const LOWER = /^\p{Ll}+$/u;
const CAPITALIZED = /^\p{Lu}\p{Ll}+$/u;
const handWritten = new Set(`${AMBIGUOUS_EN} ${AMBIGUOUS_PL}`.split(/\s+/u).filter((word) => word !== ""));

// Words, and the corpora they are ordinary in.
const found = new Map();
const corpora = [];
for (const file of wordFiles(source).sort()) {
    const corpus = basename(file).replace(/-words\.txt$/u, "");
    corpora.push(corpus);
    const lower = new Map();
    const capitalized = new Map();
    for (const line of readFileSync(file, "utf8").split("\n")) {
        const [, word, count] = line.split("\t");
        if (word === undefined || count === undefined) {
            continue;
        }
        const normal = word.normalize("NFC");
        if (LOWER.test(normal)) {
            lower.set(normal, (lower.get(normal) ?? 0) + Number(count));
        } else if (CAPITALIZED.test(normal)) {
            const key = normal.toLowerCase();
            capitalized.set(key, (capitalized.get(key) ?? 0) + Number(count));
        }
    }
    for (const [word, count] of lower) {
        if (word.length < MIN_LENGTH || count < MIN_LOWERCASE || count < LOWERCASE_SHARE * (capitalized.get(word) ?? 0) || handWritten.has(word)) {
            continue;
        }
        const info = wordInfo(word);
        if ((info.first || info.surname || info.surnameForm) && !info.never) {
            found.set(word, [...(found.get(word) ?? []), corpus.slice(0, 3)]);
        }
    }
}

const words = [...found.keys()].sort((a, b) => a.localeCompare(b, "pl"));
const languages = [...new Set(corpora.map((corpus) => corpus.slice(0, 3)))].sort();
const header = [
    "// Words the name lists read as a first name or a surname (listed, or shaped like one) that are ordinary words in some",
    "// language, lowercase, one per line: each is written in lowercase in at least one of the corpora below, often enough",
    "// to be a word there.",
    "// Source: Leipzig Corpora Collection, https://wortschatz.uni-leipzig.de/en/download, CC BY",
    "// (© Universität Leipzig / Sächsische Akademie der Wissenschaften / InfAI). Word lists of the 300K-sentence corpora:",
    ...corpora.reduce((lines, corpus, index) => {
        const item = index < corpora.length - 1 ? `${corpus},` : corpus;
        const last = lines.at(-1);
        if (last !== undefined && last.length + item.length < 118) {
            lines[lines.length - 1] = `${last} ${item}`;
        } else {
            lines.push(`//   ${item}`);
        }
        return lines;
    }, []),
    `// Thresholds: written lowercase at least ${MIN_LOWERCASE} times, and at least ${LOWERCASE_SHARE} times as often as capitalized.`,
    "// Generated by generate-common-words.mjs from the sources named there; do not edit by hand.",
].join("\n");
const body = `export const COMMON_WORDS =\n    ${JSON.stringify(words.join("\n"))};\n`;
writeFileSync(join(import.meta.dirname, "common-words.ts"), `${header}\n\n${body}`);
console.log(`common-words.ts: ${words.length} words from ${corpora.length} corpora (${languages.join(" ")})`);
