import "@intentic/testing/dom";
import { coreModelRoleEntries, type ModelRoleEntry } from "@intentic/sandbox-contract/models/model-roles";
import { effectScope, ref } from "vue";
import * as routesOriginal from "../../client/sandbox/useDaemonRoutes";

// The jobs the Models page places and a run button resolves by id: what the daemon serves, or, from a daemon older than
// `GET /settings/model-roles` (2026-11-26), the table it held, six extensions' jobs among its own.

const supported = ref(true);
jest.mock(`../../client/sandbox/useDaemonRoutes`, () => ({ ...routesOriginal, supportsRoute: () => supported.value, supportsRouteAt: () => supported.value }));

const { queryClient } = await import("../../lib/queryPersistence");
const { rpcKey } = await import("../../lib/queryKeys");
const { useModelRoles } = await import("./useModelRoles");

const AUDIT: ModelRoleEntry = {
    id: `nightly-audit`,
    label: `Nightly audits`,
    blurb: `The audit run each night.`,
    kind: `run`,
    icon: `wrench`,
    setup: `medium`,
    extension: `acme.audit`,
    enabled: false,
};

const read = (): readonly ModelRoleEntry[] | undefined => {
    const scope = effectScope(true);
    const roles = scope.run(() => useModelRoles().roles.value);
    scope.stop();
    return roles;
};

afterEach(() => {
    supported.value = true;
    queryClient.clear();
});

test(`a daemon that serves the list is read as it serves it, a switched-off extension's job included`, () => {
    const served = [...coreModelRoleEntries(), AUDIT];
    queryClient.setQueryData(rpcKey(`settings.modelRoles`), { roles: served });
    expect(read()).toEqual(served);
});

test(`a daemon older than the list gets the jobs its table held, the six extensions' among the sandbox's own`, () => {
    supported.value = false;
    const roles = read() ?? [];
    expect(roles.filter((role) => role.extension !== undefined).map((role) => [role.id, role.extension])).toEqual([
        [`pipeline-fix`, `intentic.pipelines`],
        [`deployment-fix`, `intentic.deployments`],
        [`maintenance-chore`, `intentic.maintenance`],
        [`documentation-run`, `intentic.documentation`],
        [`acceptance-run`, `intentic.acceptance`],
    ]);
    expect(roles.every((role) => role.enabled)).toBe(true);
    expect(roles.map((role) => role.id)).toContain(`refactor-run`);
    expect(roles).toHaveLength(coreModelRoleEntries().length + 6);
});
