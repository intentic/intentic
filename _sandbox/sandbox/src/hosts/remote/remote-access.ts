import { randomBytes } from "node:crypto";
import { DEVICE_MEDIA_PATH, DEVICE_TERMINAL_PATH } from "@intentic/sandbox-contract/browser-wire";
import type { AuditActor, AuditEvent } from "@intentic/sandbox-contract/schemas/audit";
import type {
    RemoteAccessAllow as RemoteAllow,
    RemoteIceServer,
    RemoteOpenTerminalInput,
    RemoteScreen,
    RemoteService,
    RemoteServiceChangeInput,
    RemoteStatus,
    RemoteTerminalOpened,
    RemoteToken,
} from "@intentic/sandbox-contract/schemas/remote-access";
import type { RemoteServiceAction, RemoteStartInput } from "@intentic/sandbox-contract/schemas/device-remote";
import { parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import { errorMessage } from "@intentic/base/errors";
import { ORPCError } from "@orpc/server";
import type { Logger } from "pino";
import { mintMediaToken } from "../../browser/media/media-token.js";
import { opt } from "../../opt.js";
import type { DeviceUplinksReport } from "../../netd/netd-link.js";
import type { NetdUplinks } from "./netd-uplinks.js";
import type { RemoteInfo } from "./remote-device.js";
import { type ConnectionEnvironments, fromRemoted, offeredEnvironments, servesScreen, toRemoted } from "./remote-environments.js";
import { digestOf, type RemoteKeys, type RemoteKeyStore, uplinkIdOf } from "./remote-keys.js";
import { RemotedRefused, type RemotedControl } from "./remoted-control.js";

/* A PERSON'S REMOTE SCREEN AND TERMINALS ON ONE OF THE OWNER'S COMPUTERS (2026-11-20). The daemon only decides and mints:
   who may open what, starting the computer's remoted through its machine agent on the first open (`remoteStart`), the
   uplink registration netd admits remoted's dial by, and the castd-format token each socket opens with. Every byte of a
   picture and every keystroke goes browser → netd → the uplink → remoted, never through here.

   Who may: Full access (the owner, a maintainer) drives and opens terminals, as for every other act on the owner's
   devices from the editor (devices.routes.ts `requireMaintainer`); a member below it is refused at the route
   (remote.routes.ts), and `full: false` (a read-only screen, no terminals) is kept for a caller the routes may admit
   later. The computer's own switches bound both. Every open and close is in the audit log.

   A Windows computer's lock screen and administrator prompts need remoted's own Windows service there (the device
   contract's `remoteService`): anyone who may see the device reads whether it is set up, and Full access alone sets it
   up, updates or removes it, which the person at that computer still has to say yes to. Each change is audited. */

// A token opens sockets this long; the editor asks `refresh` before it lapses, and an open socket outlives its newest
// token by the media grace (browser-wire's MEDIA_TOKEN_GRACE_SECONDS).
const REMOTE_TOKEN_TTL_MS = 120_000;

// How long an open waits for remoted's uplink to reach netd once the agent started it; the agent waits ~10 s itself.
const UPLINK_PATIENCE_MS = 15_000;

// How often a device that went away has its uplink withdrawn.
const SWEEP_MS = 30_000;

const SCREEN_PREFIX = "screen-";
const TERMINAL_PREFIX = "t-";
const SESSION = /^[A-Za-z0-9_-]{1,64}$/u;

const NETD_TOO_OLD = "This sandbox's network daemon is too old to carry a remote screen. Restart the sandbox to update it.";

// Who is asking: for the audit log, and whether they hold Full access (drive, terminals) or may only watch.
export interface RemoteCaller {
    readonly actor: AuditActor;
    readonly full: boolean;
}

// The device as its machine agent serves it: why it cannot run remote access now, and starting it.
export interface RemoteLink {
    // Offline, or an agent too old to have remote access; undefined when it can.
    readonly refusal: (device: string) => string | undefined;
    readonly online: (device: string) => boolean;
    readonly start: (device: string, input: RemoteStartInput) => Promise<RemoteInfo>;
    // remoted's Windows service on the device, read or changed by its agent; throws, saying why, on one that cannot.
    readonly service: (device: string, action: RemoteServiceAction) => Promise<RemoteService>;
    // The card's switches, before remoted has said.
    readonly cardAllows: (device: string) => Promise<RemoteAllow>;
    // The connection's own environment and its card's distros with a connection of their own (remote-environments.ts).
    readonly environments: (device: string) => ConnectionEnvironments;
}

export interface RemoteAccessDeps {
    readonly link: RemoteLink;
    readonly keys: RemoteKeyStore;
    readonly control: (uplinkId: string) => RemotedControl;
    readonly iceServers: () => Promise<readonly RemoteIceServer[]>;
    readonly audit: (event: AuditEvent) => void;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly now?: () => number;
}

export interface RemoteAccess {
    readonly status: (device: string, caller: RemoteCaller) => Promise<RemoteStatus>;
    readonly openScreen: (device: string, monitor: string | undefined, caller: RemoteCaller) => Promise<RemoteScreen>;
    readonly openTerminal: (input: RemoteOpenTerminalInput, caller: RemoteCaller) => Promise<RemoteTerminalOpened>;
    readonly attachTerminal: (device: string, session: string, caller: RemoteCaller) => Promise<RemoteTerminalOpened>;
    readonly refresh: (device: string, session: string, caller: RemoteCaller) => Promise<RemoteToken>;
    readonly closeTerminal: (device: string, session: string, caller: RemoteCaller) => Promise<void>;
    readonly service: (device: string, caller: RemoteCaller) => Promise<RemoteService>;
    readonly changeService: (device: string, action: RemoteServiceChangeInput["action"], caller: RemoteCaller) => Promise<RemoteService>;
    // A member's access went: every remoted ends its viewers' sockets and refuses the tokens minted before now, and the
    // viewers still entitled dial again with fresh ones.
    readonly dropViewers: (reason: string) => Promise<void>;
    // netd's uplinks, once the link to it is up (netd-door.ts); undefined while there is none.
    readonly useNetd: (uplinks: NetdUplinks | undefined) => void;
    // netd's report of where the uplinks stand, handed to them.
    readonly heard: (report: DeviceUplinksReport) => void;
    readonly stop: () => void;
}

const conflict = (message: string): ORPCError<"CONFLICT", undefined> => new ORPCError("CONFLICT", { message });
const notFound = (message: string): ORPCError<"NOT_FOUND", undefined> => new ORPCError("NOT_FOUND", { message });
const forbidden = (message: string): ORPCError<"FORBIDDEN", undefined> => new ORPCError("FORBIDDEN", { message });

const NO_ALLOW: RemoteAllow = { view: false, control: false, terminal: false };

// Why a caller can open nothing on a device that allows this, or undefined when they can open something.
const switchedOff = (device: string, allow: RemoteAllow, caller: RemoteCaller): string | undefined => {
    if (allow.view || (caller.full && allow.terminal)) {
        return undefined;
    }
    return caller.full
        ? `Remote access is off on "${device}". Turn on viewing, control or terminals on its card to use it from here.`
        : `Watching the screen is off on "${device}". Its owner can turn it on on the device's card.`;
};

// A screen's session: `screen-<monitor>`, the asked monitor, else the primary one, else the first, else `0`.
const screenSession = (info: RemoteInfo | undefined, asked: string | undefined): string => {
    const monitors = info?.monitors ?? [];
    const id = asked ?? monitors.find((monitor) => monitor.primary)?.id ?? monitors[0]?.id ?? "0";
    if (asked !== undefined && monitors.length > 0 && !monitors.some((monitor) => monitor.id === asked)) {
        throw notFound(`no monitor "${asked}" on this device`);
    }
    const session = `${SCREEN_PREFIX}${id}`;
    if (!SESSION.test(session)) {
        throw notFound(`the monitor "${id}" has no name a screen can open under`);
    }
    return session;
};

// What the daemon holds while it runs: netd's uplinks once the link is up, what remoted last said of each device it runs
// on (by connection key), and the start an open is already waiting on, which a second open waits on rather than
// starting the device twice.
interface Held {
    readonly deps: RemoteAccessDeps;
    readonly now: () => number;
    netd: NetdUplinks | undefined;
    readonly running: Map<string, { readonly uplinkId: string; readonly info: RemoteInfo }>;
    readonly starting: Map<string, Promise<RemoteInfo>>;
}

const tokenOf = (held: Held, keys: RemoteKeys, scope: string, readOnly: boolean): RemoteToken => {
    const issuedAt = held.now();
    const expiresAt = issuedAt + REMOTE_TOKEN_TTL_MS;
    return { token: mintMediaToken(Buffer.from(keys.mediaKey, "base64url"), { session: scope, expiresAt, readOnly, issuedAt }), expiresAt };
};

const record = (held: Held, caller: RemoteCaller, action: string, device: string, details: Readonly<Record<string, string | boolean>>): void => {
    held.deps.audit({ actor: caller.actor, action: `device.remote.${action}`, target: device, details: { ...details } });
};

// Why nothing can start on the device right now, or undefined.
const refusalOf = (held: Held, device: string): string | undefined => (held.netd?.supported() === true ? held.deps.link.refusal(device) : NETD_TOO_OLD);

// The setting's servers as the URLs remoted gathers from (`stun:host:port`), each once. Pure.
export const iceUrlsOf = (servers: readonly RemoteIceServer[]): string[] => [...new Set(servers.flatMap((server) => server.urls))];

// The agent starts remoted with the device's pair and the setting's STUN servers, and waits for its uplink; then netd
// must hear it too.
const start = async (
    held: Held,
    device: string,
    uplinkId: string,
    keys: RemoteKeys,
    uplinks: NetdUplinks,
    iceServers: readonly string[],
): Promise<RemoteInfo> => {
    let info: RemoteInfo;
    try {
        info = await held.deps.link.start(device, {
            device: uplinkId,
            uplinkToken: keys.uplinkToken,
            mediaKey: keys.mediaKey,
            iceServers: [...iceServers],
        });
    } catch (error) {
        // Refused (every switch off, most often): nothing of this pair is let dial, and a later start mints a new one.
        uplinks.withdraw(uplinkId);
        held.deps.keys.forget(uplinkId);
        held.deps.logger.info({ device, err: errorMessage(error) }, "remote access: the device did not start remoted");
        throw conflict(`"${device}" did not start its remote access: ${errorMessage(error)}`);
    }
    if (!(await uplinks.whenConnected(uplinkId, UPLINK_PATIENCE_MS))) {
        throw conflict(`"${device}" started its remote access, but it did not reach this sandbox. Check that the computer can reach the sandbox's address.`);
    }
    held.deps.logger.info({ device, version: info.version }, "remote access: remoted is up");
    return info;
};

const startOnce = (
    held: Held,
    device: string,
    uplinkId: string,
    keys: RemoteKeys,
    uplinks: NetdUplinks,
    iceServers: readonly string[],
): Promise<RemoteInfo> => {
    const already = held.starting.get(device);
    if (already !== undefined) {
        return already;
    }
    const started = start(held, device, uplinkId, keys, uplinks, iceServers).finally(() => held.starting.delete(device));
    held.starting.set(device, started);
    return started;
};

// remoted running for the device with its uplink up, starting it through the agent when it is not.
const ensure = async (held: Held, device: string): Promise<{ readonly uplinkId: string; readonly info: RemoteInfo }> => {
    const uplinks = held.netd;
    const refused = refusalOf(held, device);
    if (refused !== undefined || uplinks === undefined) {
        throw conflict(refused ?? NETD_TOO_OLD);
    }
    const uplinkId = uplinkIdOf(device);
    // The setting is read before anything is registered: two opens racing still register the uplink once.
    const iceServers = iceUrlsOf(await held.deps.iceServers());
    const keys = held.deps.keys.of(uplinkId);
    uplinks.register(uplinkId, digestOf(keys.uplinkToken));
    const said = uplinks.connected(uplinkId) ? await held.deps.control(uplinkId).info() : undefined;
    const info = said ?? (await startOnce(held, device, uplinkId, keys, uplinks, iceServers));
    held.running.set(device, { uplinkId, info });
    return { uplinkId, info };
};

// The device's keys, for a token on a session it already serves; none is a device remote access never ran on.
const keysFor = (held: Held, device: string): RemoteKeys => {
    const uplinkId = uplinkIdOf(device);
    if (!held.deps.keys.has(uplinkId)) {
        throw notFound(`remote access has not run on "${device}"`);
    }
    return held.deps.keys.of(uplinkId);
};

const requireFull = (caller: RemoteCaller, what: string): void => {
    if (!caller.full) {
        throw forbidden(`only someone with Full access to this sandbox can ${what} on the owner's computers`);
    }
};

const attached = (held: Held, uplinkId: string, session: string, keys: RemoteKeys): RemoteTerminalOpened => ({
    session,
    path: `${DEVICE_TERMINAL_PATH}/${uplinkId}/${session}`,
    ...tokenOf(held, keys, `terminal/${session}`, false),
});

// What the device allows and serves, without starting anything: remoted's own word while its uplink is up, else the
// card's switches and whatever remoted said last. Environments in the PC's names, and no screen on a distro's
// connection (remote-environments.ts).
const status = async (held: Held, device: string, caller: RemoteCaller): Promise<RemoteStatus> => {
    const refused = refusalOf(held, device);
    const uplinkId = uplinkIdOf(device);
    const up = refused === undefined && held.netd?.connected(uplinkId) === true;
    const control = held.deps.control(uplinkId);
    const info = up ? await control.info() : held.running.get(device)?.info;
    const allow = up && info !== undefined ? info.allow : await held.deps.link.cardAllows(device).catch(() => NO_ALLOW);
    const environments = held.deps.link.environments(device);
    const screen = servesScreen(environments);
    const off = refused ?? switchedOff(device, { ...allow, view: allow.view && screen }, caller);
    const listed = up && caller.full ? ((await control.terminals()) ?? []) : [];
    const terminals = listed.map((terminal) => ({ ...terminal, environment: fromRemoted(terminal.environment, environments) }));
    return {
        available: off === undefined,
        ...opt("reason", off),
        allow,
        monitors: screen ? (info?.monitors ?? []) : [],
        environments: offeredEnvironments(info?.environments ?? [], environments),
        terminals,
    };
};

const openScreen = async (held: Held, device: string, monitor: string | undefined, caller: RemoteCaller): Promise<RemoteScreen> => {
    if (!servesScreen(held.deps.link.environments(device))) {
        throw conflict(`"${device}" is a WSL distro: the computer's screen is its Windows side's. Open it on "${parseHostConnection(device).card}".`);
    }
    const { uplinkId, info } = await ensure(held, device);
    if (!info.allow.view) {
        throw conflict(`Watching the screen is off on "${device}".`);
    }
    const session = screenSession(info, monitor);
    const readOnly = !(caller.full && info.allow.control);
    const opened = tokenOf(held, held.deps.keys.of(uplinkId), `media/${session}`, readOnly);
    record(held, caller, "screen.open", device, { session, readOnly });
    return { session, path: `${DEVICE_MEDIA_PATH}/${uplinkId}/${session}`, readOnly, iceServers: [...(await held.deps.iceServers())], ...opened };
};

const openTerminal = async (held: Held, input: RemoteOpenTerminalInput, caller: RemoteCaller): Promise<RemoteTerminalOpened> => {
    requireFull(caller, "open a terminal");
    const environments = held.deps.link.environments(input.device);
    const asked = toRemoted(input.environment, environments, input.device);
    if (!asked.ok) {
        throw conflict(asked.reason);
    }
    const { uplinkId, info } = await ensure(held, input.device);
    if (!info.allow.terminal) {
        throw conflict(`Terminals are off on "${input.device}".`);
    }
    const session = `${TERMINAL_PREFIX}${randomBytes(12).toString("base64url")}`;
    const { shell, cwd, cols, rows } = input;
    try {
        const made = await held.deps.control(uplinkId).openTerminal({ session, environment: asked.environment, shell, cwd, cols, rows });
        record(held, caller, "terminal.open", input.device, { session, environment: fromRemoted(made.environment, environments) });
    } catch (error) {
        throw error instanceof RemotedRefused ? conflict(`"${input.device}" did not open a terminal: ${error.message}`) : error;
    }
    return attached(held, uplinkId, session, held.deps.keys.of(uplinkId));
};

const attachTerminal = async (held: Held, device: string, session: string, caller: RemoteCaller): Promise<RemoteTerminalOpened> => {
    requireFull(caller, "attach to a terminal");
    const uplinkId = uplinkIdOf(device);
    const listed = held.netd?.connected(uplinkId) === true ? await held.deps.control(uplinkId).terminals() : undefined;
    if (listed?.some((terminal) => terminal.session === session) !== true) {
        throw notFound(`no terminal "${session}" is open on "${device}"`);
    }
    record(held, caller, "terminal.attach", device, { session });
    return attached(held, uplinkId, session, keysFor(held, device));
};

// A fresher token for an open socket: a terminal's for Full access only, a screen's read-only as an open would mint it.
const refresh = async (held: Held, device: string, session: string, caller: RemoteCaller): Promise<RemoteToken> => {
    if (session.startsWith(TERMINAL_PREFIX)) {
        requireFull(caller, "use a terminal");
        return tokenOf(held, keysFor(held, device), `terminal/${session}`, false);
    }
    if (!session.startsWith(SCREEN_PREFIX)) {
        throw notFound(`no screen or terminal "${session}"`);
    }
    // After a daemon restart nothing is remembered of the device yet: remoted, whose uplink outlived it, says.
    const uplinkId = uplinkIdOf(device);
    const said = held.running.get(device)?.info ?? (held.netd?.connected(uplinkId) === true ? await held.deps.control(uplinkId).info() : undefined);
    return tokenOf(held, keysFor(held, device), `media/${session}`, !(caller.full && said?.allow.control === true));
};

const closeTerminal = async (held: Held, device: string, session: string, caller: RemoteCaller): Promise<void> => {
    requireFull(caller, "close a terminal");
    const uplinkId = uplinkIdOf(device);
    if (held.netd?.connected(uplinkId) !== true || !(await held.deps.control(uplinkId).closeTerminal(session))) {
        throw notFound(`no terminal "${session}" is open on "${device}"`);
    }
    record(held, caller, "terminal.close", device, { session });
};

// The device's agent asked about remoted's Windows service; whatever stopped it from answering is the person's reason.
const askService = async (held: Held, device: string, action: RemoteServiceAction): Promise<RemoteService> => {
    try {
        return await held.deps.link.service(device, action);
    } catch (error) {
        throw conflict(errorMessage(error));
    }
};

// Set up (or updated) or removed through the prompt on the computer, and recorded however it ended.
const changeService = async (held: Held, device: string, action: RemoteServiceChangeInput["action"], caller: RemoteCaller): Promise<RemoteService> => {
    requireFull(caller, action === "install" ? "set up the lock-screen service" : "remove the lock-screen service");
    try {
        const answer = await askService(held, device, action);
        const outcome = answer.declined === true ? "declined" : answer.error === undefined ? "done" : "failed";
        record(held, caller, `service.${action}`, device, { outcome, installed: answer.installed });
        return answer;
    } catch (error) {
        record(held, caller, `service.${action}`, device, { outcome: "failed", reason: errorMessage(error) });
        throw error;
    }
};

// Withdraws the uplink of every device that went away.
const sweep = (held: Held): void => {
    for (const [device, { uplinkId }] of held.running) {
        if (!held.deps.link.online(device)) {
            held.netd?.withdraw(uplinkId);
            held.running.delete(device);
            held.deps.logger.info({ device }, "remote access: the device went away; its uplink is withdrawn");
        }
    }
};

// What an earlier daemon left registered and this one holds no keys for is withdrawn.
const reconcile = (held: Held, devices: readonly string[]): void => {
    for (const uplinkId of devices) {
        if (!held.deps.keys.has(uplinkId)) {
            held.netd?.withdraw(uplinkId);
        }
    }
};

export const createRemoteAccess = (deps: RemoteAccessDeps): RemoteAccess => {
    const held: Held = { deps, now: deps.now ?? Date.now, netd: undefined, running: new Map(), starting: new Map() };
    let unreport: (() => void) | undefined;
    // Only while netd's link is up: nothing is registered without one.
    let sweeping: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
        clearInterval(sweeping);
        sweeping = undefined;
        unreport?.();
        unreport = undefined;
    };
    return {
        status: (device, caller) => status(held, device, caller),
        openScreen: (device, monitor, caller) => openScreen(held, device, monitor, caller),
        openTerminal: (input, caller) => openTerminal(held, input, caller),
        attachTerminal: (device, session, caller) => attachTerminal(held, device, session, caller),
        refresh: (device, session, caller) => refresh(held, device, session, caller),
        closeTerminal: (device, session, caller) => closeTerminal(held, device, session, caller),
        // Anyone who may see the device reads it (the routes decide who that is).
        service: (device) => askService(held, device, "status"),
        changeService: (device, action, caller) => changeService(held, device, action, caller),
        // Every uplink netd holds up, those an earlier daemon started included.
        dropViewers: async (reason) => {
            const up = (held.netd?.registered() ?? []).filter((uplinkId) => held.netd?.connected(uplinkId) === true);
            await Promise.all(up.map(async (uplinkId) => await deps.control(uplinkId).dropViewers({ reason })));
        },
        useNetd: (uplinks) => {
            stop();
            held.netd = uplinks;
            held.running.clear();
            if (uplinks !== undefined) {
                unreport = uplinks.onReport((devices) => reconcile(held, devices));
                sweeping = setInterval(() => sweep(held), SWEEP_MS);
                sweeping.unref?.();
            }
        },
        heard: (report) => held.netd?.heard(report),
        stop,
    };
};
