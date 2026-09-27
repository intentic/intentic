import { type PushCheck, type PushChecks, pushRedOf } from "@intentic/sandbox-contract";

// WHAT A PUSH LEFT, as the review's "Pushed" note says it: the hook never refuses, so this is the one place the push
// itself is told its check let something through. Pure over the record (usePushChecks.ts reads it), in its own module
// since the read pulls in the query client.

// How much of what one push brought in its project's push red still owes; a finding since resolved or dismissed is not.
const stillOwed = (checks: PushChecks, push: PushCheck): number => {
    const owed = new Set(pushRedOf(checks.reds, push.project)?.findings.map((finding) => finding.id));
    return push.findings.filter((finding) => owed.has(finding.id)).length;
};

// What the pushes measured since `since` left owed. By time rather than by repository, since the daemon files a push
// under its project and the note is about one moment. Nothing while the record is unread.
export const leftSince = (checks: PushChecks | undefined, since: number): number =>
    checks === undefined ? 0 : checks.pushed.filter((push) => push.at >= since).reduce((total, push) => total + stillOwed(checks, push), 0);
