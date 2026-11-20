// One remote screen's connection: opened through the sandbox for the monitor asked, offered to the media path with its
// path and token, a refused token replaced, a screen the computer no longer has opened again, another monitor opened
// afresh, and the sandbox's refusal said in its own words.
import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import { effectScope, nextTick, ref } from "vue";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";
import type { MediaPicture, MediaPictureOptions } from "../../../../models/browsers/media/mediaPicture";
import type { MediaOffer } from "../../../../models/browsers/media/mediaMessages";
import type { RemoteApi, RemoteScreenGrant } from "../../../../models/sandbox/devices/remote/remoteApi";
import { useDeviceScreen } from "./useDeviceScreen";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const grant = (monitor: string, token: string): RemoteScreenGrant => ({
    session: `screen-${monitor}`,
    path: `/system/device-media/rog/screen-${monitor}`,
    token,
    expiresAt: Date.now() + 120_000,
    readOnly: false,
    iceServers: [{ urls: [`stun:stun.example:3478`] }],
});

// The media path as far as this composable drives it: what it was offered, and the hooks it was built with.
const fakePicture = () => {
    const offers: MediaOffer[] = [];
    let built: MediaPictureOptions | undefined;
    let stops = 0;
    const hello = ref<MediaPicture[`hello`][`value`]>();
    const make = (options: MediaPictureOptions): MediaPicture => {
        built = options;
        return unstubbed<MediaPicture>(`picture`, {
            hello,
            offer: (offer: MediaOffer) => void offers.push(offer),
            stop: () => void (stops += 1),
            setVisible: () => undefined,
            dispose: () => undefined,
        });
    };
    return { make, offers, hello, options: () => built!, stops: () => stops };
};

const fakeApi = (overrides: Partial<RemoteApi> = {}) => {
    const asked: string[] = [];
    let renewals = 0;
    const api: RemoteApi = {
        status: () => Promise.reject(new Error(`unexpected status`)),
        openScreen: async (_device, monitor) => {
            asked.push(`open ${monitor ?? `primary`}`);
            return grant(monitor ?? `0`, `opened-${monitor ?? `0`}`);
        },
        openTerminal: () => Promise.reject(new Error(`unexpected openTerminal`)),
        attachTerminal: () => Promise.reject(new Error(`unexpected attachTerminal`)),
        refresh: async (_device, session) => {
            renewals += 1;
            asked.push(`refresh ${session}`);
            return { token: `fresh-${renewals}`, expiresAt: Date.now() + 120_000 };
        },
        closeTerminal: async () => undefined,
        ...overrides,
    };
    return { api, asked };
};

const mount = (api: RemoteApi, monitor = ref<string | undefined>()) => {
    const picture = fakePicture();
    const scope = effectScope();
    const screen = scope.run(() => useDeviceScreen(() => `rog`, monitor, { api, base: () => `https://box.example`, picture: picture.make }))!;
    return { screen, picture, monitor, stop: () => scope.stop() };
};

it("opens the screen through the sandbox and offers its path and token to the media path, with a peer to the computer", async () => {
    const { api, asked } = fakeApi();
    const { screen, picture, stop } = mount(api);
    expect(screen.status.value).toEqual({ kind: `opening` });
    await settle();
    expect(asked).toEqual([`open primary`]);
    expect(picture.offers).toMatchObject([{ path: `/system/device-media/rog/screen-0`, token: `opened-0` }]);
    expect(screen.status.value).toEqual({ kind: `connecting` });
    expect(picture.options().peerWanted?.()).toBe(true);
    expect(picture.options().iceServers?.()).toEqual([{ urls: [`stun:stun.example:3478`] }]);
    picture.options().onHello?.({ type: `hello`, width: 1920, height: 1080, scale: 1, codec: `avc1`, readOnly: false });
    expect(screen.status.value).toEqual({ kind: `live` });
    picture.options().onDrop?.();
    expect(screen.status.value).toEqual({ kind: `reconnecting` });
    stop();
});

it("answers a refused token with a fresh one on the same path", async () => {
    const { api, asked } = fakeApi();
    const { picture, stop } = mount(api);
    await settle();
    picture.options().askFresh();
    await settle();
    expect(asked).toEqual([`open primary`, `refresh screen-0`]);
    expect(picture.offers.at(-1)).toMatchObject({ path: `/system/device-media/rog/screen-0`, token: `fresh-1` });
    stop();
});

it("opens the screen again when the computer no longer has it", async () => {
    const { api, asked } = fakeApi({ refresh: () => Promise.reject(new SandboxHttpError(404, `No screen-0 on rog.`)) });
    const { picture, stop } = mount(api);
    await settle();
    picture.options().askFresh();
    await settle();
    await settle();
    expect(asked).toEqual([`open primary`, `open primary`]);
    expect(picture.offers).toHaveLength(2);
    stop();
});

it("opens another monitor afresh when one is picked", async () => {
    const { api, asked } = fakeApi();
    const { picture, monitor, stop } = mount(api);
    await settle();
    monitor.value = `1`;
    await nextTick();
    await settle();
    expect(asked).toEqual([`open primary`, `open 1`]);
    expect(picture.offers.at(-1)).toMatchObject({ path: `/system/device-media/rog/screen-1`, token: `opened-1` });
    stop();
});

it("says the sandbox's refusal in its own words, and is read-only where the grant says so", async () => {
    const refused = mount(fakeApi({ openScreen: () => Promise.reject(new SandboxHttpError(409, `rog is asleep.`)) }).api);
    await settle();
    expect(refused.screen.status.value).toEqual({ kind: `failed`, reason: `rog is asleep.` });
    refused.stop();
    const watching = mount(fakeApi({ openScreen: async () => ({ ...grant(`0`, `t`), readOnly: true }) }).api);
    await settle();
    expect(watching.screen.readOnly.value).toBe(true);
    watching.stop();
});
