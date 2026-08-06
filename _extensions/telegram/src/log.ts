// The gateway is a standalone process (tmux captures its stdout), so a tiny console logger is enough — the
// failures that matter for the owner ride the daemon's /listeners/telegram/failure route into the activity feed.
export interface Logger {
    readonly info: (fields: object, msg: string) => void;
    readonly warn: (fields: object, msg: string) => void;
    readonly error: (fields: object, msg: string) => void;
}

export const log: Logger = {
    info: (fields, msg) => console.log(`[telegram] ${msg}`, fields),
    warn: (fields, msg) => console.warn(`[telegram] ${msg}`, fields),
    error: (fields, msg) => console.error(`[telegram] ${msg}`, fields),
};
