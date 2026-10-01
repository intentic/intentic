import type { FileClass } from "../types.js";
import { classOf } from "../workspace/scan.js";

// Class prior for natural-language answers only; exact verbs (find/refs/def) skip it, a test hit counts fully. Applied
// in fusion and again in the cross-encoder blend: that model (ms-marco, trained on web passages) scores prose, such as
// docs, changelogs and test names, above the code that answers, and without the second pass it undid the first.
const CLASS_PRIOR: Record<FileClass, number> = { src: 1, config: 0.8, tests: 0.6, docs: 0.5 };

// Machine-written files that share every query's words and answer none: lockfiles, minified bundles and their maps,
// test snapshots, vector art, env templates. Ranking only; `--only` still buckets them by classOf.
const GENERATED_PRIOR = 0.3;
const GENERATED =
    /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|mix\.lock|pubspec\.lock|Package\.resolved|packages\.lock\.json)$|\.min\.(js|css)$|\.(js|css|mjs|cjs)\.map$|(^|\/)__snapshots__\/|\.snap$|\.svg$|(^|\/)\.env(\.[\w.-]+)?$/;

export const classPrior = (path: string): number => (GENERATED.test(path) ? GENERATED_PRIOR : CLASS_PRIOR[classOf(path)]);
