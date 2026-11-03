import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "@intentic/base/errors";
import { parseJsonOr } from "@intentic/base/json";
import { HostCrashEventSchema } from "@intentic/sandbox-contract/schemas/hosts";
import { z } from "zod";
import { HOST_CRASHES_FILE } from "./restart-record.js";

// HOST_CRASHES_FILE's rows: what the computer this sandbox runs on reported of its own crashes and GPU resets, written by
// hosts/gpu/host-crashes.ts and read here and by the diagnostics `restarts` tool, which explains a run killed without
// warning by them. One event, the machine card that said it, and when this daemon first heard it.
export const HostCrashRowSchema = HostCrashEventSchema.extend({ host: z.string(), heardAt: z.string() });
export type HostCrashRow = z.infer<typeof HostCrashRowSchema>;

// Rows from a file another build wrote: a line that does not parse is skipped, never the file.
export const parseCrashRows = (text: string): HostCrashRow[] =>
    text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
            const row = HostCrashRowSchema.safeParse(parseJsonOr(line, undefined));
            return row.success ? [row.data] : [];
        });

// No file is no crashes heard yet; any other failure to read it is the caller's to see.
export const readHostCrashes = async (logsDir: string): Promise<HostCrashRow[]> => {
    try {
        return parseCrashRows(await readFile(join(logsDir, HOST_CRASHES_FILE), "utf8"));
    } catch (error) {
        if (errnoCode(error) === "ENOENT") {
            return [];
        }
        throw error;
    }
};
