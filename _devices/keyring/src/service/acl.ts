import { ADMINISTRATORS_SID, type HardenedPaths, LOCAL_SERVICE_SID, SYSTEM_SID, USERS_SID } from "./paths.js";

// The access lists hardened mode sets with icacls, every account by SID (`*S-1-…`) so a localised Windows reads them the
// same. Inheritance is cut on each so nothing the parent allows leaks in.

const grant = (sid: string, rights: string): string => `*${sid}:${rights}`;

export interface IcaclsCall {
    readonly path: string;
    readonly args: readonly string[];
}

export const hardenedAcls = (paths: HardenedPaths): readonly IcaclsCall[] => [
    // The root: SYSTEM and administrators everywhere below; the service may create its door file here; every user may
    // read the folder itself to find their marker and door, and nothing below it by this grant.
    {
        path: paths.root,
        args: ["/inheritance:r", "/grant:r", grant(SYSTEM_SID, "(OI)(CI)F"), grant(ADMINISTRATORS_SID, "(OI)(CI)F"), grant(LOCAL_SERVICE_SID, "(M)"), grant(USERS_SID, "(RX)")],
    },
    // The service's program: run by the service and by the user's session helper, replaced only by an administrator.
    {
        path: paths.bin,
        args: ["/inheritance:r", "/grant:r", grant(SYSTEM_SID, "(OI)(CI)F"), grant(ADMINISTRATORS_SID, "(OI)(CI)F"), grant(LOCAL_SERVICE_SID, "(OI)(CI)RX"), grant(USERS_SID, "(OI)(CI)RX")],
    },
    // The vault: the service's account, SYSTEM, and an elevated administrator (which takes a UAC prompt to become).
    {
        path: paths.vaultDir,
        args: ["/inheritance:r", "/grant:r", grant(SYSTEM_SID, "(OI)(CI)F"), grant(ADMINISTRATORS_SID, "(OI)(CI)F"), grant(LOCAL_SERVICE_SID, "(OI)(CI)F")],
    },
];

// The door file, set by the service that wrote it: readable by the one user it is for.
export const doorAcl = (door: string, userSid: string): IcaclsCall => ({
    path: door,
    args: ["/inheritance:r", "/grant:r", grant(SYSTEM_SID, "F"), grant(ADMINISTRATORS_SID, "F"), grant(LOCAL_SERVICE_SID, "F"), grant(userSid, "R")],
});

// The marker, readable by every user, so intentic-machine finds out hardened mode is on without reading anything else.
export const markerAcl = (marker: string): IcaclsCall => ({
    path: marker,
    args: ["/inheritance:r", "/grant:r", grant(SYSTEM_SID, "F"), grant(ADMINISTRATORS_SID, "F"), grant(USERS_SID, "R")],
});
