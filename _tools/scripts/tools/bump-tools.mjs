#!/usr/bin/env node
// THE THING THAT KEEPS THE SANDBOX IMAGE'S TOOL PINS FROM GOING STALE. Asks upstream what each pinned tool has published
// (tool-pins.mjs lists them and every place each is written), takes the newest stable release that has aged past its
// soak window, fetches what the pin derives from it (checksums, an image digest), and rewrites every site. It verifies
// nothing and decides nothing is safe: CI does that, on the pull request .github/workflows/tools.yml opens from what
// this wrote, and the image build is what proves a checksum. The engines bumper (_tools/scripts/engines) is the same
// loop for the agent engines; this is its sibling for everything else the image downloads at a fixed version.
//
//   node _tools/scripts/tools/bump-tools.mjs                   what would move, and why the rest would not
//   node _tools/scripts/tools/bump-tools.mjs --json            the same, for a machine
//   node _tools/scripts/tools/bump-tools.mjs --apply           write the pins
//   node _tools/scripts/tools/bump-tools.mjs --apply --tool=gh --to=2.103.0
//
// A tool upstream could not be reached for, or whose derived values could not be fetched, is reported and left alone.

import { appendFileSync } from "node:fs";
import { compareVersions, isNewer, publishedVersions } from "../engines/upstream.mjs";
import { DEFAULT_SOAK_HOURS, TOOL_PINS, readToolPin, toolPin, writeToolPin } from "./tool-pins.mjs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

const apply = has("--apply");
const asJson = has("--json");
const only = value("--tool");
const to = value("--to");

if (to !== undefined && only === undefined) {
    console.error("--to names one version, so it needs --tool to say whose");
    process.exit(2);
}
if (only !== undefined && toolPin(only) === undefined) {
    console.error(`no tool called ${only}; this repo pins ${TOOL_PINS.map((tool) => tool.id).join(", ")}`);
    process.exit(2);
}

const HOUR_MS = 60 * 60_000;
const now = Date.now();
const majorOf = (version) => version.split(".")[0];

// One tool's verdict; `status` is the whole answer:
//   held        a maintainer stopped this tool by hand (`hold` in tool-pins.mjs)
//   unreachable upstream, or something the pin derives from, could not be asked, so the pin stays where it is
//   broken      this checkout's sites disagree, or --to named a version nobody published
//   soaking     a newer release exists but is younger than the soak window
//   waiting     a newer release has soaked but is not installable yet (Docker's apt repository lags its tags), or is
//               a new major this tool is held below
//   current     nothing newer is published
//   ready       there is a version to take
// Only `broken` is an error; the rest are decisions not to move.
const chooseTarget = (tool, from, published) => {
    const ahead = published.filter((entry) => isNewer(entry.version, from));
    if (ahead.length === 0) {
        return { verdict: { id: tool.id, status: "current", from } };
    }
    if (to !== undefined) {
        const named = ahead.find((entry) => entry.version === to);
        return named === undefined
            ? { verdict: { id: tool.id, status: "broken", problems: [`upstream publishes no ${tool.id} version ${to} newer than ${from}`] } }
            : { target: named, skipped: 0 };
    }
    const sameMajor = tool.withinMajor === true ? ahead.filter((entry) => majorOf(entry.version) === majorOf(from)) : ahead;
    const soakHours = tool.soakHours ?? DEFAULT_SOAK_HOURS;
    const eligible = sameMajor.filter((entry) => now - entry.at >= soakHours * HOUR_MS);
    const target = eligible.at(-1);
    if (target !== undefined) {
        return { target, skipped: sameMajor.filter((entry) => compareVersions(entry.version, target.version) < 0).length };
    }
    if (sameMajor.length === 0) {
        return { verdict: { id: tool.id, status: "waiting", from, note: `${ahead.at(-1).version} is a new major; take it with --to` } };
    }
    const youngest = sameMajor.at(-1);
    return {
        verdict: { id: tool.id, status: "soaking", from, waiting: youngest.version, ageHours: Math.round((now - youngest.at) / HOUR_MS), soakHours },
    };
};

