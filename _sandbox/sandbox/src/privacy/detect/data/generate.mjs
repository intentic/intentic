#!/usr/bin/env node
// Rebuilds the name lists the detector reads (first-names-pl.ts, surnames-pl.ts, names-en.ts) from the public registers
// they come from. The downloads are not committed: they are tens of megabytes, and the lists only need the common part.
//
// Sources and licenses, recorded again in each generated file's header:
// - "Lista imion występujących w rejestrze PESEL" (https://dane.gov.pl/pl/dataset/1667), Ministerstwo Cyfryzacji,
//   CC0 1.0. The "imię pierwsze" files, male and female, as CSV.
// - "Nazwiska występujące w rejestrze PESEL" (https://dane.gov.pl/pl/dataset/1681), Ministerstwo Cyfryzacji, CC0 1.0.
//   The "Nazwiska męskie" and "Nazwiska żeńskie" files, as CSV.
// - US Social Security Administration, "Baby Names from Social Security Card Applications - National Data"
//   (https://www.ssa.gov/oact/babynames/names.zip), a US government work in the public domain. ssa.gov refuses
//   scripted downloads too; the archive is mirrored unchanged at
//   https://raw.githubusercontent.com/hackerb9/ssa-baby-names/master/raw-data/names.zip.
// - US Census Bureau, 2000 Census surnames occurring 100 or more times, a US government work in the public domain
//   (the census site refuses scripted downloads; FiveThirtyEight mirrors the file unchanged at
//   https://raw.githubusercontent.com/fivethirtyeight/data/master/most-common-name/surnames.csv).
//
// Fetching them: the dane.gov.pl API lists each dataset's resources with a `csv_download_url`
// (https://api.dane.gov.pl/1.4/datasets/1667/resources and .../1681/resources; take the newest of each kind). Put them
// in one directory as first-male.csv, first-female.csv, surname-male.csv, surname-female.csv, unzip the SSA archive
// into its `ssa/` subdirectory (the yob*.txt files) and save the census file as surnames-us.csv. Then:
//
//   node src/privacy/detect/data/generate.mjs <that directory>

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A first name borne by fewer people than this is more often a typo or a one-off transliteration than a name anyone
// will meet in a document, and every extra entry is one more ordinary word that might collide with it.
const PL_FIRST_MIN_BEARERS = 300;
// Names this common are looked up in every inflected form; rarer ones (mostly foreign: Ana, Vera, Nika) only as
// written, because reducing ordinary words to them finds far more words than names ("any" is Ana's genitive).
const PL_FIRST_DECLINED_BEARERS = 2000;
// The surname registers have 400,000 forms each; the top 8,000 of each cover most people, and the long tail is what
// the morphology rules and the local model are for.
const PL_SURNAMES_PER_LIST = 8000;
// English names only need the common ones: they are the second language here, and rare ones collide with words.
const EN_FIRST_PER_SEX = 400;
const EN_SURNAMES = 1000;
// The SSA counts start in 1880; people writing and written about today were mostly born after this.
const SSA_FROM_YEAR = 1950;
// Two-letter "names" (Al, Bo, Li) are far more often abbreviations, articles or code than people.
const MIN_LENGTH = 3;

const source = process.argv[2];
if (source === undefined) {
    console.error("usage: node generate.mjs <directory with the downloaded sources>");
    process.exit(1);
}
const outDir = import.meta.dirname;

// Single words of letters only: the registers also hold "JUAN CARLOS", "ANNA-MARIA" and "BRAK DANYCH" (no data); a
// compound is matched word by word anyway, and a placeholder is not a name.
const WORD = /^\p{L}+$/u;
const keep = (name) => WORD.test(name) && name.length >= MIN_LENGTH;
const lower = (name) => name.normalize("NFC").toLocaleLowerCase("pl");

const readCsv = (file) => {
    const text = readFileSync(join(source, file), "utf8").replace(/^﻿/, "");
    return text
        .split(/\r?\n/)
        .slice(1)
        .filter((line) => line.trim() !== "")
        .map((line) => line.split(","));
};

const firstNamesPl = (file, min, below = Infinity) =>
    readCsv(file)
        .filter((row) => Number(row[2]) >= min && Number(row[2]) < below)
        .map((row) => lower(row[0]))
        .filter(keep);

const topSurnamesPl = (file) =>
    readCsv(file)
        .map((row) => ({ name: lower(row[0]), count: Number(row[1]) }))
        .filter((row) => keep(row.name))
        .sort((a, b) => b.count - a.count)
        .slice(0, PL_SURNAMES_PER_LIST)
        .map((row) => row.name);

