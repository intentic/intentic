// A home's landed row and the commit its card files for it, read one against the other: the land the row names, the
// commit's line, and its revert, which takes each repository's commit back newest first and says what refused.
import type { GitActionResult } from "@intentic/sandbox-contract/schemas/git/git-history";
import { noticeCode } from "@intentic/sandbox-contract/events/sandbox-notice";
import type { HomeCommit } from "@intentic/sandbox-contract/schemas/agents";
import * as actualSandboxRpc from "../../client/sandbox/sandboxRpc";
import type { ProcedureInput } from "../../client/sandbox/sandboxRpc";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";

const revert = jest.fn<(input: ProcedureInput<`git.revert`>) => Promise<GitActionResult>>();
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ git: { revert } }) }));

const { commitShas, homeCommitOf, landOfRow, revertHomeCommit, reverted } = await import("./homeCommits");

const ROOT = `abc1234def5678abc1234def5678abc1234def56`;
const WEB = `fed9876cba5432fed9876cba5432fed9876cba54`;
const commit = (commits: HomeCommit[`commits`], land = `land-1`): HomeCommit => ({ land, at: 1, subject: `Add a dark mode toggle`, commits });

beforeEach(() => {
    revert.mockReset();
});

it(`reads the land a landed row names, and nothing off any other row`, () => {
    const landed = { role: `notice` as const, noticeCode: noticeCode({ code: `landed`, params: { land: `land-1` } }) };
    expect(landOfRow(landed)).toBe(`land-1`);
    expect(landOfRow({ role: `notice`, noticeCode: noticeCode({ code: `landed` }) })).toBeUndefined();
    expect(landOfRow({ role: `notice`, noticeCode: noticeCode({ code: `landHeld` }) })).toBeUndefined();
    expect(landOfRow({ role: `assistant`, noticeCode: landed.noticeCode })).toBeUndefined();
});

it(`finds the commit a land became once the card files it, and none before or for another land`, () => {
    const filed = commit([{ repo: `root`, sha: ROOT }]);
    expect(homeCommitOf({ commits: [filed] }, `land-1`)).toBe(filed);
    expect(homeCommitOf({ commits: [filed] }, `land-2`)).toBeUndefined();
    expect(homeCommitOf({}, `land-1`)).toBeUndefined();
    expect(homeCommitOf({ commits: [filed] }, undefined)).toBeUndefined();
});

it(`says one commit by its short sha, and several each by its repository`, () => {
    expect(commitShas(commit([{ repo: `root`, sha: ROOT }]))).toBe(`abc1234`);
    expect(
        commitShas(
            commit([
                { repo: `root`, sha: ROOT },
                { repo: `intentic`, sha: WEB },
            ]),
        ),
    ).toBe(`root abc1234 · intentic fed9876`);
});

it(`reverts each repository's commit newest first, and remembers the land as taken back`, async () => {
    revert.mockResolvedValue({ ok: true });
    const landed = commit(
        [
            { repo: `root`, sha: ROOT },
            { repo: `web`, sha: WEB },
        ],
        `land-3`,
    );
    expect(await revertHomeCommit(landed, undefined)).toEqual([]);
    expect(revert.mock.calls.map(([input]) => input)).toEqual([
        { repo: `web`, sha: WEB },
        { repo: `root`, sha: ROOT },
    ]);
    expect(reverted(landed)).toBe(true);
});

it(`tries every repository, and says in git's words what refused`, async () => {
    revert.mockResolvedValueOnce({ ok: false, reason: `CONFLICT (content): Merge conflict in a.ts` });
    revert.mockRejectedValueOnce(new SandboxHttpError(403, `Maintainers only.`));
    const landed = commit(
        [
            { repo: `root`, sha: ROOT },
            { repo: `web`, sha: WEB },
        ],
        `land-4`,
    );
    expect(await revertHomeCommit(landed, `box-1`)).toEqual([
        { repo: `web`, reason: `CONFLICT (content): Merge conflict in a.ts` },
        { repo: `root`, reason: `Maintainers only.` },
    ]);
    expect(revert).toHaveBeenCalledTimes(2);
    expect(reverted(landed)).toBe(false);
});
