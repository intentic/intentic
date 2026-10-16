// The door checks, one entry per manifest id, each run by its own <check>.mjs through lib/doors.mjs. An entry names its
// subjects (`roots`, `subjects`), what it reads past as prose (`comments`), the shapes that reach past its door
// (`patterns`, a `find`), the `allow(<id>)` comment that excuses a site, a baseline where it keeps one, and its report.
import { tags } from "./lib/templates.mjs";
import { packages, TEST_FILE } from "./lib/repo.mjs";

const SURFACES = /^(?:_editor\/(?:web|desktop-app|share-view)\/src|_extensions\/[^/]+\/src)\//;
const SOURCE = /\.(?:ts|mts|tsx|js|mjs|vue)$/;
const FIXTURE = /\/(?:testing|fixtures?)\/|\.testing\.ts$|\/testing\.ts$/;
// The editor's surfaces (the web app, the desktop shell, the share view) and every extension, outside tests.
const surface = (path) => SURFACES.test(path) && SOURCE.test(path) && !TEST_FILE.test(path) && !FIXTURE.test(path);

// ONE DOOR TO THE CLIPBOARD, AND IT IS THE KIT'S. Chrome's async clipboard refuses a write from a document that does not
// have focus, with nothing said: a press in a popped-out window, written through the opener's `navigator.clipboard`,
// copies nothing. The kit's `clipboardOf(element)` asks the pressed element's own window, and `writeClipboard`,
// `readClipboard` and `useCopied` (`@intentic/ui/clipboard`; `clipboardOf` from `@intentic/extension-ui` in an
// extension) build on it, never rejecting and with one "Copied" duration.
//
// Refused in the editor's surfaces (the web app, the desktop shell, the share view) and every extension, outside tests:
// `navigator.clipboard`, optional-chained or not. A site that is right to do it says why with
// `// allow(clipboard-tiers): <reason>`.
const clipboardTiers = {
    roots: [],
    subjects: surface,
    // Prose is not a call site: the comments this repo writes quote the very shape it bans.
    comments: `lines`,
    patterns: [
        {
            // `navigator.clipboard`, optional-chained or not, and on another window's navigator too (`view.navigator.clipboard`).
            reach: /\bnavigator\??\.clipboard\b/,
            why: () => `navigator.clipboard belongs to this realm's document, which a popped-out window's press does not focus`,
        },
    ],
    report: {
        heading: `the clipboard reached directly: go through the kit (@intentic/ui/clipboard: writeClipboard, readClipboard, useCopied, clipboardOf; clipboardOf from @intentic/extension-ui in an extension), or say at the site why it must stay with \`// allow(clipboard-tiers): <reason>\``,
        vouched: ({ files }) => `${files} files in the editor's surfaces and the extensions: every clipboard call goes through the kit`,
    },
};