const ssaFirstNames = () => {
    const totals = { F: new Map(), M: new Map() };
    for (const file of readdirSync(join(source, "ssa"))) {
        const year = /^yob(\d{4})\.txt$/.exec(file);
        if (year === null || Number(year[1]) < SSA_FROM_YEAR) {
            continue;
        }
        for (const line of readFileSync(join(source, "ssa", file), "utf8").split(/\r?\n/)) {
            const [name, sex, count] = line.split(",");
            const bySex = totals[sex];
            if (bySex !== undefined && name !== undefined) {
                bySex.set(name, (bySex.get(name) ?? 0) + Number(count));
            }
        }
    }
    const top = (bySex) =>
        [...bySex.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, EN_FIRST_PER_SEX)
            .map(([name]) => lower(name));
    return [...top(totals.F), ...top(totals.M)].filter(keep);
};

const censusSurnames = () =>
    readCsv("surnames-us.csv")
        .map((row) => ({ name: lower(row[0]), rank: Number(row[1]) }))
        .filter((row) => keep(row.name))
        .sort((a, b) => a.rank - b.rank)
        .slice(0, EN_SURNAMES)
        .map((row) => row.name);

const sorted = (names) => [...new Set(names)].sort((a, b) => a.localeCompare(b, "pl"));

const write = (file, header, exports) => {
    const body = exports.map(([name, list]) => `export const ${name} =\n    ${JSON.stringify(list.join("\n"))};\n`).join("\n");
    writeFileSync(join(outDir, file), `${header}\n// Generated by generate.mjs from the sources named there; do not edit by hand.\n\n${body}`);
    console.log(`${file}: ${exports.map(([name, list]) => `${name} ${list.length}`).join(", ")}`);
};

const plFirst = sorted(["first-male.csv", "first-female.csv"].flatMap((file) => firstNamesPl(file, PL_FIRST_DECLINED_BEARERS)));
const plFirstSet = new Set(plFirst);
// A name common for one sex and rare for the other (Maria for men) is already in the declined list.
const plFirstRare = sorted(
    ["first-male.csv", "first-female.csv"].flatMap((file) => firstNamesPl(file, PL_FIRST_MIN_BEARERS, PL_FIRST_DECLINED_BEARERS)),
).filter((name) => !plFirstSet.has(name));
const plSurnames = sorted([...topSurnamesPl("surname-male.csv"), ...topSurnamesPl("surname-female.csv")]);
const plSurnameSet = new Set(plSurnames);
// The English lists only add what the Polish ones lack: Poland's registers already hold Anna, Adam or Nowak.
const plFirstRareSet = new Set(plFirstRare);
const enFirst = sorted(ssaFirstNames().filter((name) => !plFirstSet.has(name) && !plFirstRareSet.has(name)));
const enSurnames = sorted(censusSurnames().filter((name) => !plSurnameSet.has(name)));

const PESEL_LICENSE = "// Source: dane.gov.pl, Ministerstwo Cyfryzacji, from the PESEL register; license CC0 1.0.";
write(
    "first-names-pl.ts",
    `// Polish first names borne by living people, lowercase, one per line: FIRST_NAMES_PL by at least ${PL_FIRST_DECLINED_BEARERS}\n// (matched in every inflected form), FIRST_NAMES_PL_RARE by ${PL_FIRST_MIN_BEARERS} to ${PL_FIRST_DECLINED_BEARERS - 1} (matched as written).\n${PESEL_LICENSE}\n// Dataset "Lista imion występujących w rejestrze PESEL", https://dane.gov.pl/pl/dataset/1667.`,
    [
        ["FIRST_NAMES_PL", plFirst],
        ["FIRST_NAMES_PL_RARE", plFirstRare],
    ],
);
write("surnames-pl.ts", `// The ${PL_SURNAMES_PER_LIST} most frequent male and female Polish surname forms, merged, lowercase, one per line.\n${PESEL_LICENSE}\n// Dataset "Nazwiska występujące w rejestrze PESEL", https://dane.gov.pl/pl/dataset/1681.`, [
    ["SURNAMES_PL", plSurnames],
]);
write(
    "names-en.ts",
    `// Common English first names and surnames the Polish lists lack, lowercase, one per line.\n// First names: US Social Security Administration baby names since ${SSA_FROM_YEAR}, the ${EN_FIRST_PER_SEX} most frequent per sex; public domain.\n// Surnames: US Census Bureau 2000 surnames, the ${EN_SURNAMES} most frequent; public domain.`,
    [
        ["FIRST_NAMES_EN", enFirst],
        ["SURNAMES_EN", enSurnames],
    ],
);
