/** Adds the first significant worker checkout estimate to a workflow's persisted log. */
export const appendSpawnCostNote = (log: string[], spawnNote: string | undefined): void => {
    const costStart = spawnNote?.indexOf("Each subagent here checks out about ") ?? -1;
    if (costStart < 0 || log.some((line) => line.startsWith("Each subagent here checks out about "))) {
        return;
    }
    log.push(spawnNote?.slice(costStart) ?? "");
};
