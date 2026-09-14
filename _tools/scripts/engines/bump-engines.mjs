#!/usr/bin/env node
// THE THING THAT KEEPS `blessed` FROM GOING STALE. Asks upstream what each agent engine has published, takes the newest
// stable version that has aged past its soak window, rewrites every pin this repository carries for it, and moves
// engines.json to match. It does not verify anything and it does not decide anything is safe — CI does that, on the
// pull request .github/workflows/engines.yml opens from what this wrote. Blessed still means "this repo's suite ran
// against it"; it just stops meaning "someone remembered".
//
//   node _tools/scripts/engines/bump-engines.mjs                     what would move, and why the rest would not
//   node _tools/scripts/engines/bump-engines.mjs --json              the same, for a machine
//   node _tools/scripts/engines/bump-engines.mjs --apply             write the pins and engines.json
//   node _tools/scripts/engines/bump-engines.mjs --apply --engine=claude --to=0.3.270
//
// An engine upstream could not be reached for is reported and left alone, never guessed at.

import { appendFileSync } from "node:fs";
import { ENGINE_PINS, blessedFor, enginePin, readBlessedList, readPin, writeBlessed, writePin } from "./engine-pins.mjs";
import { isNewer, npmManifest, publishedVersions } from "./upstream.mjs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

const apply = has("--apply");
const asJson = has("--json");
const only = value("--engine");
const to = value("--to");

if (to !== undefined && only === undefined) {
    console.error("--to names one version, so it needs --engine to say whose");
    process.exit(2);
}
if (only !== undefined && enginePin(only) === undefined) {
    console.error(`no engine called ${only}; this repo pins ${ENGINE_PINS.map((engine) => engine.id).join(", ")}`);
    process.exit(2);
}

const list = readBlessedList();
const DEFAULT_SOAK_HOURS = list.policy?.soakHours ?? 6;
const soakHoursFor = (id) => list.engines?.[id]?.soakHours ?? DEFAULT_SOAK_HOURS;

const HOUR_MS = 60 * 60_000;
const now = Date.now();

// One engine's verdict. `status` is the whole answer and the reason the other fields may be absent:
//   held        a maintainer stopped this engine by hand
//   unreachable upstream could not be asked, so the pin stays where it is
//   broken      nothing here can be resolved — this checkout's pins disagree, or --to named a version nobody published
//   soaking     a newer version exists but is younger than the soak window
//   current     nothing newer is published
//   ready       there is a version to take
// Only `broken` is an error; the other four are decisions not to move.

// Which published version this engine should move to, or the verdict saying why none does. Split from verdictFor so
// each reads as one decision: this one is "which version", that one is "may we look at all".
const chooseTarget = (engine, pin, published) => {
    const ahead = published.filter((entry) => isNewer(entry.version, pin.tracked));
    if (ahead.length === 0) {
        return { verdict: { id: engine.id, status: "current", from: pin.blessed } };
    }
    // A version named with --to is a deliberate pick and skips the window; the window is there for the machine's own
    // choices, not to argue with a person.
    const soakMs = soakHoursFor(engine.id) * HOUR_MS;
    const eligible = to === undefined ? ahead.filter((entry) => now - entry.at >= soakMs) : ahead.filter((entry) => entry.version === to);
    const target = eligible.at(-1);
    if (target !== undefined) {
        return { target, skipped: ahead.length - 1 };
    }
    if (to !== undefined) {
        return {
            verdict: { id: engine.id, status: "broken", problems: [`upstream publishes no ${engine.id} version ${to} newer than ${pin.tracked}`] },
        };
    }
    const youngest = ahead.at(-1);
    const ageHours = Math.round((now - youngest.at) / HOUR_MS);
    return {
        verdict: { id: engine.id, status: "soaking", from: pin.blessed, waiting: youngest.version, ageHours, soakHours: soakHoursFor(engine.id) },
    };
};

const verdictFor = async (engine) => {
    const pin = readPin(engine);
    if (pin.problems.length > 0) {
        return { id: engine.id, status: "broken", problems: pin.problems };
    }
    const hold = list.engines?.[engine.id]?.hold;
    if (typeof hold === "string" && hold !== "") {
        return { id: engine.id, status: "held", from: pin.blessed, reason: hold };
    }
    const published = await publishedVersions(engine.upstream);
    if (published === undefined) {
        return { id: engine.id, status: "unreachable", from: pin.blessed };
    }
    const { target, skipped, verdict } = chooseTarget(engine, pin, published);
    if (verdict !== undefined) {
        return verdict;
    }
    let blessed;
    try {
        blessed = await blessedFor(engine, target.version, npmManifest);
    } catch (error) {
        // A derived pin that cannot be resolved is unreachable, not a reason to write half of one.
        return { id: engine.id, status: "unreachable", from: pin.blessed, note: error.message };
    }
    return {
        id: engine.id,
        label: engine.label,
        status: "ready",
        from: pin.blessed,
        to: blessed,
        trackedFrom: pin.tracked,
        trackedTo: target.version,
        ageHours: Math.round((now - target.at) / HOUR_MS),
        skipped,
    };
};

