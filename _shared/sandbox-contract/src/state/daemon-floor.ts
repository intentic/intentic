import { compareVersions, DEV_VERSION, parseVersion } from "./versions.js";

// THE OLDEST SANDBOX DAEMON THIS EDITOR SUPPORTS. The hosted editor deploys from every green push to main, and a
// sandbox runs whatever release it last took, so the editor always talks to daemons older than itself. Above this
// floor an older daemon is met feature by feature (the route list and shape fingerprints on its /events hello, read by
// the editor's useDaemonRoutes). Below it the editor draws one page saying the sandbox is too old and offering the
// update, instead of the faults that page would otherwise be built from.
//
// Raise it deliberately, with a dated line below naming what the editor now depends on and the first release that has
// it (`git tag --contains <sha> | sort -V | head -1`). COMPATIBILITY.md quotes the current value.
//
// 2026-10-15: 1.249.0, the first release whose /events stream carries everything the editor reads off it. The hello's
// route list and its `build`, which opens with the version (1.0.0), the hello's shape fingerprints (1.187.0), and the
// roster revision on every heartbeat (`rev`, 1.249.0). Against a daemon without `rev`, every heartbeat reads as a
// missed roster snapshot, so the editor reads GET /agents again every two seconds and logs `fleet.roster-behind`
// each time. Since 1.249.0 every frame has only gained optional fields and new kinds, which daemon-floor.test.ts
// holds to.
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
