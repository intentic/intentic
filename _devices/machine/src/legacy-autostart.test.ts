import { windowsRunDeleteArgs } from "@intentic/local-agent";
import { LEGACY_AUTOSTART } from "./legacy-autostart.js";

/* The entries retired are named exactly as the two agents before this one registered them (commit 7c015ae734 removed
   their specs): a name off by a letter removes nothing and leaves the retired binary starting at every sign-in. */

test("the retired entries are intentic-host's and the sync mirror's, under the names they registered", () => {
    expect(LEGACY_AUTOSTART.map((spec) => [spec.id, spec.windowsRunValue, spec.launchAgent?.label])).toEqual([
        ["intentic-host", "IntenticHost", undefined],
        ["intentic-sync-mirror", "IntenticSyncMirror", "dev.intentic.sync-mirror"],
    ]);
});

// systemd units and XDG files are named by the id (`intentic-host.service`, `intentic-sync-mirror.desktop`); the
// Windows task and Run value by the run value, which is what the removal deletes.
test("removing them deletes the Run values those agents wrote", () => {
    expect(LEGACY_AUTOSTART.map((spec) => windowsRunDeleteArgs(spec)[3])).toEqual(["IntenticHost", "IntenticSyncMirror"]);
});
