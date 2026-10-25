import { compareVersions, DEV_VERSION, parseVersion } from "./versions.js";

// Below this floor, show the update page; above it, use hello route/shape fingerprints to negotiate individual features.
// Raise deliberately with a dated dependency reason and first supporting release; keep COMPATIBILITY.md aligned.
// 2026-10-15: 1.249.0 supplies heartbeat roster rev, avoiding a full agents refetch every two seconds on older streams.
// daemon-floor.test.ts checks that later frames remain additive.
export const OLDEST_SUPPORTED_DAEMON = `1.249.0`;

// The version a hello's `build` names. The daemon's build id is `<version>:<newest mtime of its compiled tree>`
// (_sandbox/sandbox/src/version.ts `buildId`), and has been since 1.0.0. Undefined when there is no build, or its head is
// not a version.
export const daemonVersionOfBuild = (build: string | undefined): string | undefined => {
    const head = build?.split(`:`, 1)[0]?.trim();
    return head === undefined || head === `` || parseVersion(head) === undefined ? undefined : head;
};

// True only on evidence: a released version older than the floor. A daemon that names no version, one whose version
// does not parse, and a build from a checkout (0.0.0, which never checks for updates and has nothing to update to) are
// never too old.
export const daemonBelowFloor = (version: string | undefined, floor: string = OLDEST_SUPPORTED_DAEMON): boolean =>
    version !== undefined && version !== DEV_VERSION && parseVersion(version) !== undefined && compareVersions(version, floor) < 0;
