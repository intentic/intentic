import type { SandboxHandlerInput, SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { isReportedManifest } from "@intentic/sandbox-contract/state/workspace-state";
import { STATE_DIR } from "@intentic/constants";
import { refuse } from "@intentic/contract-serve";
import { demoQuiet, deskEdition, freshEdition } from "../../mode";
import { listeners } from "../board/roster";

// Settings files the sandbox could not fully read (system.manifestProblems), and the one repair a button may make:
// take a stray top-level key out, or rename it to what it was probably meant to be. The owner hand-edited the settings
// file and misspelt a key; an old capability entry carries a key no version reads any more. Quiet recordings and the
// desk carry no warnings; a fresh sandbox has written no settings yet.

type Report = SandboxHandlerOutput<`system`, `manifestProblems`>[number];

let reports: Report[] =
    demoQuiet() || deskEdition || freshEdition
        ? []
        : [
              {
                  path: `${STATE_DIR}/config/settings.json`,
                  problems: [
                      { kind: `unknownKey`, detail: `"autoLnad" is not a setting this version knows, so it is ignored.`, suggestion: `autoLand` },
                      { kind: `unknownKey`, detail: `"editorTheme" is not a setting this version knows, so it is ignored.` },
                  ],
              },
              {
                  path: `${STATE_DIR}/config/capabilities.json`,
                  problems: [{ kind: `unknownKey`, detail: `"oauthScopesV1" is not a key this version reads, so it is ignored.` }],
              },
          ];

export const manifestProblems = (): Report[] => reports;

// The detail names the key in quotes, as the daemon writes it.
const keyOf = (problem: Report[`problems`][number]): string | undefined => /^"([^"]+)"/u.exec(problem.detail)?.[1];

export const repairManifest = ({ path, key, to }: SandboxHandlerInput<`system`, `repairManifest`>): SandboxHandlerOutput<`system`, `repairManifest`> => {
    if (!isReportedManifest(path)) {
        return refuse(`not a settings file this sandbox reports on: ${path}`, 404);
    }
    const report = reports.find((candidate) => candidate.path === path);
    const problem = report?.problems.find((candidate) => candidate.kind === `unknownKey` && keyOf(candidate) === key);
    if (report === undefined || problem === undefined) {
        return refuse(`"${key}" is not in ${path} any more — it looks like it has already been fixed`, 409);
    }
    if (to !== undefined && report.problems.some((candidate) => keyOf(candidate) === to)) {
        return refuse(`${path} already has a "${to}" — remove "${key}" instead of renaming it`, 409);
    }
    const left = report.problems.filter((candidate) => candidate !== problem);
    reports = left.length === 0 ? reports.filter((candidate) => candidate !== report) : reports.map((candidate) => (candidate === report ? { ...report, problems: left } : candidate));
    for (const listener of listeners) {
        listener({ kind: `workspaceChanged`, paths: [path] });
    }
    return { ok: true };
};
