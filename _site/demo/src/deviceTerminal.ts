import { DEVICE_TERMINAL_PATH, type TerminalServerMessage } from "@intentic/sandbox-contract/browser-wire";
import { clientFrame } from "./daemon/machine/machineKit";
import type { DemoSession, DemoSocket } from "./transport";

/* A SHELL ON THE OWNER'S PC (daemon/machine/remote.handler.ts), answered here as its remoted would: a prompt, and what is
   typed echoed back, a line at a time. PowerShell on the Windows side, zsh on the distro. */

const frame = (message: TerminalServerMessage): string => JSON.stringify(message);
// SAFETY: TextEncoder answers a Uint8Array over a fresh ArrayBuffer of its own, never a shared one.
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

const DIM = `\u001b[2m`;
const BLUE = `\u001b[34m`;
const GREEN = `\u001b[32m`;
const RESET = `\u001b[0m`;

const deviceTerminalSession =
    (windows: boolean): DemoSession =>
    (socket: DemoSocket) => {
        const prompt = windows ? `PS C:\\Users\\ada> ` : `${GREEN}ada@ada-pc${RESET} ${BLUE}~/shop${RESET} $ `;
        const banner = windows ? `${DIM}PowerShell 7.5.0${RESET}\r\n` : `${DIM}Arch Linux on WSL · zsh 5.9${RESET}\r\n`;
        setTimeout(() => socket.emit(bytes(`${banner}${prompt}`)), 120);
        socket.addEventListener(`client`, (event) => {
            const said = clientFrame(event);
            if (said.type === `input` && said.data !== undefined) {
                socket.emit(bytes(said.data.replaceAll(`\r`, `\r\n${prompt}`)));
            }
        });
        const pong = setInterval(() => socket.emit(frame({ type: `pong` })), 25_000);
        socket.addEventListener(`close`, () => clearInterval(pong));
    };

/** The session behind a device terminal's path (`/system/device-terminal/<device>/<session>`), or none. */
export const deviceTerminalSocket = (url: URL): DemoSession | undefined => {
    if (!url.pathname.startsWith(`${DEVICE_TERMINAL_PATH}/`)) {
        return undefined;
    }
    const device = url.pathname.slice(DEVICE_TERMINAL_PATH.length + 1).split(`/`)[0] ?? ``;
    return deviceTerminalSession(!device.includes(`wsl`));
};
