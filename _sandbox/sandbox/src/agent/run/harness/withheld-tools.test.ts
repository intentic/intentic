import { withheldTools } from "./withheld-tools.js";

test("every turn withholds the dead scheduler tools and the built-ins the sandbox shadows", () => {
    expect(withheldTools()).toEqual(
        expect.arrayContaining(["CronCreate", "ScheduleWakeup", "Monitor", "Workflow", "ListAgents", "EnterWorktree", "ExitWorktree", "RemoteTrigger"]),
    );
});

test("the built-ins the sandbox leans on stay with the model", () => {
    // SendMessage resumes an in-process helper; the question, plan, checklist and review tools render as cards.
    for (const kept of ["SendMessage", "Agent", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TaskCreate", "ReportFindings"]) {
        expect(withheldTools()).not.toContain(kept);
    }
});

test("the turn's own policy adds to the list, each name once", () => {
    const withheld = withheldTools(["Bash", "Monitor"]);
    expect(withheld).toContain("Bash");
    expect(withheld.filter((name) => name === "Monitor")).toHaveLength(1);
});
