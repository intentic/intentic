// The connection badge: direct or relayed while live, with the round trip, frames a second and bitrate; the state
// instead while it is not.
import type { MediaStats } from "../../../../models/browsers/media/frameBook";
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
