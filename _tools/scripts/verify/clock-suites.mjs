#!/usr/bin/env node
// THE SUITES THAT MEASURE TIME, IN ZONES THAT ARE NOT UTC: ci.yml's `verify-clocks`.
//
// Every other CI job runs in a UTC container, the same clock the daemon ships on, which makes a whole class of defect
// invisible there: a cron evaluated in the process's own zone, a day bucket that is the reader's only by coincidence. So
// this runs the test files that can SEE a clock under the two extreme zones, Kiritimati (UTC+14) and Niue (UTC-11),
// where every "is it the same calendar day" question is answered both ways on the same instant.
//
// THE FILES THAT CAN SEE A CLOCK, NOT EVERY FILE. It used to run the four packages' whole suites in both zones, the web's
// 875 files among them: 47 runner-minutes a push, the largest single cost in the pipeline (2026-10-07), almost all of it
// re-running suites whose answer cannot depend on the zone. A file is selected when its own text touches dates, zones,
// crons or a fake clock (TIME below); 399 of 1887 files when this was written. What that can miss is a test that
// exercises zone-dependent code without mentioning a date anywhere in itself, so a suite whose subject is time and whose
// text is not names it in its body (a comment naming the zone is enough) to be picked up.
//
// Usage: clock-suites.mjs [--list] <package dir>...
//   --list    print what would run, run nothing
// Zones come from CLOCK_ZONES (comma-separated), defaulting to the two above. Every zone and package runs whatever the
// one before it did, so one run names every failure; the exit code is 1 if any failed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { INTEGRATION_NAME } from "../../constants/src/test-suites.mjs";

export const DEFAULT_ZONES = ["Pacific/Kiritimati", "Pacific/Niue"];

// What a test file that can observe the zone spells somewhere in itself: a Date built or read, Intl, a local-component
// getter or setter, a zone named, a cron, a fake clock, or a fixture timestamp (an ISO date-time or epoch milliseconds).
export const TIME = new RegExp(
    [
        String.raw`new Date\(`,
        String.raw`\bDate\.(?:now|UTC|parse)\b`,
        String.raw`\bIntl\.`,
        String.raw`\btoLocale(?:Date|Time)?String\b`,
        String.raw`\bgetTimezoneOffset\b`,
        String.raw`\b(?:get|set)(?:UTC)?(?:FullYear|Month|Date|Day|Hours|Minutes)\(`,
        String.raw`\btime[Zz]one\b`,
        String.raw`\bTZ\b`,
        String.raw`[Cc]ron`,
        String.raw`\bTemporal\b`,
        String.raw`\buseFakeTimers\b|\bsetSystemTime\b`,
        String.raw`\btoISOString\b`,
        String.raw`\b(?:dayOf|dateOf|midnight)\b`,
        String.raw`\d{4}-\d{2}-\d{2}T\d{2}`,
        String.raw`\b1[6-9]\d{11}\b`,
    ].join("|"),
    "u",
);

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export const timeSensitive = (text) => TIME.test(text);

// The package's tracked test files that can see a clock, as paths relative to the package (how `suites` takes them).
export const clockFiles = (dir) => {
    const listed = spawnSync("git", ["ls-files", "-z", "--", dir], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0) {
        throw new Error(`git ls-files ${dir} failed: ${listed.stderr}`);
    }
    return listed.stdout
        .split("\0")
        .filter((path) => TEST_FILE.test(path) && !path.includes("/node_modules/"))
        .filter((path) => timeSensitive(readFileSync(path, "utf8")))
        .map((path) => relative(dir, path))
        .sort();
};

const group = (title) => (process.env.GITHUB_ACTIONS === "true" ? `::group::${title}` : `== ${title}`);
const endGroup = () => (process.env.GITHUB_ACTIONS === "true" ? "::endgroup::" : "");

// A container without tzdata reports UTC whatever TZ says, and every leg would then be a slower copy of a UTC job.
const zoneTakes = (zone) => {
    const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)"], {
        encoding: "utf8",
        env: { ...process.env, TZ: zone },
    });
    return probe.stdout === zone
        ? undefined
        : `asked for ${zone} and the runtime reports ${probe.stdout || "nothing"}; tzdata is missing from the image`;
};

const main = (argv) => {
    const list = argv.includes("--list");
    const dirs = argv.filter((arg) => !arg.startsWith("--"));
    if (dirs.length === 0) {
        console.error("usage: clock-suites.mjs [--list] <package dir>...");
        return 2;
    }
    const zones = (process.env.CLOCK_ZONES ?? DEFAULT_ZONES.join(","))
        .split(",")
        .map((zone) => zone.trim())
        .filter((zone) => zone !== "");
    const selected = dirs.map((dir) => ({ dir, files: clockFiles(dir) }));
    for (const { dir, files } of selected) {
        const integration = files.filter((file) => INTEGRATION_NAME.test(file)).length;
        console.log(`${dir}: ${String(files.length)} test files can see a clock (${String(integration)} of them integration)`);
    }
    if (list) {
        for (const { dir, files } of selected) {
            for (const file of files) {
                console.log(join(dir, file));
            }
        }
        return 0;
    }
    const failed = [];
    for (const zone of zones) {
        const wrong = zoneTakes(zone);
        if (wrong !== undefined) {
            console.error(wrong);
            failed.push(`${zone}: the zone did not take`);
            continue;
        }
        for (const { dir, files } of selected) {
            if (files.length === 0) {
                continue;
            }
            console.log(group(`${zone}: ${dir}`));
            // The package's own test script, so its suites flags (a worker's size) come with it.
            const run = spawnSync("pnpm", ["--dir", dir, "run", "test", ...files], { stdio: "inherit", env: { ...process.env, TZ: zone } });
            console.log(endGroup());
            if (run.status !== 0) {
                failed.push(`${zone}: ${dir}`);
            }
        }
    }
    if (failed.length > 0) {
        console.error(`\nclock-suites: failed in ${failed.join(", ")}`);
        return 1;
    }
    console.log(`\nclock-suites: every selected suite passed in ${zones.join(" and ")}`);
    return 0;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main(process.argv.slice(2)));
}
