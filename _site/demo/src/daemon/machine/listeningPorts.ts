import type { SandboxHandlerInput, SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { refuse } from "@intentic/contract-serve";
import { demoQuiet, deskEdition, freshEdition } from "../../mode";
import { listeners } from "../board/roster";

// What listens inside the sandbox (ports.list) and which of it is reachable from outside: the web app's dev server the
// checkout agent left running, the api beside it, a Storybook the owner started by hand, and the sandbox's own Docker DNS,
// listed for honesty and refused for forwarding. Forwarding gives a port a slot of the preview proxy; asking twice hands
// back the same address, and unforwarding frees it at once.

type Port = SandboxHandlerOutput<`ports`, `list`>[`ports`][number];

const SANDBOX_ID = `sbx_acme_shop`;
const ZONE = `sbx.intentic.dev`;

const LISTENING: readonly Port[] =
    deskEdition || freshEdition
        ? []
        : [
              { port: 5173, host: `::1`, forwardable: true, kind: `workspace`, title: `web dev server`, purpose: `Vite serving the shop's front end with hot reload.`, origin: `panel`, pid: 4102, command: `node web/node_modules/.bin/vite`, cwd: `${WORKSPACE_ROOT}/web`, forwarded: false },
              { port: 3000, host: `127.0.0.1`, forwardable: true, kind: `workspace`, title: `api`, purpose: `The checkout API in watch mode, which the dev server proxies /api to.`, origin: `agent`, pid: 4188, command: `node --watch api/src/server.ts`, cwd: `${WORKSPACE_ROOT}/api`, session: `agent-checkout-stripe`, forwarded: false },
              { port: 6006, host: `127.0.0.1`, forwardable: true, kind: `workspace`, title: `Storybook`, purpose: `Storybook for the pricing components, started from a terminal.`, origin: `terminal`, pid: 5021, command: `pnpm -C web storybook`, cwd: `${WORKSPACE_ROOT}/web`, forwarded: false },
              { port: 53, host: `127.0.0.1`, forwardable: false, kind: `system`, title: `Docker DNS`, purpose: `Docker's embedded resolver, which answers only at its own address.`, origin: `sandbox`, forwarded: false },
          ];

// Slot per forwarded port, in the order they were asked for, as the proxy hands them out. The dev server was shared
// for a look earlier; a quiet recording has published nothing.
const slots = new Map<number, number>(demoQuiet() || LISTENING.length === 0 ? [] : [[5173, 1]]);

const previewUrlOf = (slot: number): string => `https://port-${slot}-${SANDBOX_ID}.${ZONE}`;

export const portsList = (): SandboxHandlerOutput<`ports`, `list`> => ({
    ports: LISTENING.map((port) => {
        const slot = slots.get(port.port);
        return slot === undefined ? port : { ...port, forwarded: true, previewUrl: previewUrlOf(slot) };
    }),
});

const pushPorts = (): void => {
    for (const listener of listeners) {
        listener({ kind: `runtimeChanged`, domains: [`ports`] });
    }
};

export const forwardPort = ({ port }: SandboxHandlerInput<`ports`, `forward`>): SandboxHandlerOutput<`ports`, `forward`> => {
    const listening = LISTENING.find((candidate) => candidate.port === port);
    if (listening?.forwardable === false) {
        return refuse(`Port ${port} answers only at its own address, so it cannot be forwarded.`, 400);
    }
    const slot = slots.get(port) ?? Math.max(0, ...slots.values()) + 1;
    slots.set(port, slot);
    pushPorts();
    return { previewUrl: previewUrlOf(slot) };
};

export const unforwardPort = ({ port }: SandboxHandlerInput<`ports`, `unforward`>): SandboxHandlerOutput<`ports`, `unforward`> => {
    slots.delete(port);
    pushPorts();
    return { ok: true };
};
