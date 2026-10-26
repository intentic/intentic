import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { undefinedIfMissing } from "@intentic/base/errors";
import { lineSplitter } from "../sandboxes.js";

// Byte offsets: finding where a new run begins must not read the history it is going to skip.
export const logSize = async (path: string): Promise<number> => (await stat(path).catch(undefinedIfMissing))?.size ?? 0;

// Read only the bytes appended since the last look, in bounded chunks. Keep both UTF-8 and line fragments across
// looks: a write may stop halfway through either, including the error line runStop reads to judge the update.
export const agentLogReader = (path: string, from: number, onLine: (line: string) => void) => {
    let at = from;
    let decoder = new StringDecoder("utf8");
    const take = (line: string): void => {
        if (line.trim() !== "") {
            onLine(line);
        }
    };
    let lines = lineSplitter(take);
    const reset = (): void => {
        at = 0;
        decoder = new StringDecoder("utf8");
        lines = lineSplitter(take);
    };
    return {
        read: async (): Promise<number> => {
            const handle = await open(path, "r").catch(undefinedIfMissing);
            if (handle === undefined) {
                reset();
                return 0;
            }
            try {
                const { size } = await handle.stat();
                if (size < at) {
                    reset();
                }
                const startedAt = at;
                const buffer = Buffer.alloc(Math.min(64 * 1024, size - at));
                while (at < size) {
                    // Resume partial reads; stop at this snapshot's end even if the new agent keeps appending.
                    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - at), at);
                    if (bytesRead === 0) {
                        break;
                    }
                    at += bytesRead;
                    lines.push(decoder.write(buffer.subarray(0, bytesRead)));
                }
                return at - startedAt;
            } finally {
                await handle.close();
            }
        },
        end: (): void => {
            lines.push(decoder.end());
            lines.end();
        },
    };
};