// The base library's labels are English and fixed ("1.4 MB", "90s"): right for the daemon and the CLIs, which have no
// reader's language, and wrong on a screen that has one.
const BASE_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@intentic\/base(?:\/[\w-]+)?["']/g;
const BASE_LABELS = new Map([
    [`sizeLabel`, `formatBytes`],
    [`briefDuration`, `formatElapsed`],
]);

// ONE FORMATTER PER CONCEPT, AND IT IS THE KIT'S. Every number and date a reader sees goes through the UI kit's
// format.ts (`@intentic/ui/format`; `@intentic/extension-ui/format` in an extension): relative time, a span of time,
// money, a count exact or compact, bytes, a percentage, a date. Each follows the language the app is in and re-renders
// when it changes, and each has one rounding rule. A hand-made formatter is how the editor came to say "2h" in a chat
// tab and "1h ago" in the Inbox for the same 90 minutes, and English in a Polish window.
//
// Refused in the editor's surfaces (the web app, the desktop shell, the share view) and every extension, outside tests:
//   1. `.toLocaleString(` / `.toLocaleDateString(` / `.toLocaleTimeString(`: the browser's language, not the app's.
//   2. `new Intl.NumberFormat(` / `new Intl.DateTimeFormat(` / `Intl.RelativeTimeFormat`: a formatter frozen where built.
//   3. `sizeLabel` / `briefDuration` imported from `@intentic/base`: fixed English labels meant for the daemon and CLIs.
//
// A site that is right to do it (a machine format, a prompt for an agent, a zone's offset) says why with
// `// allow(format-tiers): <reason>`. What could not be moved yet is counted per file in baselines/format-tiers.json,
// which may only shrink. time-zones.mjs keeps its own date rule for the rest of the repository.
const formatTiers = {
    roots: [],
    subjects: surface,
    ratchet: true,
    // Prose is not a call site: the comments this repo writes quote the very shapes it bans.
    comments: `lines`,
    // The platform's own formatters. Each one reads the BROWSER's language (or a tag spelled at the site) rather than the
    // app's, builds its formatter where it stands, and so stays in the language the page booted in after a switch.
    patterns: [
        { reach: /\.toLocale(?:Date|Time)?String\(/, why: ([call]) => `${call.slice(1, -1)}() reads the browser's language, not the app's` },
        {
            reach: /new Intl\.(?:NumberFormat|DateTimeFormat)\(/,
            why: ([call]) => `${call.slice(4, -1)} built outside the kit stays in the language it was built in`,
        },
        { reach: /\bIntl\.RelativeTimeFormat\b/, why: () => `a relative time built outside the kit: timeAgo already says it in every language` },
    ],
    find: (code, path, text) =>
        [...text.matchAll(BASE_IMPORT)].flatMap((match) =>
            match[1]
                .split(`,`)
                .map(
                    (part) =>
                        part
                            .trim()
                            .replace(/^type\s+/, ``)
                            .split(/\s+as\s+/)[0],
                )
                .filter((name) => BASE_LABELS.has(name))
                .map((name) => ({
                    index: match.index + match[0].indexOf(name),
                    why: `${name} from @intentic/base is English and fixed; the kit's ${BASE_LABELS.get(name)} follows the reader's language`,
                })),
        ),
    sort: true,
    report: {
        heading: `a number or a date formatted by hand where the reader's language should say it: use the kit's formatter (@intentic/ui/format, or @intentic/extension-ui/format in an extension: formatCount, formatCompact, formatMoney, formatElapsed, formatBytes, formatPercent, timeAgo, formatDate…), or say at the site why it must stay with \`// allow(format-tiers): <reason>\``,
        baseline: (key, count, allowed) =>
            allowed > 0 ? [`${key}: ${count} by hand, the baseline (_tools/checks/baselines/format-tiers.json) allows ${allowed}`] : [],
        vouched: ({ files }) => `${files} files in the editor's surfaces and the extensions: every number and date formats through the kit`,
    },
};

const PRIMITIVE_CODE = /\.(ts|tsx|mts|js|mjs|vue)$/;
// A suite and its fixtures stand code up by hand on purpose, and a declaration file holds no code. The repository's own
// scripts, harnesses and test runners run under plain node before anything is built, so the shared doors in
// @intentic/base are not theirs to reach.
const PRIMITIVE_EXEMPT = /(\.(test|spec|bench)\.[cm]?[jt]sx?$|(^|\/)testing\.ts$|\.testing\.ts$|\.d\.[cm]?ts$)/;
// turbo-cache runs under plain node on the CI fleet host, and extension-example's seed is copied out as a repository of
// its own: neither can reach @intentic/base.
const TOOLING = /^(_tools\/(checks|scripts|testing|oxlint|e2e|perf|constants|turbo-cache|extension-example)\/|_site\/|_[a-z]+\/[^/]+\/scripts\/)/;

// Workspace packages that depend on @intentic/base at run time: only their code can be told to import its helpers.
const BASE_USERS = packages.filter(({ pkg }) => pkg.dependencies?.[`@intentic/base`] !== undefined).map(({ name }) => `${name}/`);
const reachesBase = (path) => BASE_USERS.some((dir) => path.startsWith(dir));

// Each copy: what it matches, where it applies, which file is the door itself, and the door to name in the finding.
const COPIES = [
    {
        id: `header-only body cap`,
        // A route reading the declared length to cap a body: a chunked request declares none.
        pattern: /\.header\(\s*["'`]content-length["'`]\s*\)/gi,
        within: (path) => path.startsWith(`_sandbox/sandbox/src/`),
        door: `readBoundedJson / readBoundedText / readBoundedBytes (_sandbox/sandbox/src/http/bounded-body.ts)`,
    },
    {
        id: `local hop-by-hop list`,
        // A list of headers to drop that spells the hop-by-hop ones itself.
        pattern:
            /["'`](?:proxy-authorization|transfer-encoding)["'`][^;]{0,400}?["'`]keep-alive["'`]|["'`]keep-alive["'`][^;]{0,400}?["'`](?:proxy-authorization|transfer-encoding)["'`]/gs,
        within: (path) => path !== `_sandbox/sandbox/src/http/forward-headers.ts`,
        door: `forwardHeaders (_sandbox/sandbox/src/http/forward-headers.ts)`,
    },
    {
        id: `".." prefix containment`,
        // `relative(...).startsWith("..")` reads an entry named `..stash` as a climb out of the root.
        pattern: /\.startsWith\(\s*(["'`])\.\.\1\s*\)/g,
        within: () => true,
        door: `isInside / insideRel (@intentic/base/contained), or a segment test`,
    },
    {
        id: `inline sleep`,
        // A timer promise that ignores abort and holds the process open.
        pattern: /new Promise(?:<[^>]*>)?\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*(?:void\s+)?setTimeout\(\s*\1\b/g,
        within: () => true,
        door: `sleep (@intentic/base/async), which resolves on abort and can unref`,
    },
    {
        id: `card deadline`,
        // A card that refuses when a clock fires instead of waiting for its answer.
        pattern: /\bdeadlineMs\s*:/g,
        within: (path, text) => path.startsWith(`_sandbox/sandbox/src/`) && text.includes(`raiseRequest(`),
        door: `no deadline: a card waits (guard/card-offers.ts), and a call that cannot wait holds it with guard/held-asks.ts`,
    },
    {
        id: `raw browser storage`,
        // localStorage/sessionStorage throw where site data is off and over quota, and a key outside a declared scope
        // survives sign-out.
        pattern: /\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem|clear|key)\s*\(/g,
        within: (path) => (path.startsWith(`_editor/`) || path.startsWith(`_extensions/`)) && path !== `_editor/ui/src/lib/browserStorage.ts`,
        door: `@intentic/ui/storage, with the key declared device, account or sandbox scope`,
    },
    {
        id: `promisified execFile`,
        // The daemon has process-tiers; everywhere else the same shape kills only the child and buffers without limit.
        pattern: /\bpromisify\(\s*execFile\s*\)/g,
        within: (path) => !path.startsWith(`_sandbox/sandbox/`),
        door: `runBounded / execBounded (@intentic/base/process)`,
    },
    {
        id: `inline errorMessage`,
        // The one-line reading of a thrown value, spelled again where it is caught.
        pattern: /\binstanceof Error\s*\?\s*([\w$]+)\.message\s*:\s*(?:String\(\s*\1\s*\)|`\$\{\s*\1\s*\}`)/g,
        within: (path) => reachesBase(path) && path !== `_tools/base/src/errors.ts`,
        door: `errorMessage (@intentic/base/errors)`,
    },
    {
        id: `local isRecord`,
        // A local guard for a plain object; base's also refuses an array.
        pattern: /\b(?:const|function)\s+[\w$]+\s*=?\s*\(\s*[\w$]+\s*:\s*unknown\s*\)\s*:\s*[\w$]+\s+is\s+Record<string,\s*unknown>/g,
        within: (path) => reachesBase(path) && path !== `_tools/base/src/text/escape.ts`,
        door: `isRecord (@intentic/base/escape)`,
    },
    {
        id: `hand-rolled atomic write`,
        // A file written under one name and renamed over another: a failure leaves the staging file behind.
        pattern: /\bwriteFile(?:Sync)?\(\s*([^,]+?)\s*,[\s\S]{0,300}?\brename(?:Sync)?\(\s*\1\s*,/g,
        within: (path) => reachesBase(path) && path !== `_tools/base/src/node/fs.ts`,
        door: `writeFileAtomic / writeFileAtomicSync (@intentic/base/fs)`,
    },
];

// One door per concern (docs/architecture/conventions.md, "One door per concern"): the hand-rolled shapes that began
// most of the copies the shared mechanisms replaced, each named with the door to use instead. Read by shape, line by
// line, like the other tier checks; a comment is not a site. Standing sites are held per file in
// baselines/primitive-tiers.json, which may only shrink; a site that is right says why with
// `// allow(primitive-tiers): <reason>` (lib/allow.mjs).
const primitiveTiers = {
    roots: [`_*`],
    subjects: (path) => PRIMITIVE_CODE.test(path) && !PRIMITIVE_EXEMPT.test(path) && !TOOLING.test(path),
    ratchet: true,
    // Comments say what a shape is without being one: blank them, keeping offsets so line numbers still match.
    comments: `code`,
    patterns: COPIES.map(({ id, pattern, within, door }) => ({ reach: pattern, within, why: () => `${id}: use ${door}` })),
    report: {
        heading: `a hand-rolled copy of a job that has one shared door (docs/architecture/conventions.md, "One door per concern"), or say why with // allow(primitive-tiers): <reason>`,
        baseline: (key, count, allowed) => [`${key}: ${count} hand-rolled site(s), the baseline allows ${allowed}`],
        vouched: ({ files, standing }) => `${files} source files read: no new hand-rolled copy (${standing} standing, held by the baseline)`,
    },
};

const DAEMON = `_sandbox/sandbox/src/`;
const DAEMON_CODE = /\.(ts|mts|js|mjs)$/;
// A suite starts processes to stand the code up, and a fixture module is part of the suite.
const DAEMON_EXEMPT = /(\.(test|bench)\.[cm]?[jt]s$|(^|\/)testing\.ts$|\.testing\.ts$|\.d\.[cm]?ts$)/;

// The modules whose job is starting processes, each for a reason about what it IS, not about one call being awkward.
const SUPERVISORS = new Map([
    // spawnAs itself: the one raw spawn, which puts the child in its class before returning it.
    [`${DAEMON}workload/workload-class.ts`, `spawnAs`],
    // The tmux client every visible run, pane and session goes through; tmux, not the daemon, is those processes' parent.
    [`${DAEMON}terminal/terminal-run.ts`, `the tmux client`],
]);

// Where a daemon module starts a process by hand: a `node:child_process` spawn/exec/execFile (or a sync twin) called
// directly, or exec/execFile promisified into a local. Read by shape, like every check here: the import names which
// locals are child_process's, so an alias (`spawn as nodeSpawn`) and a namespace (`cp.spawn`) are followed, and a
// type-only import is not a use.

// The calls that start a process outside workload/run-check.ts and spawnAs.
const STARTERS = new Set([`spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync`]);

const CHILD_PROCESS_IMPORT = /import\s+(type\s+)?([^;]*?)\s+from\s+["'](?:node:)?child_process["']/g;
const escaped = (name) => name.replace(/[$]/g, `\\$&`);

// The locals one file binds to child_process's starters, and the namespaces it binds the module to.
const bindingsOf = (text) => {
    const named = new Map();
    const namespaces = [];
    for (const match of text.matchAll(CHILD_PROCESS_IMPORT)) {
        if (match[1] !== undefined) {
            continue;
        }
        const clause = match[2];
        const star = /\*\s+as\s+([\w$]+)/.exec(clause);
        if (star !== null) {
            namespaces.push(star[1]);
        }
        const fallback = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
        if (fallback !== null) {
            namespaces.push(fallback[1]);
        }
        const braces = /\{([^}]*)\}/.exec(clause);
        for (const entry of braces === null ? [] : braces[1].split(`,`)) {
            const spec = entry.trim();
            if (spec === `` || spec.startsWith(`type `)) {
                continue;
            }
            const [imported, local = imported] = spec.split(/\s+as\s+/).map((part) => part.trim());
            if (STARTERS.has(imported)) {
                named.set(local, imported);
            }
        }
    }
    return { named, namespaces };
};

// Every hand-started process in one file, read off the comment-blanked `code` by the bindings `text` imports.
const processStarts = (code, path, text) => {
    const { named, namespaces } = bindingsOf(text);
    const found = [];
    for (const [local, imported] of named) {
        // promisify(execFile) is one finding; the local it makes is that finding's, not another.
        for (const match of code.matchAll(new RegExp(String.raw`\bpromisify\(\s*${escaped(local)}\s*\)`, `g`))) {
            found.push({ index: match.index, why: `promisify(${imported})` });
        }
        for (const match of code.matchAll(new RegExp(String.raw`(?<![\w$.])${escaped(local)}\s*\(`, `g`))) {
            found.push({ index: match.index, why: `${imported}()` });
        }
    }
    for (const namespace of namespaces) {
        for (const match of code.matchAll(new RegExp(String.raw`(?<![\w$.])${escaped(namespace)}\.(\w+)\s*\(`, `g`))) {
            if (STARTERS.has(match[1])) {
                found.push({ index: match.index, why: `${match[1]}()` });
            }
        }
    }
    return found;
};

// The daemon starts a process to completion through one door: workload/run-check.ts's runCheck (its own process
// group killed whole at a deadline or an abort, in a workload class, output capped) for a command it waits on, spawnAs
// (workload/workload-class.ts) for one it supervises, and @intentic/base/git's `exec` / `forkedExec` for a short call
// (git, a probe). A hand-rolled `promisify(execFile)` or a bare `node:child_process` spawn/exec/execFile/execSync in
// _sandbox/sandbox/src is how every copy runCheck replaced began: the shell alone killed at the deadline, its children
// left holding the pipe, no class, so the work kept the daemon's own OOM rank. Standing sites are held per file in
// baselines/process-tiers.json, which may only shrink; a site that is right says why with
// `// allow(process-tiers): <reason>` (lib/allow.mjs).
const processTiers = {
    roots: [`${DAEMON}*`],
    subjects: (path) => DAEMON_CODE.test(path) && !DAEMON_EXEMPT.test(path) && !SUPERVISORS.has(path),
    ratchet: true,
    // Comment lines and blocks blanked to spaces, so prose naming a call is not one and every index keeps its line.
    comments: `leading`,
    find: processStarts,
    sort: true,
    report: {
        heading: `a process started by hand in the daemon: runCheck (workload/run-check.ts) for a command it waits on, spawnAs for one it supervises, @intentic/base/git's exec or forkedExec for a short call, or say why with // allow(process-tiers): <reason>`,
        baseline: (key, count, allowed) => [`${key}: ${count} hand-started process(es), the baseline allows ${allowed}`],
        vouched: ({ files, standing }) =>
            `${files} daemon source files read: no new hand-started process (${standing} standing, held by the baseline)`,
    },
};

// ONE WAY TO THE HOME DIRECTORY in the device agent (_devices/machine): `homeDir()` from @intentic/local-agent, which
// follows a HOME (or USERPROFILE) set after startup where `os.homedir()` is fixed at it. Three spellings of "home" once
// lived side by side there, and a test that moved HOME moved only some of them. Its tests are not read: one may reach
// the real home to compare against.
//
// This was a suite inside @intentic/machine, which ran only when that package's tests did. A check runs as the line is
// written, in whichever package the writer is working.
const homeDir = {
    roots: [`_devices/machine/src`],
    subjects: (path) => path.endsWith(`.ts`) && !path.slice(path.lastIndexOf(`/`) + 1).includes(`.test.`),
    // Every `homedir(` it spells, comments included, since the rule it carries over read the whole text.
    comments: `none`,
    allow: false,
    // `os.homedir()`, `homedir()` imported bare, and either split across a line before its parenthesis.
    patterns: [{ reach: /\bhomedir\s*\(/g, why: () => `homedir(` }],
    report: {
        heading: `the home directory reached past homeDir(): import { homeDir } from "@intentic/local-agent", which follows a HOME (or USERPROFILE) set after startup where os.homedir() is fixed at it`,
        vouched: ({ files }) => `${files} sources in _devices/machine/src: every reach for the home directory goes through homeDir()`,
    },
};

/** A status colour at an opacity, behind any variant prefixes. */
const TINT =
    /(?<![\w-])(?:[\w@[\]&>*:/-]+:)?!?(?:bg|border(?:-[xytblrse])?|ring|outline|decoration|from|via|to|shadow|fill|stroke|text|divide)-(?:success|warning|danger|info)\/\d+(?![\w/])/gu;

/** The one file allowed to spell a strength. */
const TONE_HOME = `_editor/ui/src/lib/tone.ts`;

// The app has one tone vocabulary (_editor/ui/src/lib/tone.ts), and a tone at a strength is spelled only there. Refuses
// a status colour with an opacity written anywhere else in the editor or a first-party extension: `bg-danger/10`,
// `border-warning/40`, `hover:bg-success/15`, `decoration-danger/70`. Before the kit had one, 147 of them in 78 files
// came to seven fill strengths and six rim strengths, so two boxes that both meant "danger" rarely agreed on how
// loudly. A plain ink (`text-danger`) or a solid fill (`bg-warning`) is a token, not a strength, and is not this
// gate's business.
//
// The fix is a name, not a number: `toneTint(tone, "strong" | "soft")` for a tinted box's colours, `toneWash(tone)`
// for a pill, `toneHover(tone)` for a control that turns the tone under the pointer, `diffMark(mark)` for a diff, or
// <Notice>/<StatusBadge>, which already wear them. A strength that is the component's own rather than a tone's says
// why at the site with `allow(tones): <reason>`.
const tones = {
    roots: [`_editor`, `_extensions`],
    subjects: (path) => /\.(?:vue|ts|mts)$/u.test(path) && path !== TONE_HOME && !/\.(?:test|spec)\.ts$/u.test(path) && !path.includes(`/dist/`),
    // Comments name these tokens to explain them; only code and markup count.
    comments: `markup`,
    patterns: [
        {
            reach: TINT,
            why: ([token]) =>
                `\`${token}\` writes a tone at a strength by hand: name it instead — \`toneTint(tone, "strong" | "soft")\` for a tinted box, \`toneWash(tone)\` for a pill, \`toneHover(tone)\` for a control that turns the tone under the pointer, \`diffMark(mark)\` for a diff, or <Notice>/<StatusBadge>, which wear them already (_editor/ui/src/lib/tone.ts)`,
        },
    ],
    report: {
        summary: `with tone tiers. A tone at a strength is named in tone.ts, never written as an opacity.`,
        vouched: ({ files }) => `${files} files: every tinted status colour comes from tone.ts`,
    },
};

/** The controls themselves, and the meter one of them mounts: between them they own every word below. */
const OWNERS = new Set([
    `_editor/web/src/features/chat/models/run-settings/PickerRunSettings.vue`,
    `_editor/web/src/features/chat/composer/EffortMeter.vue`,
]);

/* The two bindings of the meter, and the reason there are two: the composer keeps one beside its model pill. */
const METER_MOUNTS = new Set([
    `_editor/web/src/features/chat/models/run-settings/PickerRunSettings.vue`,
    `_editor/web/src/features/chat/composer/ComposerEffort.vue`,
]);

// The visible name of each control. Matched against the template with script, style and comments blanked, so
// prose about them stays free and only what a reader would actually SEE counts.
const LABELS = [`Reasoning effort`, `Extended thinking`, `Fast speed`];

// How a model is RUN — reasoning effort, extended thinking, speed — is one set of controls drawn by one
// component (PickerRunSettings.vue) off one derivation (pickerRunSettings.ts). Three pickers ask those
// questions: the shell's own panel, the settings page's pinned entries and the chat composer's. A fourth
// spelling is not a styling difference: the three drew their own until the shell's had segmented rows with a
// third "leave it to the model" stop where the composer's had two-state chips, so one model answered the same
// question with two instruments a chevron apart.
// 1. A run-settings label rendered by a template that is not one of the two that own it.
// 2. An <EffortMeter> mounted anywhere but the two bindings that own it.
// Exceptions: `allow(run-settings): <reason>` at the site.
const runSettings = {
    roots: [`_editor`, `_extensions`],
    subjects: (path) => path.endsWith(`.vue`),
    comments: `template`,
    // Each label's first appearance in a template, no `g`: one finding per label says the template draws it.
    patterns: LABELS.map((label) => ({
        reach: new RegExp(label),
        within: (path) => !OWNERS.has(path),
        why: () =>
            `"${label}" is a control of PickerRunSettings, the one place a model's run settings are drawn: mount <PickerRunSettings> (and \`usePickerRunSettings\` for whether your footer is earned) rather than drawing it again — its one switch, \`effort-row\`, is for a surface that already draws the meter, not for a second design`,
    })),
    find: (code, path) =>
        METER_MOUNTS.has(path)
            ? []
            : [...tags(code)]
                  .filter(({ closing, name }) => closing === `` && name === `EffortMeter`)
                  .map(({ index }) => ({
                      index,
                      why: `<EffortMeter> is bound in exactly two places — PickerRunSettings (every picker's row) and ComposerEffort (the chat's own, beside the model pill) — because the rungs a model offers and the clamp that survives a re-point are one derivation: bind it through one of those`,
                  })),
    report: {
        summary: `with the run settings. Effort, extended thinking and speed are one set of controls, drawn once.`,
        vouched: ({ files }) => `${files} templates: how a model is run is asked by one control, in one vocabulary, on every picker`,
    },
};

const RULES = {
    "clipboard-tiers": clipboardTiers,
    "format-tiers": formatTiers,
    "primitive-tiers": primitiveTiers,
    "process-tiers": processTiers,
    "home-dir": homeDir,
    tones,
    "run-settings": runSettings,
};

/** The rule for one manifest id, its `id` and `allow` filled in from it. */
export const doorRule = (id) => ({ allow: id, ...RULES[id], id });
