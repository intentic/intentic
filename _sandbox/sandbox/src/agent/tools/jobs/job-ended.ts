// Told of every background job's end once it is written down: the memory budget looks again for work held for room the
// moment one lets its memory go, rather than at its next interval (2026-10-20). In this process's memory, like the jobs.
const JOB_ENDED = new Set<() => void>();

/** Hears every background job's end; answers how to stop hearing. */
export const onJobEnded = (listener: () => void): (() => void) => {
    JOB_ENDED.add(listener);
    return () => void JOB_ENDED.delete(listener);
};

/** Tells every listener that a job ended. */
export const tellJobEnded = (): void => {
    for (const listener of JOB_ENDED) {
        listener();
    }
};
