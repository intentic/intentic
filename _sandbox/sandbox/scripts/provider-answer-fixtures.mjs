#!/usr/bin/env node
// Files each provider answer the answer watch kept (src/usage/drift/answer-vocabulary.ts) as a dated fixture in
// src/usage/drift/answers/, which real-answers.test.ts reads every reader against. Run it after the daemon logs
// "provider answer: a usage answer carries fields or pools never seen", then write the test for what the new answer
// means. Never overwrites: an answer already filed for that endpoint and day is left as it is.
//
//   node scripts/provider-answer-fixtures.mjs [path to provider-answers.json, default the history volume's own]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";

const source = process.argv[2] ?? join(HISTORY_ROOT, "provider-answers.json");
const target = join(import.meta.dirname, "..", "src", "usage", "drift", "answers");
const stored = JSON.parse(readFileSync(source, "utf8"));

for (const [endpoint, entry] of Object.entries(stored)) {
    // An entry from before samples were kept has none to file.
    if (entry?.sample === undefined || entry.changedAt === undefined) {
        continue;
    }
    const day = new Date(entry.changedAt).toISOString().slice(0, 10);
    const file = join(target, `${endpoint.replaceAll(/[:/]/g, ".")}.${day}.json`);
    if (existsSync(file)) {
        console.log(`kept    ${file}`);
        continue;
    }
    // The sample was redacted when it was kept (sampleOf); real-answers.test.ts checks every filed answer again.
    writeFileSync(file, `${JSON.stringify(JSON.parse(entry.sample), null, 4)}\n`);
    console.log(`filed   ${file}`);
}
