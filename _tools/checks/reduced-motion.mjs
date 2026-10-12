#!/usr/bin/env node
// REQUEST AND ROUTE ACTIVITY MUST NOT START CSS ANIMATIONS: Chrome DevTools rebuilds an open Styles editor whenever one
// starts or stops, and a skeleton or a spinner starts on every request. And the reader's motion is decided in one place,
// @intentic/ui/motion, which follows the Appearance setting instead of asking the OS behind its back.
//
// Over what a user sees: the web app, the kit it draws with, and every extension's src, since an extension's spinner is
// as much the app's motion as its own. Tests are not read.
//   1. `prefers-reduced-motion` only in the motion module (_editor/ui/src/motion/), in scripts and stylesheets alike:
//      anywhere else it answers to the OS, so the setting's On would not move it and its Off would not still it.
//   2. no `animate-*` utility, and 3. no per-call-site `motion-reduce:` variant, in the app shell (_editor/web/src/app/),
//      the kit and the extensions. That is the scope the rule was written with; the app's features/ are not held to it.
//   4. the skeleton placeholder (utilities.css) is a background colour masked by a SMIL sheen in every scheme, never a
//      CSS animation, and the stylesheets driven by request or navigation state start none either.
//
// This was a suite inside @intentic/web, which ran only when that package's tests did, and never for an edit to the kit
// or an extension.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { animationClasses, cssAnimations, motionAskers, motionReduceVariants, skeletonProblems } from "./lib/reduced-motion.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles, subjectScope } from "./lib/repo.mjs";

const EDITOR = /^(?:_editor\/web\/src|_editor\/ui\/src|_extensions\/[^/]+\/src)\//;
const SHELL_KIT_EXTENSIONS = /^(?:_editor\/web\/src\/app|_editor\/ui\/src|_extensions\/[^/]+\/src)\//;
// The one place the OS is asked: choice.ts and loops.ts.
const MOTION_MODULE = "_editor/ui/src/motion/";
const UTILITIES = "_editor/ui/src/styles/utilities.css";
const REQUEST_DRIVEN = ["_editor/ui/src/styles/press.css", "_editor/ui/src/styles/file-viewer.css", "_editor/web/src/features/workspace/explorer/WorkspaceTree.vue"];

const subjects = subjectFiles("_editor/web/src", "_editor/ui/src", "_extensions").filter((path) => EDITOR.test(path) && !path.endsWith(".test.ts"));
const text = new Map(subjects.map((path) => [path, readFileSync(join(root, path), "utf8")]));
const sites = (paths, rule) => paths.flatMap((path) => rule(text.get(path)).map(({ line, match }) => ({ path, line, match })));

const askers = sites(
    subjects.filter((path) => /\.(?:ts|vue|css)$/.test(path) && !path.startsWith(MOTION_MODULE)),
    motionAskers,
).map(({ path, line }) => `${path}:${line}`);
const sources = subjects.filter((path) => SHELL_KIT_EXTENSIONS.test(path) && /\.(?:ts|vue)$/.test(path));
const classes = sites(sources, animationClasses).map(({ path, line, match }) => `${path}:${line} ${match}`);
const variants = sites(sources, motionReduceVariants).map(({ path, line }) => `${path}:${line}`);

// The two named-file rules: a file in scope is judged, and one gone from the tree is the rule pointing at nothing.
const gone = (path) => (subjectScope() === undefined ? [`${path} is no longer in the tree: point the rule at where it moved`] : []);
const placeholders = [
    ...(text.has(UTILITIES) ? skeletonProblems(text.get(UTILITIES)).map((problem) => `${UTILITIES}: ${problem}`) : gone(UTILITIES)),
    ...REQUEST_DRIVEN.flatMap((path) =>
        text.has(path) ? cssAnimations(text.get(path)).map(({ line }) => `${path}:${line} starts motion from request or navigation state`) : gone(path),
    ),
];

finish(
    [
        [`reduced motion asked of the OS outside @intentic/ui/motion, where the Appearance setting cannot reach it: read \`data-motion\` (motion.css) instead`, askers],
        [`a CSS animation utility in the app shell, the kit or an extension: draw the motion as SMIL or through @intentic/ui/motion's loops`, classes],
        [`motion-reduce: at a call site: it belongs in utilities.css, where the answer is made once for every component`, variants],
        [`a request-backed placeholder or effect started as a CSS animation`, placeholders],
    ],
    [
        `${subjects.length} editor, kit and extension sources: motion asked of the OS only in @intentic/ui/motion, no CSS animation utility or motion-reduce: variant in the app shell, the kit or an extension, and placeholders move by SMIL`,
    ],
);
