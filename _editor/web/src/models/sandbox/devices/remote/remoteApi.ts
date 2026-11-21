import { type InjectionKey, inject, hasInjectionContext, type MaybeRefOrGetter, toValue, computed } from "vue";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../../../lib/queryKeys";
import { queryClient } from "../../../../lib/queryPersistence";

// A PERSON'S REMOTE SCREEN AND TERMINALS ON A CONNECTED COMPUTER, AS THE EDITOR ASKS FOR THEM: the sandbox's `remote`
// group (contracts/remote.contract.ts, schemas/remote-access.ts), the only file that names it, so a rename there is a
// change here alone. Each procedure takes `device`, the connection the computer's environment was paired as (a
// device row's `hostId`: `rog`, `rog::wsl:archlinux`); the screen and each terminal answer with a socket path on the
// sandbox's own address and a short-lived token for it, which `refresh` renews before it lapses. Times are epoch ms.
// A device or session that is not there is refused NOT_FOUND; one the computer cannot serve now (offline, its switches
// off, an agent too old) CONFLICT, in a sentence for a person, which the page shows as the reason.

export interface RemoteMonitor {
    readonly id: string;
    readonly name: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    readonly primary: boolean;
}

export interface RemoteTerminalInfo {
    readonly session: string;
    readonly title: string;
    // `native`, or `wsl:<distro>`.
    readonly environment: string;
    readonly createdAt: number;
    // How many sockets are attached to it now, this browser's included.
    readonly viewers: number;
}

export interface RemoteStatus {
    readonly available: boolean;
    // Why not, in a sentence for a person, when it is not.
    readonly reason?: string | undefined;
    readonly allow: { readonly view: boolean; readonly control: boolean; readonly terminal: boolean };
    readonly monitors: readonly RemoteMonitor[];
    readonly environments: readonly string[];
    readonly terminals: readonly RemoteTerminalInfo[];
}

/** A socket's way in: its path on the sandbox's address (`/system/device-…/<device>/<session>`) and the token to add. */
export interface RemoteGrant {
    readonly session: string;
    readonly path: string;
    readonly token: string;
    readonly expiresAt: number;
}

export interface RemoteIceServer {
    readonly urls: readonly string[];
    readonly username?: string | undefined;
    readonly credential?: string | undefined;
}

export interface RemoteScreenGrant extends RemoteGrant {
    // Watching only: this person may see the screen but not drive it (the computer's switch, or their access).
    readonly readOnly: boolean;
    // The STUN servers a peer connection straight to the computer gathers with.
    readonly iceServers: readonly RemoteIceServer[];
}

export interface RemoteToken {
    readonly token: string;
    readonly expiresAt: number;
}

export interface OpenTerminal {
    readonly device: string;
    readonly environment?: string | undefined;
    readonly cols: number;
    readonly rows: number;
}

/**
 * Windows' lock screen and administrator prompts on the computer: whether remoted's own Windows service is set up
 * there, and at the computer's agent's version or an older one. An install or a removal answers the same, read after
 * the UAC prompt on the computer was answered: `declined` when the administrator's yes was not given, `error` in a
 * sentence when it did not do what it was asked.
 */
export interface RemoteServiceState {
    readonly supported: boolean;
    readonly reason?: string | undefined;
    readonly installed: boolean;
    // `running`, `stopped`, `starting`, `stopping`.
    readonly state?: string | undefined;
    readonly version?: string | undefined;
    readonly agentVersion?: string | undefined;
    readonly outOfDate: boolean;
    readonly declined?: boolean | undefined;
    readonly error?: string | undefined;
}

export type RemoteServiceChange = `install` | `uninstall`;

export interface RemoteApi {
    readonly status: (device: string) => Promise<RemoteStatus>;
    readonly openScreen: (device: string, monitor?: string) => Promise<RemoteScreenGrant>;
    readonly openTerminal: (input: OpenTerminal) => Promise<RemoteGrant>;
    readonly attachTerminal: (device: string, session: string) => Promise<RemoteGrant>;
    readonly refresh: (device: string, session: string) => Promise<RemoteToken>;
    readonly closeTerminal: (device: string, session: string) => Promise<void>;
}

