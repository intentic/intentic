import type { TerminalServerMessage } from "@intentic/sandbox-contract";
import type { DemoSession, DemoSocket } from "./transport";

/* THE TERMINAL, recorded. `/system/terminal` is a WebSocket of JSON frames (TerminalServerMessage), and xterm
 * renders whatever bytes arrive — so a replay is indistinguishable from a live pty as far as the panel is
 * concerned, escape codes and all. This is the agent's own tmux session for the featured turn: the test run its
 * Bash tool call makes, as the visitor would have watched it happen. */

const BOLD = `\u001b[1m`;
const DIM = `\u001b[2m`;
const GREEN = `\u001b[32m`;
const CYAN = `\u001b[36m`;
const RESET = `\u001b[0m`;

interface Line {
    readonly after: number;
    readonly text: string;
}

const SCRIPT: Line[] = [
    { after: 120, text: `${DIM}ada@acme-shop${RESET}:${CYAN}/work${RESET}$ pnpm -C web test checkout\r\n` },
    { after: 700, text: `\r\n${DIM}> acme-web@0.1.0 test${RESET}\r\n${DIM}> vitest run checkout${RESET}\r\n\r\n` },
    { after: 900, text: ` ${DIM}RUN${RESET}  v3.2.4 ${DIM}/work/web${RESET}\r\n\r\n` },
    { after: 1_100, text: ` ${GREEN}✓${RESET} tests/checkout.spec.ts ${DIM}(3 tests) 214ms${RESET}\r\n` },
    { after: 500, text: `   ${GREEN}✓${RESET} redirects to the Stripe session url\r\n` },
    { after: 350, text: `   ${GREEN}✓${RESET} shows the pending state while the session is created\r\n` },
    { after: 350, text: `   ${GREEN}✓${RESET} surfaces a failed session without navigating\r\n` },
    { after: 600, text: `\r\n ${BOLD}Test Files${RESET}  ${GREEN}1 passed${RESET} (1)\r\n` },
    { after: 120, text: ` ${BOLD}     Tests${RESET}  ${GREEN}3 passed${RESET} (3)\r\n` },
    { after: 120, text: ` ${BOLD}  Duration${RESET}  2.14s\r\n\r\n` },
    { after: 400, text: `${DIM}ada@acme-shop${RESET}:${CYAN}/work${RESET}$ ` },
];

const frame = (message: TerminalServerMessage): string => JSON.stringify(message);

/** The recorded session, played on the socket the panel just opened. */
export const terminalSession: DemoSession = (socket: DemoSocket) => {
    let elapsed = 0;
    for (const line of SCRIPT) {
        elapsed += line.after;
        setTimeout(() => socket.emit(frame({ type: `data`, data: line.text })), elapsed);
    }
    // Answer the panel's keepalive so its staleness watchdog never trips on a demo left open in a tab.
    const pong = setInterval(() => socket.emit(frame({ type: `pong` })), 25_000);
    socket.addEventListener(`close`, () => clearInterval(pong));
};
