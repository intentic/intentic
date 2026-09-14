#!/usr/bin/env node
// engines.json is read fleet-wide, hourly, with no build or review gate of its own, so each blessed version must equal
// the version this repo actually pins for that engine. Where those pins live is _tools/scripts/engines/engine-pins.mjs,
// which the bumper writes through — this check and the thing that moves the numbers read one description, so a pin site
// cannot be updated by one and forgotten by the other. Notes, `policy` and the advisory `minimum` field are unchecked.

import { ENGINE_PINS, readBlessedList, readPins } from "../scripts/engines/engine-pins.mjs";
import { finish } from "./lib/report.mjs";

const list = readBlessedList();
const pins = readPins();
const problems = [];

for (const engine of ENGINE_PINS) {
    const entry = list.engines?.[engine.id];
    if (entry === undefined) {
        problems.push(`engines.json blesses no version for ${engine.id}; every engine this repo pins has to be listed`);
        continue;
    }
    const { blessed, problems: unreadable } = pins[engine.id];
    if (unreadable.length > 0) {
        problems.push(...unreadable);
        continue;
    }
    if (entry.blessed !== blessed) {
        problems.push(
            `engines.json blesses ${engine.id}@${entry.blessed}, but this repository pins ${blessed}. ` +
                `Blessed means "this repo's suite ran against it": move the pin first, let CI go green, then bless it — ` +
                `\`node _tools/scripts/engines/bump-engines.mjs --apply\` does all three in the right order.`,
        );
    }
}

// Catches the reverse: a listed engine this repo has no pin for would ship a version nobody here has run.
for (const id of Object.keys(list.engines ?? {})) {
    if (ENGINE_PINS.every((engine) => engine.id !== id)) {
        problems.push(`engines.json lists ${id}, which is not an engine this repository pins`);
    }
}

finish(
    [["engines.json does not match this repository", problems]],
    [`engines.json: ${ENGINE_PINS.length} blessed versions match this repository's pins`],
);
