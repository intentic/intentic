import { connect } from "node:net";

/* IS SOMETHING ALREADY SERVING THIS PORT?
 *
 * The question exists because of a silent failure that costs a whole debugging session. The tunnel publishes
 * two LOCAL ports; it does not care which process is behind them. So a `pnpm dev` already running from an
 * earlier session — started, correctly, with localhost origins — keeps the ports, the api this tool starts
 * dies on EADDRINUSE somewhere inside a wall of vite output, and the tunnel cheerfully serves the OLD
 * platform to the internet. Everything looks right: the public address answers, the app loads, sign-in works.
 * The only symptom is that every link the platform MINTS — invite mail above all — still says localhost,
 * because the process behind the tunnel was configured that way and nothing ever told it otherwise.
 *
 * A connect attempt, not a bind attempt: binding to test would race the very process we are looking for, and
 * on some platforms succeeds against a listener bound to a different interface. */
export const isListening = async (port: number, host = `127.0.0.1`, timeoutMs = 500): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = connect({ port, host });
        const settle = (answer: boolean): void => {
            socket.destroy();
            resolve(answer);
        };
        socket.setTimeout(timeoutMs);
        socket.once(`connect`, () => settle(true));
        socket.once(`timeout`, () => settle(false));
        socket.once(`error`, () => settle(false));
    });
