import { relative } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { Diagnostic } from "./report.js";
import { fullCommandOf, planVueCheck, prepareVueCheck, type RunOptions, runVueCheck } from "./vue-check.js";
import { type VuePackage, vuePackageOf } from "./vue-project.js";

// `lsp diag` for the files of Vue packages: grouped by package, planned (vue-check.ts planVueCheck), checked with the
// package's own vue-tsc over the change's files, and said back as lines an agent reads.

export interface VueGroup {
    readonly pkg: VuePackage;
    readonly files: readonly string[];
}

export interface SplitPaths {
    readonly vue: readonly VueGroup[];
    // Paths no Vue package owns, which the native compiler checks as before.
    readonly rest: readonly string[];
}

/** `paths` split into the Vue packages that own them and the rest. */
export const splitByVuePackage = (paths: readonly string[], packageOf: (file: string) => VuePackage | undefined = vuePackageOf): SplitPaths => {
    const groups = new Map<string, { pkg: VuePackage; files: string[] }>();
    const rest: string[] = [];
    for (const path of paths) {
        const pkg = packageOf(path);
        if (pkg === undefined) {
            rest.push(path);
            continue;
        }
        const group = groups.get(pkg.dir) ?? { pkg, files: [] };
        group.files.push(path);
        groups.set(pkg.dir, group);
    }
    return { vue: [...groups.values()], rest };
};

export interface GroupReport {
    readonly lines: readonly string[];
    // True when the package was not checked (a fallback or a failure): no verdict on it.
    readonly refused: boolean;
}

const diagnosticLine = (d: Diagnostic): string => `${d.file}:${String(d.line)}:${String(d.column)}: ${d.category} TS${String(d.code)}: ${d.message}`;

const plural = (count: number, one: string): string => `${String(count)} ${one}${count === 1 ? "" : "s"}`;

/** One Vue package's verdict on `files`, as the lines `lsp diag` prints. */
export const diagnoseVueGroup = async (group: VueGroup, options: RunOptions = {}): Promise<GroupReport> => {
    const { pkg } = group;
    let prepared;
    try {
        prepared = prepareVueCheck(pkg);
    } catch (error) {
        return { lines: [`lsp: ${pkg.name}: diagnostics unavailable, its project could not be read: ${errorMessage(error)}`], refused: true };
    }
    const plan = planVueCheck(prepared.project, prepared.graph, group.files);
    const project = relative(pkg.dir, pkg.tsconfig);
    if (plan.kind === "full") {
        return {
            lines: [
                `lsp: ${pkg.name}: not checked here: ${plan.reason}. Leave it to CI, which typechecks the package on push; ` +
                    `run its full check (${fullCommandOf(pkg)}: vue-tsc over the whole package; on the editor, 7-10 minutes and 6.8 GB on an idle machine) only when asked to.`,
            ],
            refused: true,
        };
    }
    const unchecked =
        plan.unchecked.length === 0 ? [] : [`lsp: ${pkg.name}: ${plan.unchecked.map((file) => relative(pkg.dir, file)).join(", ")}: not compiled by ${project}, so not checked`];
    if (plan.kind === "none") {
        return { lines: unchecked.length === 0 ? [`lsp: ${pkg.name}: nothing in ${project} to check`] : unchecked, refused: false };
    }
    const run = await runVueCheck(prepared.project, plan.targets, options);
    if ("failure" in run) {
        return { lines: [...unchecked, `lsp: ${pkg.name}: diagnostics unavailable: ${run.failure}. Not checked: leave it to CI rather than the full check (${fullCommandOf(pkg)}), which is slower still`], refused: true };
    }
    const errors = run.diagnostics.filter((d) => d.category === "error").length;
    const outside = run.outside === 0 ? "" : `; ${plural(run.outside, "more error")} in files they import, outside the change`;
    const summary =
        `lsp: ${pkg.name}: vue-tsc checked ${plural(plan.changed.length, "changed file")} and ${plural(plan.importers, "direct importer")} ` +
        `under ${project} in ${String(Math.round(run.ms / 1000))}s: ${errors === 0 ? "no errors in them" : plural(errors, "error")}${outside}`;
    return { lines: [...run.diagnostics.map(diagnosticLine), ...unchecked, summary], refused: false };
};
