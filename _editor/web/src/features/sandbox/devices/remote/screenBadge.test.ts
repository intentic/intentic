// The connection badge: direct or relayed while live, with the round trip, frames a second and bitrate; the state
// instead while it is not; and a computer's switches as its card keeps them, one changed as the card's form would save it.
import type { MediaStats } from "../../../../models/browsers/media/frameBook";
import { configWith, switchedOn } from "./remoteSwitches";
import { screenBadge, statsLine } from "./screenBadge";

const stats: MediaStats = { fps: 60, rttMs: 18.4, kbps: 12_350, dropped: 0, width: 1920, height: 1080, scale: 1, stripes: 1 };

it("says a live picture's path and its three numbers", () => {
    expect(screenBadge({ kind: `live` }, `peer`, stats)).toMatchObject({ tone: `success`, label: `Direct`, detail: `18 ms · 60 fps · 12.3 Mb/s` });
    expect(screenBadge({ kind: `live` }, `socket`, { ...stats, kbps: 640, rttMs: undefined })).toMatchObject({
        tone: `info`,
        label: `Relayed`,
        detail: `60 fps · 640 kb/s`,
        tip: { title: `Through the sandbox`, note: `No direct path found` },
    });
    expect(statsLine(undefined)).toBeUndefined();
});

it("says the state while the picture is not live", () => {
    expect(screenBadge({ kind: `reconnecting` }, `socket`, undefined)).toMatchObject({ tone: `warning`, label: `Reconnecting…` });
    expect(screenBadge({ kind: `opening` }, `socket`, undefined)).toMatchObject({ tone: `warning`, label: `Connecting…` });
    expect(screenBadge({ kind: `failed`, reason: `rog is asleep.` }, `socket`, undefined)).toMatchObject({ tone: `danger`, label: `Not connected` });
});

it("reads a computer's remote switches off unless on, and changes one keeping every other setting", () => {
    const config = { platform: `windows`, shell: `on`, remoteView: `on`, remoteTerminal: `off`, port: 22 };
    expect([switchedOn(config, `remoteView`), switchedOn(config, `remoteControl`), switchedOn(config, `remoteTerminal`)]).toEqual([true, false, false]);
    expect(configWith(config, `remoteTerminal`, true)).toEqual({ platform: `windows`, shell: `on`, remoteView: `on`, remoteTerminal: `on`, port: `22` });
});
