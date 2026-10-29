import { defaultGit, type GitRunner } from "@intentic/base/git";
import { ConversationIdSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { BranchLanding, BranchLandings } from "@intentic/sandbox-contract/schemas/git/branch-landings";
import { ORPCError } from "@orpc/server";
import { CONVERSATION_TRAILER } from "../../git-identity.js";
import { isAncestor } from "../agent-refs.js";
import { lockedBranchOf } from "../main-line-lock.js";

const PAGE_SIZE = 50;

export const branchLandings = async (dir: string, main: string, before?: string, git: GitRunner = defaultGit): Promise<BranchLandings> => {
    const mainBranch = await lockedBranchOf(main, git);
    if (mainBranch === undefined) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "this repository has no main line to compare with" });
    }
    const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    if (before !== undefined && !(await isAncestor(dir, before, head, git))) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "the branch was rewritten; refresh its landings before continuing" });
    }
    const mainHead = (await git(main, ["rev-parse", `refs/heads/${mainBranch}`])).stdout.trim();
    // NUL cannot occur in a commit message, so subjects and trailer values cannot split a record.
    const format = `%H%x00%h%x00%ct%x00%(trailers:key=${CONVERSATION_TRAILER},valueonly)%x00%s`;
    const { stdout } = await git(dir, [
        "log", "--first-parent", "-z", `--format=${format}`, `--max-count=${PAGE_SIZE + 1}`,
        `--grep=^${CONVERSATION_TRAILER}: `, ...(before === undefined ? [] : ["--skip=1"]),
        `${mainHead}..${before ?? head}`, "--",
    ]);
    const fields = stdout.split("\0");
    const commits: BranchLanding[] = [];
    let last: string | undefined;
    const records = Math.floor(fields.length / 5);
    for (let index = 0; index < Math.min(records, PAGE_SIZE); index += 1) {
        const offset = index * 5;
        const sha = fields[offset]!;
        last = sha;
        const agent = ConversationIdSchema.safeParse(fields[offset + 3]?.trim());
        if (agent.success) {
            commits.push({ sha, short: fields[offset + 1]!, at: Number(fields[offset + 2]) * 1000, agent: agent.data, subject: fields[offset + 4]! });
        }
    }
    if (records > PAGE_SIZE && last !== undefined) {
        return { mainBranch, commits, next: last };
    }
    return { mainBranch, commits };
};
