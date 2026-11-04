// Steer captures still running, per conversation, each chained behind the one before. A steer's answer does not wait for
// its capture (steerPerson): on a loaded sandbox the git it runs (a status per repo, and a commit when anything is dirty)
// queued for seconds behind every other checkout's, and the person's message sat unanswered all that time. Chained, two
// never run git in one checkout at once, and the turn's settle waits for the last (steerCapturesSettled) before it takes
// the boxes, so a capture still running as the turn ends files its state rather than losing it. Kept here rather than
// beside the captures (agent/checkpoints/steer-checkpoints.ts), since the settle that waits on them is this unit's.
const capturing = new Map<string, Promise<void>>();

/** Runs `capture` behind any capture still running for the conversation. `capture` must not reject: it logs its own faults. */
export const captureBehind = (conversationId: string, capture: () => Promise<void>): Promise<void> => {
    const done = (capturing.get(conversationId) ?? Promise.resolve()).then(capture);
    capturing.set(conversationId, done);
    void done.then(() => {
        if (capturing.get(conversationId) === done) {
            capturing.delete(conversationId);
        }
    });
    return done;
};

/** Resolves once every steer capture started for the conversation has filed its box. */
export const steerCapturesSettled = (conversationId: string): Promise<void> => capturing.get(conversationId) ?? Promise.resolve();
