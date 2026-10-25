#!/usr/bin/env node
// Keep prefers-reduced-motion inside ui/motion so Appearance settings govern it; inspect app, kit and extension sources, excluding tests.
// Ban animate-* and motion-reduce: in app shell, kit and extensions (not web features); request/navigation styles must start no CSS animations.
// Skeletons use the shared SMIL sheen. CSS animation starts/stops also rebuild Chrome DevTools' Styles editor on each request.
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
