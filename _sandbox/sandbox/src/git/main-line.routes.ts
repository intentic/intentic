import { errorMessage } from "@intentic/base/errors";
import { defaultGit } from "@intentic/base/git";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { gitImplementer } from "./index.routes.js";
import { latchedMainBranch, lockedBranchOf, mainLineRefusal, mainLineStanding, staysOnMainLine } from "./main-line-lock.js";
import { liveBranchStarts } from "../conversations/land/branch/branch-repos.js";
import { healSharedCheckoutLinks, holdersOf, releaseBranch } from "../workspace/layout/worktree-links.js";

// The routes that move a shared checkout's HEAD, which stays on its main line (main-line-lock.ts): a checkout or a new
// branch switched to is refused before anything is written, and the one switch they take is back onto the main line.
// Apart from git.routes.ts the way index.routes.ts is, sharing its repo lock and scan through `MainLineRouteDeps`.

type GitImplementer = ReturnType<typeof gitImplementer>;

export interface MainLineRouteDeps {
    readonly services: Services;
    readonly repoDir: (repo: string) => Promise<string>;
    readonly onRepo: <T>(repo: string, task: (dir: string) => Promise<T>) => Promise<T>;
    readonly invalidateScan: () => void;
    readonly checkpoint?: (dir: string, label: string) => Promise<void>;
    readonly notifyWrite?: () => void;
    readonly fixedCheckout?: boolean;
}

/** The scan's question, asked of every repo on every poll: the branch it belongs on when it stands anywhere else, else
 *  undefined. The latch is kept while the repo's config file is unchanged (main-line-lock.ts latchedMainBranch). */
export const createOffMainLine =
    () =>
    async (dir: string, branch: string | undefined): Promise<string | undefined> => {
        // allow(silent-catch): a repo git cannot read locks nothing; the scan reports that repo's own error on its row.
        const locked = await latchedMainBranch(dir).catch(() => undefined);
        return locked === undefined || branch === locked ? undefined : locked;
    };

// Why the way back failed while another checkout still holds the main line, said as what it means and what to do.
export const heldElsewhereReason = (locked: string, holder: string): string =>
    `\`${locked}\` is still checked out at ${holder}, so the workspace cannot take it back. Stop or archive the conversation working there, then try again.`;

// Back onto the main line. When the switch fails, git's own listing (worktree-links.ts holdersOf) says whether a
// conversation's checkout holds the line: that one is detached in place, and the switch tried once more.
const switchBack = async (services: Services, dir: string, locked: string): Promise<void> => {
    try {
        await services.git.checkoutRef(dir, locked);
    } catch (error) {
        // allow(silent-catch): a listing git cannot give releases nothing, and the switch's own failure is the answer.
        if ((await releaseBranch(dir, locked, services.logger, defaultGit).catch(() => [])).length === 0) {
            throw error;
        }
        await services.git.checkoutRef(dir, locked);
    }
};

export const mainLineRoutes = (i: GitImplementer, deps: MainLineRouteDeps) => {
    const { services, onRepo, invalidateScan } = deps;
    const checkpoint = deps.checkpoint ?? (async (_dir: string, label: string) => { await services.history.snapshot("user", label); });
    const refuseSwitch = (): void => {
        if (deps.fixedCheckout === true) { throw new ORPCError("PRECONDITION_FAILED", { message: "Select a different branch in the workspace to switch checkouts." }); }
    };
    const moved = (): void => {
        invalidateScan();
        if (deps.notifyWrite === undefined) { services.history.notifyUserWrite(); } else { deps.notifyWrite(); }
    };
    return {
        // Said as an outcome the switcher shows rather than as a breakage, before any checkpoint is taken.
        checkout: i.checkout.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                refuseSwitch();
                const locked = await lockedBranchOf(dir);
                if (locked !== undefined && !staysOnMainLine(locked, input.ref)) {
                    return { ok: false, reason: mainLineRefusal(locked, input.ref) };
                }
                await checkpoint(dir, `before checkout ${input.ref.slice(0, 12)}`);
                await services.git.checkoutRef(dir, input.ref);
                moved();
                return { ok: true } as const;
            }),
        ),
        // Non-destructive unless it also checks out, which in a shared checkout is a move off its main line.
        createBranchAt: i.createBranchAt.handler(async ({ input }) => {
            const dir = await deps.repoDir(input.repo);
            if (input.checkout === true) { refuseSwitch(); }
            const locked = input.checkout === true ? await lockedBranchOf(dir) : undefined;
            if (locked !== undefined) {
                throw new ORPCError("PRECONDITION_FAILED", { message: mainLineRefusal(locked, input.name) });
            }
            if (input.checkout === true) {
                await checkpoint(dir, `before new branch ${input.name}`);
            }
            await services.git.createBranch(dir, input.name, input.start, input.checkout === true);
            if (input.checkout === true) {
                moved();
            }
            return { ok: true } as const;
        }),
        // The way back for a checkout something moved anyway (a raw git that went around every door). git's refusal to
        // overwrite uncommitted work is the answer's reason; a checkpoint first, as for any HEAD-mover. Two moves are
        // git's, not a person's, and are undone first: the checkout linked into a worktree's record, and the main line
        // held by a conversation's checkout (workspace/layout/worktree-links.ts).
        returnToMainLine: i.returnToMainLine.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                refuseSwitch();
                const standing = await mainLineStanding(dir);
                if (standing.on || standing.locked === undefined) {
                    return { ok: true };
                }
                await checkpoint(dir, `before returning to ${standing.locked}`);
                // Under the repo lock onRepo already holds, so the heal is called bare rather than through healShared.
                const healed = await healSharedCheckoutLinks(services.agentWorktrees, [input.repo], services.logger);
                if (healed.length > 0 && (await mainLineStanding(dir)).on) {
                    moved();
                    return { ok: true };
                }
                try {
                    await switchBack(services, dir, standing.locked);
                } catch (error) {
                    // allow(silent-catch): a listing git cannot give names no holder, and git's own words are the reason.
                    const holder = (await holdersOf(dir, standing.locked, defaultGit).catch(() => []))[0];
                    return { ok: false, reason: holder === undefined ? errorMessage(error) : heldElsewhereReason(standing.locked, holder) };
                }
                moved();
                return { ok: true };
            }),
        ),
        // A branch a live conversation was started from is where its land goes, so it stays while that conversation does.
        // The checkout the daemon keeps of one (branch-checkouts.ts) goes first, since git refuses to delete a branch
        // checked out anywhere. Touches no file of the workspace; git's unmerged-branch refusal propagates so the UI can
        // offer a forced retry.
        deleteBranch: i.deleteBranch.handler(async ({ input }) => {
            const dir = await deps.repoDir(input.repo);
            const startedHere = liveBranchStarts(services.agents).find(({ repo, branch }) => repo === input.repo && branch === input.name);
            if (startedHere !== undefined) {
                const who = startedHere.title === undefined ? "a conversation" : `“${startedHere.title}”`;
                throw new ORPCError("PRECONDITION_FAILED", {
                    message: `\`${input.name}\` is where ${who} lands its work, since it was started from it. Archive that conversation first, then delete the branch.`,
                });
            }
            await services.branchCheckouts.release(input.repo, input.name);
            await services.git.deleteBranch(dir, input.name, input.force === true);
            return { ok: true } as const;
        }),
    };
};
