import { isAbsolute, join, normalize } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { within } from "@intentic/base/async";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { type ShellEdits, trackedCall } from "../../verification/agent-verification.js";

/* WHAT A RUNNER TURN WROTE BY SHELL, read off this sandbox's mirror once the runner delivered its branch. A local turn's
   shell-edit scan reads its own checkout after each command (agent-shell-edits.ts); a runner turn's checkout is on the
   runner, so the parent read every runner turn that edited only by shell (`sed -i`, a script) as having edited nothing.
   The runner commits what its turn left and its branch is delivered into the mirror before the turn ends
   (runner-dispatch.ts), so the turn's files are the diff between each repo's head as the turn opened (after the
   placement's anchor committed the mirror's remainder) and its head once the stream ended: two `rev-parse`s and a `diff
   --name-only` per repo, never a walk of the tree.

   When each file was written is not in it. The files no edit call named are handed to the turn's last command, the
   latest any command could have written them: a turn whose last command is a check that passed reads verified, as a
   local `sed -i … && pnpm test` does, and one whose last command is not a check reads unproven. A check that failed
   between a shell edit and a later passing check of another name is the one case this reads kinder than a local turn
   would. A runner that delivered nothing (an older one with nothing to commit, or out of reach) moves no head, and the
   turn reads as its edit calls say. */

// How long reading the delivery may hold the turn's settle; past it the edit calls alone speak, as a slow local scan does.
const READ_BUDGET_MS = 10_000;

// One repo of the mirror: its folder in the workspace ("" for the root) and the checkout the daemon keeps for it.
export interface MirrorRepo {
    readonly dir: string;
    readonly checkout: string;
}

export interface MirrorEdits {
    // The verification ledger's shell scan (frame-reducers.ts): each command's answer waits for the delivery to be read.
    readonly scan: ShellEdits;
    // Takes each relayed frame, for the paths its edit calls named.
    readonly note: (event: AgentEvent) => void;
    // Reads each repo's head as the turn opens, before its first frame.
    readonly open: () => Promise<void>;
    // Reads what was delivered and answers every scan still waiting: the turn's last command gets the delivered files no
    // edit call named, every earlier one nothing. Never rejects.
    readonly close: () => Promise<void>;
}

const headOf = async (git: GitRunner, checkout: string): Promise<string | undefined> => {
    // allow(silent-catch): a repo with no head (not cloned, not a checkout) delivers nothing to read.
    const sha = await git(checkout, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(({ stdout }) => stdout.trim(), () => "");
    return sha === "" ? undefined : sha;
};

// `root` is the tree as the runner's agent named it, which the delivered paths are joined to, as a local scan's are.
export const mirrorEdits = (repos: readonly MirrorRepo[], root: string, git: GitRunner = defaultGit): MirrorEdits => {
    const named = (path: string): string => normalize(isAbsolute(path) ? path : join(root, path));
    let opened: readonly (string | undefined)[] = [];
    // The ledger asks for each command's scan in the order its commands settled, each only once the one before it was
    // answered, so the last command is known by count: the commands settled in the frames, and the scans asked so far.
    let commands = 0;
    let asked = 0;
    let answer: ((index: number) => readonly string[]) | undefined;
    const waiting: { readonly index: number; readonly resolve: (paths: readonly string[]) => void }[] = [];
    // The calls still open, and the paths each edit call named; a settled edit's paths are its own, not the shell's.
    const calls = new Map<string, readonly string[] | undefined>();
    const edited = new Set<string>();
    const settleCall = (id: string, status: string | undefined): void => {
        if (!calls.has(id) || (status !== "completed" && status !== "failed")) {
            return;
        }
        const paths = calls.get(id);
        calls.delete(id);
        if (paths === undefined) {
            commands += 1;
        } else if (status === "completed") {
            paths.forEach((path) => edited.add(named(path)));
        }
    };
    const delivered = async (): Promise<readonly string[]> => {
        const changed = await Promise.all(
            repos.map(async (repo, index) => {
                const from = opened[index];
                const to = await headOf(git, repo.checkout);
                if (from === undefined || to === undefined || from === to) {
                    return [];
                }
                const { stdout } = await git(repo.checkout, ["diff", "--name-only", "-z", from, to]);
                return stdout.split("\0").flatMap((path) => (path === "" ? [] : [named(join(repo.dir, path))]));
            }),
        );
        return changed.flat().filter((path) => !edited.has(path));
    };
    return {
        scan: () => {
            asked += 1;
            const index = asked;
            return answer === undefined ? new Promise((resolve) => waiting.push({ index, resolve })) : Promise.resolve(answer(index));
        },
        note: (event) => {
            if (event.kind === "tool_call") {
                const call = trackedCall(event);
                if (call !== undefined) {
                    calls.set(event.id, call.kind === "edit" ? call.paths : undefined);
                    settleCall(event.id, event.status);
                }
            } else if (event.kind === "tool_call_update") {
                settleCall(event.id, event.status);
            }
        },
        open: async () => {
            opened = await Promise.all(repos.map((repo) => headOf(git, repo.checkout)));
        },
        close: async () => {
            let paths: readonly string[] = [];
            try {
                // allow(silent-catch): a delivery that could not be read attributes nothing, leaving what the edit calls said.
                paths = await within(delivered().catch(() => []), READ_BUDGET_MS, [], { unref: true });
            } finally {
                const last = commands;
                answer = (index) => (index === last ? paths : []);
                for (const scan of waiting.splice(0)) {
                    scan.resolve(answer(scan.index));
                }
            }
        },
    };
};
