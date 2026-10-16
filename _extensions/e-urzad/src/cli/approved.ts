import { type Context, required } from "./context.js";

// `e-urzad approved <id>` carried a held office act out from the agent's shell until 2026-10-15, deciding by the
// approval file's status, which any turn can write. It performs nothing now: once a person approves an office act, the
// daemon checks that yes against its own record, spends it, and hands the act to this extension's backend, which writes
// the office's answer into the approval's result. The command stays to say so to a turn an older approval still points
// here, rather than fail as an unknown command.

export const runApproved = async (_context: Context, argv: readonly string[]): Promise<void> => {
    const approvalId = required(argv[0], "the approval id (e-urzad-…)");
    throw new Error(
        `nothing was done: \`e-urzad approved\` no longer carries out office acts. Once a person approves ${approvalId} in Approvals, the sandbox carries it out itself and writes the office's answer into the approval's "result". An approval proposed before this change has no performer and is never carried out: propose the act again.`,
    );
};
