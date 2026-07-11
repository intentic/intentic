import type { ForgejoApi } from "./forgejo-api.js";

const notUsed = async (): Promise<never> => {
    throw new Error("forgejo-api method not stubbed in this fake");
};

// An all-throwing ForgejoApi with only the methods under test overridden. Centralizes the stub so adding a
// ForgejoApi method does not force an edit to every provider test that fakes it.
export const fakeForgejoApi = (overrides: Partial<ForgejoApi> = {}): ForgejoApi => ({
    findRepo: notUsed,
    createRepo: notUsed,
    findUser: notUsed,
    createUser: notUsed,
    findOrg: notUsed,
    createOrg: notUsed,
    findTeam: notUsed,
    createTeam: notUsed,
    addTeamMember: notUsed,
    addTeamRepo: notUsed,
    listHooks: notUsed,
    createHook: notUsed,
    updateHook: notUsed,
    latestCommit: notUsed,
    readFile: notUsed,
    commitFile: notUsed,
    setRepoSecret: notUsed,
    deleteRepo: notUsed,
    deleteFile: notUsed,
    deleteRepoSecret: notUsed,
    deleteHook: notUsed,
    deleteUser: notUsed,
    deleteOrg: notUsed,
    deleteTeam: notUsed,
    ...overrides,
});
