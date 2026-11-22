import { refuse } from "@intentic/contract-serve";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { DEFAULT_REMOTE_ICE_SERVERS } from "@intentic/sandbox-contract/schemas/remote-access";
import { capabilityList } from "../account/capabilities";
import type { Doors } from "../doors";

// A person's screen and terminals on the owner's PC (fixture/devices.ts `ada-pc`, and its Arch Linux side): what each
// environment can open, as the PC's card's three switches allow (flipped on that card's form, written to the capability
// store, read back here), two monitors on the Windows side, and the shells already running on each. A screen and a
// terminal open with a path and a token as the sandbox hands them out; the demo serves no picture or shell behind them,
// so the views show their own connecting state.

type RemoteStatus = SandboxHandlerOutput<`remote`, `status`>;
type RemoteTerminal = RemoteStatus[`terminals`][number];

const MONITORS: RemoteStatus[`monitors`] = [
    { id: `0`, name: `DELL U2720Q`, x: 0, y: 0, width: 3840, height: 2160, scale: 1.5, primary: true },
    { id: `1`, name: `LG 24MK600`, x: 3840, y: 0, width: 1920, height: 1080, scale: 1, primary: false },
];

const STARTED = Date.now();
// The shells each side holds, by its connection: one Windows terminal someone left open, and a distro shell in the shop.
const terminals = new Map<string, RemoteTerminal[]>([
    [`ada-pc`, [{ session: `t-7Fq2pX`, title: `pwsh`, environment: `native`, createdAt: STARTED - 25 * 60_000, viewers: 1 }]],
    [`ada-pc::wsl:archlinux`, [{ session: `t-9Hk1mR`, title: `zsh · ~/shop`, environment: `wsl:archlinux`, createdAt: STARTED - 3 * 3_600_000, viewers: 0 }]],
]);

// Each side's own environment, as the sandbox names it: each connection's own remoted serves its own (the sandbox's
// hosts/remote/remote-environments.ts), so the Windows side offers no `wsl:archlinux`, which has a connection of its own.
const SIDES = new Map([
    [`ada-pc`, `native`],
    [`ada-pc::wsl:archlinux`, `wsl:archlinux`],
]);
const known = (device: string): void => {
    if (!SIDES.has(device)) {
        refuse(`No remote access on ${device}.`, 404);
    }
};

const allowed = (): RemoteStatus[`allow`] => {
    const config = capabilityList().capabilities.find((capability) => capability.id === `ada-pc`)?.config ?? {};
    return { view: config[`remoteView`] === `on`, control: config[`remoteControl`] === `on`, terminal: config[`remoteTerminal`] === `on` };
};

const token = (): SandboxHandlerOutput<`remote`, `refresh`> => ({ token: `demo.${Math.random().toString(36).slice(2)}`, expiresAt: Date.now() + 5 * 60_000 });
const segment = (device: string): string => device.replaceAll(/[^A-Za-z0-9_-]/gu, `-`);

export const remoteDoors = {
    status: ({ device }) => {
        known(device);
        const allow = allowed();
        const native = device === `ada-pc`;
        const status: RemoteStatus = {
            available: allow.view || allow.control || allow.terminal,
            allow,
            monitors: native ? MONITORS : [],
            environments: [SIDES.get(device) ?? `native`],
            terminals: terminals.get(device) ?? [],
        };
        if (!status.available) {
            status.reason = `Every remote switch on ada-pc is off.`;
        }
        return status;
    },
    openScreen: ({ device, monitor }) => {
        known(device);
        const session = `screen-${monitor ?? `0`}`;
        return {
            ...token(),
            session,
            path: `/system/device-media/${segment(device)}/${session}`,
            readOnly: !allowed().control,
            iceServers: DEFAULT_REMOTE_ICE_SERVERS.map((server) => ({ ...server, urls: [...server.urls] })),
        };
    },
    openTerminal: ({ device, environment }) => {
        known(device);
        const session = `t-${Math.random().toString(36).slice(2, 8)}`;
        const held = terminals.get(device) ?? [];
        const where = environment ?? SIDES.get(device) ?? `native`;
        terminals.set(device, [...held, { session, title: where === `native` ? `pwsh` : `zsh`, environment: where, createdAt: Date.now(), viewers: 1 }]);
        return { ...token(), session, path: `/system/device-terminal/${segment(device)}/${session}` };
    },
    attachTerminal: ({ device, session }) => {
        known(device);
        if (!(terminals.get(device) ?? []).some((terminal) => terminal.session === session)) {
            refuse(`No terminal ${session} on ${device}.`, 404);
        }
        return { ...token(), session, path: `/system/device-terminal/${segment(device)}/${session}` };
    },
    refresh: ({ device }) => {
        known(device);
        return token();
    },
    closeTerminal: ({ device, session }) => {
        known(device);
        terminals.set(
            device,
            (terminals.get(device) ?? []).filter((terminal) => terminal.session !== session),
        );
        return { ok: true as const };
    },
} satisfies Doors<`remote`>;
