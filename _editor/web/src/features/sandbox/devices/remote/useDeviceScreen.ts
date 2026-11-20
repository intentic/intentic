import { errorMessage } from "@intentic/base/errors";
import { computed, type ComputedRef, onScopeDispose, ref, type Ref, shallowRef, watch } from "vue";
import { currentSandboxTarget } from "../../../../client/sandbox/sandboxTarget";
import { webTransportDeclared } from "../../../../client/transport/declared";
import { mediaPicture, type MediaPicture, type MediaPictureOptions } from "../../../../models/browsers/media/mediaPicture";
import { type RemoteApi, type RemoteIceServer, type RemoteScreenGrant, sessionGone } from "../../../../models/sandbox/devices/remote/remoteApi";
import { tokenKeeper } from "../../../../models/sandbox/devices/remote/remoteToken";
import { onScreen } from "../../../../workbench/window/onScreen";

// ONE REMOTE SCREEN, LIVE: a connected computer's monitor on the media path the editor already draws castd's pictures
// with (mediaPicture.ts: the decode worker, the cursor, sound, the clipboard, the stats). The sandbox opens the screen
// (`openScreen`, for one monitor) and hands back the media socket's path and a short-lived token; the token is renewed
// before it lapses and handed to the open socket, and one the computer refuses (4001, 4002) is replaced before the next
// dial. A peer connection straight to the computer is offered beside the socket with the STUN servers the sandbox
// named, so the picture goes P2P where both networks allow and through the sandbox where they do not. The socket's own
// ladder redials a drop; a screen the computer no longer has (remoted restarted) is opened again.

export type ScreenStatus =
    // Asking the sandbox for the screen, then dialling the computer.
    | { readonly kind: `opening` | `connecting` }
    | { readonly kind: `live` }
    // The picture dropped and its socket is dialling again.
    | { readonly kind: `reconnecting` }
    // The sandbox refused, or this browser cannot draw the stream: in a sentence for the person.
    | { readonly kind: `failed`; readonly reason: string };

export interface DeviceScreen {
    readonly status: Ref<ScreenStatus>;
    readonly picture: MediaPicture;
    readonly grant: Ref<RemoteScreenGrant | undefined>;
    // Watching only: the sandbox's grant or the computer's own hello says this person may not drive.
    readonly readOnly: ComputedRef<boolean>;
    // Opens the screen again from the start: the reconnect button, and a failure's retry.
    readonly reopen: () => void;
}

export interface DeviceScreenSeams {
    readonly api: RemoteApi;
    readonly base?: () => string | undefined;
    readonly picture?: (options: MediaPictureOptions) => MediaPicture;
}

// The sandbox's STUN (or TURN) server as RTCPeerConnection takes it.
const iceServer = (server: RemoteIceServer): RTCIceServer => {
    const ice: RTCIceServer = { urls: [...server.urls] };
    if (server.username !== undefined) {
        ice.username = server.username;
    }
    if (server.credential !== undefined) {
        ice.credential = server.credential;
    }
    return ice;
};

export const useDeviceScreen = (device: () => string, monitor: Ref<string | undefined>, seams: DeviceScreenSeams): DeviceScreen => {
    const { api } = seams;
    const status = ref<ScreenStatus>({ kind: `opening` });
    const grant = shallowRef<RemoteScreenGrant | undefined>();
    // Counts opens, so the answer to one the person has since replaced (another monitor) is dropped.
    let opens = 0;

    const offer = (token: string, expiresAt: number): void => {
        const held = grant.value;
        if (held !== undefined) {
            picture.offer({ path: held.path, token, expiresAt });
        }
    };
    const keeper = tokenKeeper({
        refresh: () => api.refresh(device(), grant.value?.session ?? ``),
        renewed: (token) => offer(token.token, token.expiresAt),
    });

    const open = async (): Promise<void> => {
        opens += 1;
        const mine = opens;
        picture.stop();
        status.value = { kind: `opening` };
        try {
            const opened = await api.openScreen(device(), monitor.value);
            if (mine !== opens) {
                return;
            }
            grant.value = opened;
            keeper.take(opened);
            status.value = { kind: `connecting` };
            offer(opened.token, opened.expiresAt);
        } catch (error) {
            if (mine === opens) {
                status.value = { kind: `failed`, reason: errorMessage(error) };
            }
        }
    };

    // The socket was refused for its token: a fresh one, or the screen opened again where the computer no longer has it.
    const askFresh = async (): Promise<void> => {
        try {
            offer(await keeper.fresh(), Date.now());
        } catch (error) {
            // allow(silent-catch): any other refusal leaves the socket's own ladder to dial again with what it holds.
            if (error instanceof Error && sessionGone(error)) {
                void open();
            }
        }
    };

    const picture = (seams.picture ?? mediaPicture)({
        base: seams.base ?? (() => currentSandboxTarget()?.base),
        askFresh: () => void askFresh(),
        onHello: () => {
            status.value = { kind: `live` };
        },
        onDrop: () => {
            if (status.value.kind === `live`) {
                status.value = { kind: `reconnecting` };
            }
        },
        onFailed: (message) => {
            status.value = { kind: `failed`, reason: message };
        },
        webTransport: webTransportDeclared,
        // The computer is elsewhere: a peer straight to it is always shorter than through the sandbox.
        peerWanted: () => true,
        iceServers: () => grant.value?.iceServers.map(iceServer),
    });

    // Nobody looking (another tab in front, the window in the tray): the computer stops sending until someone is.
    watch(onScreen, (seen) => picture.setVisible(seen), { immediate: true });
    watch(monitor, () => void open());
    void open();

    onScopeDispose(() => {
        opens += 1;
        keeper.dispose();
        picture.dispose();
    });

    return {
        status,
        picture,
        grant,
        readOnly: computed(() => grant.value?.readOnly === true || picture.hello.value?.readOnly === true),
        reopen: () => void open(),
    };
};
