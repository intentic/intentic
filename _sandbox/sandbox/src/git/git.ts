import { errorMessage, stderrOf } from "@intentic/base/errors";
import type { PushRefusal } from "@intentic/sandbox-contract/schemas/git/git";
import type { CommitSigner } from "../git-identity.js";

// The `-c user.*` prefix that makes `signer` the committer of the commit a command creates (panel commits,
// publish-file.ts, sequence ops), and its author too unless `signer.author` names the person behind it (`author.*`).
// A cherry-pick or rebase keeps each commit's own author whatever this says.
export const identity = (signer: CommitSigner): string[] => [
    "-c",
    `user.name=${signer.name}`,
    "-c",
    `user.email=${signer.email}`,
    ...(signer.author === undefined ? [] : ["-c", `author.name=${signer.author.name}`, "-c", `author.email=${signer.author.email}`]),
];

// Matches git's verdict prefixes (fatal/error/ERROR/warning/remote:); advice and hint lines carry none.
const VERDICT = /^(?:fatal|error|warning|remote):/i;

// Matches a commitlint finding (`✖ <text> [rule-name]`); the bracket separates it from the summary.
const COMMITLINT_FINDING = /^✖\s+(.+\[[a-z-]+\])$/;

// One line for the panel: prefers git's own stderr over execFile's message, then the last verdict line (not the last
// line, which can be a wrapped advice fragment) or the last non-empty line.
export const gitFailureReason = (error: unknown, fallback: string): string => {
    const stderr = stderrOf(error);
    return gitVerdictLine(stderr !== undefined && stderr.trim() !== "" ? stderr : errorMessage(error), fallback);
};

// The same reading for text with no exception object: the combined stdout/stderr tail a terminal run hands back
// (git/push-run.ts).
const gitVerdictLine = (text: string, fallback: string): string => {
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    // Every finding, not just the last: a message can break two commitlint rules at once.
    const findings = lines.map((line) => COMMITLINT_FINDING.exec(line)?.[1]).filter((finding) => finding !== undefined);
    if (findings.length > 0) {
        return findings.join("; ");
    }
    return lines.findLast((line) => VERDICT.test(line)) ?? lines.at(-1) ?? fallback;
};

// Which of three things refused a push (PushRefusalSchema), read off git's transcript:
// - remote: a rejected ref status line (`! [rejected] ...` or `! [remote rejected] ...`), exit 1
// - transport: a `fatal:` before any ref is discussed, exit 128
// - hook: whatever the hook printed, then git's own `error: failed to push some refs to '…'`, exit 1
const REJECTED_REF = /^\s*(!\s+\[(?:remote )?rejected\].*)$/m;
const FATAL_EXIT = 128;
export const pushRefusal = (output: string, exitCode: number | undefined): PushRefusal => {
    if (REJECTED_REF.test(output)) {
        return "remote";
    }
    if (exitCode === FATAL_EXIT || /^fatal:/i.test(gitVerdictLine(output, ""))) {
        return "transport";
    }
    return "hook";
};

// The one line worth showing: for a remote-rejected ref, the ref status line (which names the reason in brackets);
// otherwise the same verdict line gitVerdictLine already reads.
export const pushRefusalReason = (output: string, fallback: string): string => {
    const rejected = REJECTED_REF.exec(output)?.[1];
    return rejected === undefined ? gitVerdictLine(output, fallback) : rejected.replaceAll(/\s+/g, " ").trim();
};