/** The lock-screen service's two calls, apart from the screen's and the terminals' so a fake of either stays whole. */
export interface RemoteServiceApi {
    readonly service: (device: string) => Promise<RemoteServiceState>;
    // Waits on the person at the computer answering its UAC prompt, ten minutes at most.
    readonly changeService: (device: string, action: RemoteServiceChange) => Promise<RemoteServiceState>;
}

export const remoteApi: RemoteApi = {
    status: (device) => sandboxRpc.remote.status({ device }),
    openScreen: (device, monitor) => sandboxRpc.remote.openScreen(monitor === undefined ? { device } : { device, monitor }),
    openTerminal: async ({ device, environment, cols, rows }) => {
        const opened = await sandboxRpc.remote.openTerminal(environment === undefined ? { device, cols, rows } : { device, environment, cols, rows });
        // The device page lists it at once, rather than at its next read.
        await queryClient.invalidateQueries({ queryKey: remoteStatusKey(device) });
        return opened;
    },
    attachTerminal: (device, session) => sandboxRpc.remote.attachTerminal({ device, session }),
    refresh: (device, session) => sandboxRpc.remote.refresh({ device, session }),
    closeTerminal: async (device, session) => {
        await sandboxRpc.remote.closeTerminal({ device, session });
        await queryClient.invalidateQueries({ queryKey: remoteStatusKey(device) });
    },
};

const remoteServiceApi: RemoteServiceApi = {
    service: (device) => sandboxRpc.remote.service({ device }),
    changeService: (device, action) => sandboxRpc.remote.changeService({ device, action }),
};

/** The api a component reaches the computer through; a test or a kit page provides its own. */
const REMOTE_API: InjectionKey<RemoteApi> = Symbol(`remoteApi`);
export const useRemoteApi = (): RemoteApi => (hasInjectionContext() ? inject(REMOTE_API, remoteApi) : remoteApi);

/** The lock-screen service's calls a component makes; a test provides its own under this key. */
export const REMOTE_SERVICE_API: InjectionKey<RemoteServiceApi> = Symbol(`remoteServiceApi`);
export const useRemoteServiceApi = (): RemoteServiceApi => (hasInjectionContext() ? inject(REMOTE_SERVICE_API, remoteServiceApi) : remoteServiceApi);

/** The session is gone from the computer (closed there, or the computer restarted remoted): nothing to attach to. */
export const sessionGone = (error: SandboxHttpError | Error): boolean => error instanceof SandboxHttpError && error.status === 404;

const remoteStatusKey = (device: string): unknown[] => rpcKey(`remote.status`, { device });

// How often an open device page reads each environment's remote status: a terminal opened elsewhere, a viewer leaving, a
// switch flipped on the computer itself all show within this.
const STATUS_POLL_MS = 15_000;

/** What one environment can offer a person now; idle while `device` is undefined. */
export const useRemoteStatus = (device: MaybeRefOrGetter<string | undefined>) => {
    const api = useRemoteApi();
    const { query } = useSandboxQuery({
        queryKey: computed(() => remoteStatusKey(toValue(device) ?? ``)),
        queryFn: () => api.status(toValue(device) ?? ``),
        enabled: computed(() => toValue(device) !== undefined),
        refetchInterval: STATUS_POLL_MS,
        // A refusal is the answer (the sentence it carries is the reason shown); asking again at once says it twice.
        retry: false,
    });
    return query;
};

const remoteServiceKey = (device: string): unknown[] => rpcKey(`remote.service`, { device });

// The service changes when someone sets it up or removes it, after which the row reads it again: a slow poll catches a
// change made at the computer itself.
const SERVICE_POLL_MS = 60_000;

/** Whether the computer's lock-screen service is set up; idle while `device` is undefined. */
export const useRemoteService = (device: MaybeRefOrGetter<string | undefined>) => {
    const api = useRemoteServiceApi();
    const { query } = useSandboxQuery({
        queryKey: computed(() => remoteServiceKey(toValue(device) ?? ``)),
        queryFn: () => api.service(toValue(device) ?? ``),
        enabled: computed(() => toValue(device) !== undefined),
        refetchInterval: SERVICE_POLL_MS,
        // A refusal is the answer, as for the status above.
        retry: false,
    });
    return query;
};
