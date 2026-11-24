import { FleetConfigSchema } from "./config.js";
import { fleetUnitText, mergedConfig } from "./fleet-install.js";

/* What `ci-fleet install` writes, decided without root: the unit that runs the service and the settings it keeps. */

test("the unit runs the root-owned copy's serve, and comes back after an update's exit", () => {
    const unit = fleetUnitText();
    expect(unit).toContain("ExecStart=/usr/local/lib/intentic-ci/intentic-machine ci-fleet serve");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=multi-user.target");
});

test("a reinstall keeps the settings it is not told to change, and takes those it is", () => {
    const before = FleetConfigSchema.parse({ user: "radarsu", cacheRoot: "/srv/ci-cache", prune: { enabled: true }, slots: { usable: 9 } });
    const kept = mergedConfig(before, { user: "radarsu" });
    expect(kept).toMatchObject({ cacheRoot: "/srv/ci-cache", prune: { enabled: true }, slots: { usable: 9, total: 16, reserved: 6 } });
    const changed = mergedConfig(before, { user: "ci", prune: false, slotsUsable: 12 });
    expect(changed).toMatchObject({ user: "ci", prune: { enabled: false }, slots: { usable: 12 } });
    expect(mergedConfig(undefined, { user: "root" })).toMatchObject({ user: "root", cacheRoot: "/ci-cache", prune: { enabled: false }, keeper: { enabled: true } });
});
