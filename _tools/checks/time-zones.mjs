#!/usr/bin/env node
// TIME VALUES THAT CROSS A MACHINE. This repo runs its daemon in a UTC container and its editor on whatever clock the
// reader's laptop is on, so a value that carries no zone means two different things on the two sides — silently, since
// both render a plausible number. That is not a theoretical risk: a "Daily 20:43" automation fired at 22:43 for its
// owner for as long as the feature existed, because the cron was evaluated by whichever process happened to hold it.
//
// Four rules, each the shape of a shipped defect rather than a style preference:
//
//   1. `new Cron(expr)` with no `timezone` silently means "in whatever zone this process is". Pass one.
//   2. `toLocaleDateString`/`toLocaleString`/`toLocaleTimeString` outside the kit builds an `Intl` formatter frozen at
//      module load, so its dates stay in the previous language after a language change, and it bypasses the house
//      24-hour style. The kit's formatters are reactive; use them.
//   3. Local-component reads (`getHours`, `getDate`, `setHours`, …) in DAEMON code read the container's UTC clock as
//      if it were somebody's. In browser code they are correct — that IS the reader's clock — so this is scoped.
//   4. `.toISOString().slice(0, 10)` is a UTC day bucket. Bucketing in UTC is usually RIGHT — a money log whose days
//      move when somebody changes a setting is not a log — so the rule is not "don't", it is "say so": the binding
//      it lands in, or a comment on it, has to contain the word UTC. `dateOf`/`dayOf`/`date` reads as "the day",
//      and the reader supplies their own midnight.
//
// CARVE-OUTS, which are a real part of this check rather than an apology: the browser-fingerprint files set a FAKE
// timezone on purpose, to dress a browser profile as a place it is not. A later sweep must not "fix" them.
import { readFileSync } from "node:fs";
import { finish } from "./lib/report.mjs";
import { subjectFiles } from "./lib/repo.mjs";

// The one module allowed to spell any of this: it is the definition the rest of the tree is measured against.
const SHARED_TIME = "_shared/sandbox-contract/src/time/zone.ts";
// The kit's formatter module, and the one place `toLocale*` belongs.
const KIT_FORMAT = "_editor/ui/src/lib/format.ts";
// Dressing a browser profile as somewhere it is not. Deliberate, and the opposite of every rule above.
const FINGERPRINTING = ["_sandbox/sandbox/src/browser/sessions/", "_sandbox/sandbox/src/exit/exit-countries"];
// The public site is rendered to static HTML at build time, in one language, with no reader and no kit to reach for.
// `toLocaleDateString` there is the right tool, and the reactive-formatter argument does not apply to it.
const STATIC_SITE = "_site/site/";

// Where a `Date`'s local components mean the CONTAINER's clock rather than a reader's. Browser and extension-view code
// is excluded by omission: there, local components are the reader's own clock and are the correct thing to read.
const DAEMON_ROOTS = ["_sandbox/sandbox/src/", "_platform/api/src/", "_devices/", "_deploy/"];

const LOCAL_COMPONENTS = /\.(?:get|set)(?:Hours|Minutes|Seconds|Date|Month|FullYear|Day)\(/;
const BARE_CRON = /new Cron\(\s*[^,)]+\)/;
// Dates only. `.toLocaleString()` on a NUMBER is a different subject (thousands separators) and belongs to whatever
// check owns number formatting, not this one; a bare `toLocaleString` counts only when the line also handles a Date.
const TO_LOCALE = /\.toLocale(?:Date|Time)String\(|new Date\([^)]*\)\s*\.toLocaleString\(/;
const UTC_DAY = /toISOString\(\)\s*\.\s*(?:slice|substring)\(\s*0\s*,\s*10\s*\)/;

const exempt = (path) => path === SHARED_TIME || FINGERPRINTING.some((prefix) => path.startsWith(prefix));
const isDaemon = (path) => DAEMON_ROOTS.some((prefix) => path.startsWith(prefix));
// A test may say what a wrong answer looks like; that is its job. Fixtures and assertions are not shipped behaviour.
const isTest = (path) =>
    /\.(?:test|spec|integration\.test)\.[cm]?tsx?$/.test(path) || path.includes("/testing/") || path.includes("/fixture/") || path.endsWith(".testing.ts");

const bareCron = [];
const strayLocale = [];
const containerClock = [];
const unlabelledDay = [];

const files = subjectFiles("*.ts", "*.tsx", "*.vue", "*.mts").filter((path) => !exempt(path) && !isTest(path));

for (const path of files) {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
        const at = `${path}:${index + 1}`;
        // What a finding can be answered BY: a comment on the line or in the two above it. Two, not one, because the
        // explanations worth writing here run to a sentence and wrap. The rule is "say which clock"; saying it is how
        // a line passes. `zone-checked:` is the explicit form, kept deliberately literal so it reads as a claim
        // somebody made rather than a general-purpose silencer.
        const nearby = [line, lines[index - 1] ?? "", lines[index - 2] ?? ""].join("\n");
        if (nearby.includes("zone-checked:")) {
            continue;
        }
        // PROSE IS NOT A CALL SITE. Every rule below matches source text, and the comments this repo writes quote the
        // very shapes being banned — the module that exists to give croner a zone opens by naming `new Cron(expr)` as
        // the thing it replaces. Flagging that would make the check punish the documentation it asked for.
        // A comment can still ANSWER a finding: the lookback above reads these lines, it just never fires on them.
        if (/^\s*(?:\/\/|\*|\/\*|<!--)/.test(line)) {
            continue;
        }
        if (BARE_CRON.test(line) && !line.includes("cronOptions") && !line.includes("timezone")) {
            bareCron.push(`${at}  give croner a zone (cronOptions(zoneOf(trigger, sandbox))), or it uses this process's`);
        }
        if (TO_LOCALE.test(line) && path !== KIT_FORMAT && !path.startsWith(STATIC_SITE)) {
            strayLocale.push(`${at}  format through the kit (formatDate/formatDateTime/formatDayMonth), which follows the reader's language`);
        }
        if (LOCAL_COMPONENTS.test(line) && isDaemon(path)) {
            containerClock.push(`${at}  local Date components here read the container's UTC clock, not anybody's; use civilDayIn/wallClockIn with a zone`);
        }
        // The name, or a comment on it or just above it, has to carry the word. A bucket called `utcDay` explains
        // itself at every call site; one called `dateOf` explains itself nowhere.
        if (UTC_DAY.test(line) && !/utc/i.test(nearby)) {
            unlabelledDay.push(`${at}  a UTC day bucket whose name does not say UTC; name it (utcDayOf, utcDay) or say why here`);
        }
    }
}

finish(
    [
        ["Cron evaluated in whatever zone the process happens to be in", bareCron],
        ["Date formatting outside the kit, frozen at module load", strayLocale],
        ["The container's clock read as if it were a person's", containerClock],
        ["UTC day buckets whose name does not say UTC", unlabelledDay],
    ],
    [`${files.length} files: every cron carries a zone, every date formats through the kit, every UTC bucket is named`],
);
