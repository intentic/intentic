#!/usr/bin/env node
// A model is named one way: the provider catalog's label, through providerCatalog.modelLabelFor in the app and the
// contract's humanizeModelId wherever a catalog names nothing. A `label ?? model` falls back to the raw id instead,
// which is how `claude-opus-5-5` reached screens that meant "Claude Opus 5.5"; this recognizes that shape anywhere.
import { readFileSync } from "node:fs";
import { finish } from "./lib/report.mjs";
import { subjectFiles, TEST_FILE } from "./lib/repo.mjs";

// A label, a display name or a published name, handed a model id when it is missing.
const RAW_ID_FALLBACK = /\b(?:label|displayName|display_name)\s*(?:\?\?|\|\|)\s*[\w.?]*(?:\bmodel(?:Id)?|\.model(?:Id)?|model\.id)\b/;

const files = subjectFiles("*.ts", "*.vue", "*.mjs").filter((path) => !TEST_FILE.test(path) && !path.startsWith("refs/") && path !== "_tools/checks/model-labels.mjs");

const found = [];
for (const path of files) {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
        if (RAW_ID_FALLBACK.test(line)) {
            found.push(`${path}:${index + 1}  ${line.trim()}`);
        }
    }
}

finish(
    [
        [
            "A model label falls back to its raw id: name it with modelLabelFor(provider, id) in the app, or humanizeModelId(id) where no catalog applies",
            found,
        ],
    ],
    [`model labels: ${files.length} source files, none falls back to a raw model id`],
);
