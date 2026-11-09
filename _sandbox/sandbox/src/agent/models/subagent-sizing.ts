import type { RoleAnswer } from "../../engines/role-answer.js";
import type { Services } from "../../composition.js";
import type { ChildWeight } from "../../runners/child-placement.js";
import { AgentDomainRefusedError, withAgentExecution } from "../../workload/agent-execution.js";
import { askRoleModel, roleModelIsSet } from "./role-model.js";

/* HOW HEAVY A SUBAGENT'S TASK READS (model role `subagent-sizing`), asked only when it matters: a spawned child nobody
   placed could take one of a runner's last free slots while this sandbox still has room for light work
   (runners/child-placement.ts roomContested). One cheap classification over the task its parent wrote, so the heavier
   sibling gets the runner and the one that only reads stays here. Every way it fails to answer reads heavy, which places
   the child exactly as it would be placed with no sizing at all: the helper can only keep a runner slot free, never take
   one away. */

// The task's head says what it is for; a long prompt's tail is detail the classification does not need.
const TASK_MAX_CHARS = 1_500;
// Held inside the spawn, so short: past this the child is placed as heavy, as if nobody had asked.
const SIZING_DEADLINE_MS = 4_000;

const SIZE_ANSWER = {
    what: "a HEAVY or LIGHT verdict",
    read: (reply: string): ChildWeight | undefined => {
        const word = /^\W*(heavy|light)\b/iu.exec(reply.trim())?.[1]?.toLowerCase();
        return word === "heavy" || word === "light" ? word : undefined;
    },
    unusable: (weight: ChildWeight | undefined): string | undefined => (weight === undefined ? "did not open with HEAVY or LIGHT" : undefined),
} satisfies RoleAnswer<ChildWeight | undefined>;

// The task as its parent wrote it: the prompt, and the title shown on its row where it has one.
interface SizedTask {
    readonly prompt: string;
    readonly description?: string | undefined;
}

export const sizingPrompt = (spec: SizedTask): string => {
    const task = spec.prompt.trim();
    return [
        "A coding agent is about to hand this task to a subagent. Say how much CPU and memory the subagent will need on the machine it runs on.",
        "",
        "HEAVY: it will build, compile, run test suites, type-check a project, install dependencies, or run anything else that keeps CPUs busy for minutes.",
        "LIGHT: it will mostly read, search, review, plan or write text and small edits, running nothing heavier than a search.",
        "",
        ...(spec.description === undefined ? [] : [`TITLE: ${spec.description}`]),
        "TASK:",
        "---",
        task.length <= TASK_MAX_CHARS ? task : `${task.slice(0, TASK_MAX_CHARS)}\n… (truncated)`,
        "---",
        "",
        "Answer with one word, HEAVY or LIGHT. When the task could go either way, or asks to verify its work with tests or a build, answer HEAVY.",
    ].join("\n");
};

/** The weight a child's task reads as; heavy whenever the role is off, slow, refused or answers something else. */
export const sizeChild = async (services: Services, spec: SizedTask, parentConversationId: string): Promise<ChildWeight> => {
    try {
        if (!(await roleModelIsSet(services, "subagent-sizing"))) {
            return "heavy";
        }
        const { value } = await withAgentExecution(services.agentExecution, { localCwd: services.workspace.root }, (execution) =>
            askRoleModel(services, execution, "subagent-sizing", { prompt: sizingPrompt(spec), answer: SIZE_ANSWER }, AbortSignal.timeout(SIZING_DEADLINE_MS), {
                // The task is the parent's words: a provider the shield lets read that conversation may read them here.
                conversationId: parentConversationId,
            }),
        );
        return value ?? "heavy";
    } catch (error) {
        if (error instanceof AgentDomainRefusedError) {
            throw error;
        }
        services.logger.info({ err: error, parent: parentConversationId }, "subagents: sizing did not answer, the child is placed as heavy work");
        return "heavy";
    }
};
