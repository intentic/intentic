// Windows' lock screen and administrator prompts on one computer, as its remote access section offers them: which side
// of the computer the row is for, when its status is asked at all, and what the control says and offers in each state
// the computer's answer can be in, for a maintainer and for anyone else.
import type { Device } from "@intentic/sandbox-contract/schemas/devices";
import { listedDevice } from "../../../../testing/listedDevice";
import { deviceRow } from "../deviceRows";
import type { RemoteServiceState } from "./remoteApi";
import { serviceDeclined, serviceSide, serviceView, serviceWanted } from "./remoteService";

// SAFETY: a fixture's facts, holding only the field these rules read; the rest of DeviceFacts is optional to them.
const featuring = (...features: string[]) => ({ features }) as Device[`facts`];

const windows = (overrides: Partial<Device> = {}) =>
    deviceRow(
        listedDevice({ key: `rog`, label: `rog`, hostId: `rog`, online: true, platform: `windows`, facts: featuring(`remote`, `remote-service`), ...overrides }),
        undefined,
    );
const distro = deviceRow(listedDevice({ key: `rog-arch`, label: `rog`, hostId: `rog::wsl:archlinux`, online: true, platform: `linux` }), undefined);
const linux = deviceRow(listedDevice({ key: `z440`, label: `z440`, hostId: `z440`, online: true, platform: `linux`, facts: featuring(`remote`) }), undefined);

const answered = (service: Partial<RemoteServiceState> = {}) =>
    ({ kind: `answered`, service: { supported: true, installed: false, outOfDate: false, ...service } }) as const;

describe("the computer's side the row is for", () => {
    it("is its Windows side, never a distro on it, and none on a computer that is not Windows", () => {
        const rog = windows();
        expect(serviceSide([rog, distro])).toBe(rog);
        expect(serviceSide([distro])).toBeUndefined();
        expect(serviceSide([linux])).toBeUndefined();
        expect(serviceSide([windows({ hostId: undefined })])).toBeUndefined();
    });

    it("is asked about only while online, with an agent that has the service or has not said", () => {
        expect(serviceWanted(windows())).toBe(true);
        expect(serviceWanted(windows({ facts: undefined }))).toBe(true);
        expect(serviceWanted(windows({ online: false }))).toBe(false);
        expect(serviceWanted(windows({ facts: featuring(`remote`) }))).toBe(false);
    });
});

describe("what the control says and offers", () => {
    it("offers a maintainer the one change each state allows", () => {
        expect(serviceView(windows(), `rog`, answered(), false, true)).toEqual({ state: `Not set up`, muted: false, action: { change: `install`, label: `Set up` } });
        expect(serviceView(windows(), `rog`, answered({ installed: true, version: `1.430.0`, agentVersion: `1.430.0` }), false, true)).toEqual({
            state: `Set up`,
            muted: false,
            action: { change: `uninstall`, label: `Remove` },
        });
        expect(serviceView(windows(), `rog`, answered({ installed: true, outOfDate: true }), false, true)).toEqual({
            state: `Set up, older version`,
            muted: false,
            action: { change: `install`, label: `Update` },
        });
    });

    it("offers anyone below Full access nothing, only the state", () => {
        expect(serviceView(windows(), `rog`, answered({ installed: true, outOfDate: true }), false, false)).toEqual({
            state: `Set up, older version`,
            muted: false,
            action: undefined,
        });
    });

    it("says it waits on the computer's administrator while a change is asked, and offers nothing then", () => {
        expect(serviceView(windows(), `rog`, answered(), true, true)).toEqual({ state: `Waiting for the administrator’s yes on rog…`, muted: true });
    });

    it("says why nothing can be said: offline, an older agent, still asking, the sandbox's refusal, a computer without it", () => {
        expect(serviceView(windows({ online: false }), `rog`, undefined, false, true)).toEqual({ state: `rog is offline.`, muted: true });
        expect(serviceView(windows({ facts: featuring(`remote`) }), `rog`, undefined, false, true)).toEqual({
            state: `Update the agent on rog to set this up.`,
            muted: true,
        });
        expect(serviceView(windows(), `rog`, { kind: `waiting` }, false, true)).toEqual({ state: `Checking…`, muted: true });
        expect(serviceView(windows(), `rog`, { kind: `refused`, reason: `"rog" is not connected right now.` }, false, true)).toEqual({
            state: `"rog" is not connected right now.`,
            muted: true,
        });
        expect(serviceView(windows(), `rog`, answered({ supported: false }), false, true)).toEqual({ state: `Not available on this computer.`, muted: true });
    });

    it("says so when the administrator did not say yes, and nothing after a change that went through", () => {
        expect(serviceDeclined({ supported: true, installed: false, outOfDate: false, declined: true }, `rog`)).toBe(
            `The administrator’s yes wasn’t given on rog, so nothing changed.`,
        );
        expect(serviceDeclined({ supported: true, installed: true, outOfDate: false }, `rog`)).toBeUndefined();
        expect(serviceDeclined(undefined, `rog`)).toBeUndefined();
    });
});
