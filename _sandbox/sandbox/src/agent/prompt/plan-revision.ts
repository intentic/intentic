// The next planning message after a rejection, carrying what the user said when they said anything. Framed, so notes
// that read like consent ("proceed", "approved with…") are never taken as leave to execute; the SDK's own plan gate
// sends the same words as its deny (agent.ts).
export const planRevision = (feedback: string | undefined): string => {
    const said = feedback?.trim();
    return said !== undefined && said !== ""
        ? `The user rejected the plan with this feedback:\n${said}\n\nRevise the plan. Still do not execute it.`
        : "The user rejected the plan. Revise it. Still do not execute it.";
};


/** Approval notes are instructions for execution, carried by the same decision as the yes. */
export const planApproval = (feedback: string | undefined): string => {
    const notes = feedback?.trim();
    return notes === undefined || notes === ""
        ? "The plan is approved: execute it now."
        : `The plan is approved. Follow these instructions while executing it:\n${notes}`;
};
