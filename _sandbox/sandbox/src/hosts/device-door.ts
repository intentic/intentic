import { randomBytes } from "node:crypto";

// The grant a run the owner started from the editor (`runs.start`) carries in its terminal: one computer, while the run
// lasts. The door that reads it, beside a live turn's mounts, is device-door.routes.ts.

// How long an owner's run may keep acting on its computer: a build and a session of looking at the app, not a standing
// key. The run's own end revokes it sooner.
const RUN_GRANT_MS = 4 * 60 * 60 * 1000;

export interface RunGrants {
    readonly mint: (device: string) => string;
    readonly allows: (grant: string, device: string) => boolean;
    readonly revoke: (grant: string) => void;
}

export const createRunGrants = (now: () => number = Date.now): RunGrants => {
    const grants = new Map<string, { readonly device: string; readonly until: number }>();
    return {
        mint: (device) => {
            const grant = randomBytes(24).toString("hex");
            grants.set(grant, { device, until: now() + RUN_GRANT_MS });
            return grant;
        },
        allows: (grant, device) => {
            const held = grants.get(grant);
            if (held === undefined) {
                return false;
            }
            if (held.until < now()) {
                grants.delete(grant);
                return false;
            }
            return held.device === device;
        },
        revoke: (grant) => void grants.delete(grant),
    };
};