const engines = only === undefined ? ENGINE_PINS : [enginePin(only)];
const verdicts = [];
for (const engine of engines) {
    verdicts.push(await verdictFor(engine));
}

const ready = verdicts.filter((verdict) => verdict.status === "ready");
const broken = verdicts.filter((verdict) => verdict.status === "broken");

// Nothing is written while any engine is unresolved. A checkout whose pins disagree is a tree the `engines` check is
// already refusing, and stacking a bump on top of it would bury the original skew under a second one.
const written = [];
if (apply && broken.length === 0) {
    for (const verdict of ready) {
        writePin(enginePin(verdict.id), { tracked: verdict.trackedTo, blessed: verdict.to });
        writeBlessed(verdict.id, verdict.to);
        written.push(verdict.id);
    }
}

// What each verdict reads as on one line; the same sentence in the log, the job summary and the pull request, so there
// is one account of a bump rather than three that can disagree.
const line = (verdict) => {
    switch (verdict.status) {
        case "ready": {
            const also = verdict.trackedTo === verdict.to ? "" : ` (@…-sdk ${verdict.trackedFrom} → ${verdict.trackedTo})`;
            const over = verdict.skipped === 0 ? "" : `, over ${verdict.skipped} intermediate release${verdict.skipped === 1 ? "" : "s"}`;
            return `${verdict.id}: ${verdict.from} → ${verdict.to}${also}, published ${verdict.ageHours}h ago${over}`;
        }
        case "soaking": {
            return `${verdict.id}: staying on ${verdict.from}; ${verdict.waiting} is ${verdict.ageHours}h old and soaks for ${verdict.soakHours}h`;
        }
        case "held": {
            return `${verdict.id}: held on ${verdict.from} — ${verdict.reason}`;
        }
        case "unreachable": {
            return `${verdict.id}: upstream could not be asked, staying on ${verdict.from}${verdict.note === undefined ? "" : ` (${verdict.note})`}`;
        }
        case "current": {
            return `${verdict.id}: ${verdict.from} is upstream's newest`;
        }
        default: {
            // Each problem already names itself; a shared preamble here would mislabel a bad --to as skewed pins.
            return `${verdict.id}: ${verdict.problems.join("; ")}`;
        }
    }
};

// Conventional Commits caps a subject at 100 characters, and five engines named with their versions can pass it, so a
// title that would overflow counts instead of listing — the per-engine detail is in the body either way.
const HEADER_MAX = 100;
const titleOf = () => {
    if (ready.length === 0) {
        return "chore(engines): nothing to bump";
    }
    const named = `chore(engines): bump ${ready.map((verdict) => `${verdict.id} to ${verdict.to}`).join(", ")}`;
    return named.length <= HEADER_MAX ? named : `chore(engines): bump ${ready.length} agent engines to their newest published versions`;
};
const title = titleOf();

const body = [
    ready.length === 0 ? "No engine moved." : `${apply ? "Bumped" : "Would bump"} ${ready.length} of ${verdicts.length} engines.`,
    "",
    ...verdicts.map((verdict) => `- ${line(verdict)}`),
].join("\n");

if (asJson) {
    console.log(JSON.stringify({ title, verdicts, written, ok: broken.length === 0 }, undefined, 4));
} else {
    console.log(body);
}

// Actions reads the decision from here rather than re-parsing the log; empty when this is not running in a job.
// Synchronous: the process may exit on the next statement, and a deferred write would be dropped.
const emit = (path, text) => {
    if (path !== undefined && path !== "") {
        appendFileSync(path, text);
    }
};
emit(process.env.GITHUB_STEP_SUMMARY, `### Agent engines\n\n${body}\n`);
emit(process.env.GITHUB_OUTPUT, `changed=${written.length > 0}\ntitle=${title}\nbody<<ENGINES_EOF\n${body}\nENGINES_EOF\n`);

// An engine that could not be resolved is the one failure worth stopping for: every other verdict is a decision not to
// move, which is not an error.
if (broken.length > 0) {
    console.error(`\n${broken.length} engine(s) could not be resolved; nothing was written`);
    process.exit(1);
}