const verdictFor = async (tool) => {
    const pin = readToolPin(tool);
    if (pin.problems.length > 0) {
        return { id: tool.id, status: "broken", problems: pin.problems };
    }
    if (typeof tool.hold === "string" && tool.hold !== "") {
        return { id: tool.id, status: "held", from: pin.version, reason: tool.hold };
    }
    const published = await publishedVersions(tool.upstream);
    if (published === undefined) {
        return { id: tool.id, status: "unreachable", from: pin.version };
    }
    const { target, skipped, verdict } = chooseTarget(tool, pin.version, published);
    if (verdict !== undefined) {
        return verdict;
    }
    const missing = tool.available === undefined ? undefined : await tool.available(target.version);
    if (missing !== undefined) {
        return { id: tool.id, status: "waiting", from: pin.version, note: missing };
    }
    const derived = tool.derive === undefined ? {} : await tool.derive(target.version);
    if (derived === undefined) {
        return { id: tool.id, status: "unreachable", from: pin.version, note: `what ${target.version}'s pin derives from could not be fetched` };
    }
    return {
        id: tool.id,
        label: tool.label,
        status: "ready",
        from: pin.version,
        to: target.version,
        derived,
        ageHours: Math.round((now - target.at) / HOUR_MS),
        skipped,
    };
};

const tools = only === undefined ? TOOL_PINS : [toolPin(only)];
const verdicts = [];
for (const tool of tools) {
    verdicts.push(await verdictFor(tool));
}

const ready = verdicts.filter((verdict) => verdict.status === "ready");
const broken = verdicts.filter((verdict) => verdict.status === "broken");

// Nothing is written while any tool is unresolved: a checkout whose sites disagree is one the `tool-pins` check already
// refuses, and a bump on top of it would bury that skew under a second one.
const written = [];
if (apply && broken.length === 0) {
    for (const verdict of ready) {
        writeToolPin(toolPin(verdict.id), { version: verdict.to, ...verdict.derived });
        written.push(verdict.id);
    }
}

const line = (verdict) => {
    switch (verdict.status) {
        case "ready": {
            const over = verdict.skipped === 0 ? "" : `, over ${verdict.skipped} intermediate release${verdict.skipped === 1 ? "" : "s"}`;
            const extra = Object.keys(verdict.derived).length === 0 ? "" : ` (with ${Object.keys(verdict.derived).join(", ")})`;
            return `${verdict.id}: ${verdict.from} → ${verdict.to}${extra}, published ${verdict.ageHours}h ago${over}`;
        }
        case "soaking": {
            return `${verdict.id}: staying on ${verdict.from}; ${verdict.waiting} is ${verdict.ageHours}h old and soaks for ${verdict.soakHours}h`;
        }
        case "waiting": {
            return `${verdict.id}: staying on ${verdict.from}; ${verdict.note}`;
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
            return `${verdict.id}: ${verdict.problems.join("; ")}`;
        }
    }
};

// Conventional Commits caps a subject at 100 characters; past it the title counts instead of listing.
const HEADER_MAX = 100;
const titleOf = () => {
    if (ready.length === 0) {
        return "chore(tools): nothing to bump";
    }
    const named = `chore(tools): bump ${ready.map((verdict) => `${verdict.id} to ${verdict.to}`).join(", ")}`;
    return named.length <= HEADER_MAX ? named : `chore(tools): bump ${ready.length} sandbox image tools to their newest releases`;
};
const title = titleOf();

const body = [
    ready.length === 0 ? "No tool moved." : `${apply ? "Bumped" : "Would bump"} ${ready.length} of ${verdicts.length} tools.`,
    "",
    ...verdicts.map((verdict) => `- ${line(verdict)}`),
].join("\n");

if (asJson) {
    console.log(JSON.stringify({ title, verdicts, written, ok: broken.length === 0 }, undefined, 4));
} else {
    console.log(body);
}

// Synchronous: the process may exit on the next statement, and a deferred write would be dropped.
const emit = (path, text) => {
    if (path !== undefined && path !== "") {
        appendFileSync(path, text);
    }
};
emit(process.env.GITHUB_STEP_SUMMARY, `### Sandbox image tools\n\n${body}\n`);
// `written` names the tools that moved, so the workflow re-resolves the lockfile only when pnpm itself did.
emit(process.env.GITHUB_OUTPUT, `changed=${written.length > 0}\nwritten=${written.join(",")}\ntitle=${title}\nbody<<TOOLS_EOF\n${body}\nTOOLS_EOF\n`);

if (broken.length > 0) {
    console.error(`\n${broken.length} tool(s) could not be resolved; nothing was written`);
    process.exit(1);
}
