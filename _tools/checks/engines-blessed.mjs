#!/usr/bin/env node
// engines.json is read fleet-wide, hourly, with no build or review gate of its own, so each blessed version must equal
// the version this repo actually pins for that engine. Where those pins live is _tools/scripts/engines/engine-pins.mjs,
// which the bumper writes through — this check and the thing that moves the numbers read one description, so a pin site
// cannot be updated by one and forgotten by the other. Notes, `policy` and the advisory `minimum` field are unchecked.

import { ENGINE_PINS, listKeyOf, readBlessedList, readPins } from "../scripts/engines/engine-pins.mjs";
import { finish } from "./lib/report.mjs";

const list = readBlessedList();
const pins = readPins();
const problems = [];

for (const engine of ENGINE_PINS) {
    const key = listKeyOf(engine);
    const entry = list.engines?.[key];
    if (entry === undefined) {
        problems.push(`engines.json blesses no version for ${engine.id} under "${key}"; every engine this repo pins has to be listed`);
        continue;
    }
    const { blessed, problems: unreadable } = pins[engine.id];
    if (unreadable.length > 0) {
        problems.push(...unreadable);
        continue;
    }
    if (entry.blessed !== blessed) {
        problems.push(
            `engines.json blesses ${key}@${entry.blessed}, but this repository pins ${blessed}. ` +
                `Blessed means "this repo's suite ran against it": move the pin first, let CI pass, then bless it — ` +
                `\`node _tools/scripts/engines/bump-engines.mjs --apply\` does all three in the right order.`,
        );
    }
}

// Catches the reverse: a listed engine this repo has no pin for would ship a version nobody here has run. A `frozen`
// entry is the exception, kept for daemons already released: when an engine's major moves to a key of its own, the old
// key stays at the last version those daemons can drive, and nothing here moves it again.
for (const [key, entry] of Object.entries(list.engines ?? {})) {
    if (ENGINE_PINS.every((engine) => listKeyOf(engine) !== key) && !(typeof entry?.frozen === "string" && entry.frozen !== "")) {
        problems.push(`engines.json lists ${key}, which is not an engine this repository pins`);
    }
}

finish(
    [["engines.json does not match this repository", problems]],
    [`engines.json: ${ENGINE_PINS.length} blessed versions match this repository's pins`],
);
