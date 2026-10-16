import { HelloSchema, type SystemEvent, SystemEventSchema } from "../events/system-events.js";
import { daemonBelowFloor, daemonVersionOfBuild, OLDEST_SUPPORTED_DAEMON } from "./daemon-floor.js";
import { DEV_VERSION, parseVersion } from "./versions.js";

describe(`the oldest supported daemon`, () => {
    it(`names a released version`, () => {
        expect(parseVersion(OLDEST_SUPPORTED_DAEMON)?.prerelease).toEqual([]);
        expect(OLDEST_SUPPORTED_DAEMON).not.toBe(DEV_VERSION);
    });

    it(`reads the version off the head of a hello's build id`, () => {
        expect(daemonVersionOfBuild(`1.337.0:1760000000000`)).toBe(`1.337.0`);
        expect(daemonVersionOfBuild(`0.0.0:1760000000000`)).toBe(`0.0.0`);
        // A bare version, should the mtime ever go, still reads.
        expect(daemonVersionOfBuild(`1.249.0`)).toBe(`1.249.0`);
    });

    it(`reads no version where the build names none`, () => {
        expect(daemonVersionOfBuild(undefined)).toBeUndefined();
        expect(daemonVersionOfBuild(``)).toBeUndefined();
        expect(daemonVersionOfBuild(`test`)).toBeUndefined();
        expect(daemonVersionOfBuild(`:1760000000000`)).toBeUndefined();
    });

    it(`calls a release older than the floor too old, and the floor itself and anything newer supported`, () => {
        expect(daemonBelowFloor(`1.248.0`)).toBe(true);
        expect(daemonBelowFloor(`1.0.0`)).toBe(true);
        expect(daemonBelowFloor(OLDEST_SUPPORTED_DAEMON)).toBe(false);
        expect(daemonBelowFloor(`1.337.0`)).toBe(false);
        expect(daemonBelowFloor(`2.0.0`)).toBe(false);
    });

    // A checkout's build never checks for updates and has none to take; an unknown version is no evidence at all.
    it(`never calls a build from a checkout, or an unknown version, too old`, () => {
        expect(daemonBelowFloor(DEV_VERSION)).toBe(false);
        expect(daemonBelowFloor(undefined)).toBe(false);
        expect(daemonBelowFloor(`unknown`)).toBe(false);
    });
});

// WHAT KEEPS THE FLOOR HONEST. A daemon at the floor sends every /events frame with the fields it had then. A field
// made required since is one such a daemon leaves out, and the editor reads the gap as something gone wrong (a
// heartbeat with no `rev` re-reads the whole roster every two seconds). So the fields each frame requires are frozen
// here, every kind by name (the `satisfies` makes a kind left out a type error). Adding a frame kind is fine (an older
// daemon simply never sends it): add its required fields below. Making a field of an existing kind required is not:
// make it optional, or raise OLDEST_SUPPORTED_DAEMON to the first release that sends it, with a dated line saying why.
const REQUIRED_SINCE_FLOOR = {
    hello: [`kind`, `workspaceId`],
    heartbeat: [`kind`, `rev`],
    boot: [`kind`, `ready`, `startedAt`, `steps`],
    workspaceChanged: [`kind`, `paths`],
    treeChanged: [`dirs`, `from`, `generation`, `kind`],
    derivedChanged: [`kind`, `paths`],
    reposChanged: [`kind`, `repos`],
    refsChanged: [`kind`, `repos`],
    runtimeChanged: [`domains`, `kind`],
    presence: [`kind`, `users`],
    agents: [`agents`, `kind`, `rev`],
    accountUsage: [`account`, `kind`, `provider`],
    providerRefusal: [`kind`, `provider`],
} satisfies Record<SystemEvent[`kind`], readonly string[]>;

// What a frame of this kind cannot go without: every field a frame carrying nothing but its kind is refused for.
const requiredOf = (kind: string): string[] => {
    const parsed = SystemEventSchema.safeParse({ kind });
    const missing = parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0]));
    return [...new Set([`kind`, ...missing])].toSorted();
};

describe(`the /events frames a daemon at the floor sends`, () => {
    it(`require no field the floor did not send`, () => {
        for (const [kind, fields] of Object.entries(REQUIRED_SINCE_FLOOR)) {
            expect({ kind, required: requiredOf(kind) }).toEqual({ kind, required: [...fields] });
        }
    });

    // What the editor reads its verdict off: the route list, the fingerprints and the build that opens with the version.
    it(`keep the hello fields the editor gates on`, () => {
        expect(HelloSchema.keyof().options).toEqual(expect.arrayContaining([`routes`, `shapes`, `build`]));
    });
});
