import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// A long-lived helper program spoken to one line at a time: the focus watcher (watch-windows.ts, watch-linux.ts) and the
// Linux chip's notification. Unlike the keyring's Runner (run.ts), which runs a program to its end, this keeps the
// program running and hands each line it prints to `onLine` as it comes. Nothing secret ever crosses one of these: the
// watcher reports which program has a password field focused and where, never what is in it.

export interface LineChild {
    readonly onLine: (listener: (line: string) => void) => void;
    readonly onExit: (listener: (code: number | null) => void) => void;
    readonly write: (line: string) => void;
    readonly stop: () => void;
}

export type SpawnLines = (command: string, args: readonly string[]) => LineChild;

export const spawnLines: SpawnLines = (command, args) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    const exits: ((code: number | null) => void)[] = [];
    let exited = false;
    const exit = (code: number | null): void => {
        if (!exited) {
            exited = true;
            for (const listener of exits) {
                listener(code);
            }
        }
    };
    child.on("exit", exit);
    // A program that is not installed never starts: the same as one that stopped at once.
    child.on("error", () => exit(null));
    // allow(silent-catch): a write to a program that already stopped is said by its exit, not by this
    child.stdin.on("error", () => undefined);
    return {
        onLine: (listener) => lines.on("line", listener),
        onExit: (listener) => exits.push(listener),
        write: (line) => {
            if (!exited) {
                child.stdin.write(`${line}\n`);
            }
        },
        stop: () => {
            if (!exited) {
                child.kill();
            }
        },
    };
};
