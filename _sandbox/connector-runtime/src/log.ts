// A gateway is a standalone process (tmux captures its stdout), so a tiny console logger is enough — the
// failures that matter for the owner ride the daemon's /listeners/<provider>/failure route into the activity
// feed. One logger for all five connectors; only the bracket tag ever differed.
export interface Logger {
    readonly info: (fields: object, msg: string) => void;
    readonly warn: (fields: object, msg: string) => void;
    readonly error: (fields: object, msg: string) => void;
}

export const createLog = (provider: string): Logger => ({
    info: (fields, msg) => console.log(`[${provider}] ${msg}`, fields),
    warn: (fields, msg) => console.warn(`[${provider}] ${msg}`, fields),
    error: (fields, msg) => console.error(`[${provider}] ${msg}`, fields),
});
