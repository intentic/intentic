import { type Role, RoleSchema } from "@intentic/sandbox-contract/schemas/roles";
import { rpcKey } from "../../../lib/queryKeys";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import type { ProcedureInput } from "../../../client/sandbox/sandboxRpc";

// Every daemon call the module made, in order, and what the fake daemon answers to the list read.
const calls = {
    made: [] as { procedure: string; input?: unknown }[],
    listed: [] as Role[],
};
const list = jest.fn(async () => {
    calls.made.push({ procedure: `roles.list` });
    return { roles: calls.listed, connected: [] };
});
const save = jest.fn(async (role: ProcedureInput<`roles.save`>) => {
    calls.made.push({ procedure: `roles.save`, input: role });
    return { ok: true as const };
});
const invalidateQueries = jest.fn(async () => undefined);
jest.mock("../../../lib/queryPersistence", () => ({ queryClient: { invalidateQueries } }));
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ roles: { list, save } }) }));

const { ensureProjectRole, projectRoleRole, projectRoleId } = await import("./projectRole");

afterEach(() => {
    calls.made = [];
    calls.listed = [];
    invalidateQueries.mockClear();
});

describe(`the project's own role`, () => {
    it(`has an id the daemon accepts whatever the folder is called, and opens in the project`, () => {
        expect(projectRoleId(`web`)).toBe(`project-web`);
        expect(projectRoleId(`tools/cli.v2`)).toBe(`project-tools-cli-v2`);
        const role = projectRoleRole(`tools/cli`);
        expect(RoleSchema.safeParse(role).success).toBe(true);
        expect(role).toMatchObject({
            label: `cli`,
            workspace: { startIn: `tools/cli` },
            context: { repos: [`tools/cli`] },
        });
    });

    it(`is written once, the first time it is needed`, async () => {
        expect(await ensureProjectRole(`web`)).toBe(`project-web`);
        expect(calls.made.map((call) => call.procedure)).toEqual([`roles.list`, `roles.save`]);
        expect(calls.made[1]?.input).toEqual(projectRoleRole(`web`));
        // The list every picker reads, so the new role shows up without a reload.
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: rpcKey(`roles.list`) });
    });

    it(`leaves an existing role alone, so the owner's edits to it survive`, async () => {
        calls.listed = [{ id: `project-web`, capabilities: [] }];
        expect(await ensureProjectRole(`web`)).toBe(`project-web`);
        expect(calls.made.map((call) => call.procedure)).toEqual([`roles.list`]);
        expect(invalidateQueries).toHaveBeenCalledTimes(0);
    });
});
