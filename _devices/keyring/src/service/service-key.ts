import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isMissing } from "@intentic/base/errors";
import { writeSecretFile } from "@intentic/local-agent";
import { z } from "zod";
import { unwrapPassphrase, type VaultFile, type Wrap, WrapSchema, wrapWithPassphrase } from "../vault.js";

// THE LINUX SERVICE'S OWN UNLOCK KEY (2026-10-19). On Windows a daily unlock is a Windows Hello signature, which the
// vault key is wrapped under. Linux has no such signature: polkit answers yes or no and hands nothing over. So the
// service keeps a random secret of its own, in a file only its system user reads (`service-key.json` in the vault's
// 0700 folder), and the vault key is wrapped once more under it, the same scrypt wrap the recovery key's is (vault.ts).
// A polkit yes is what lets the service use it; a process of the user can read neither the file nor the service's
// memory. The wrap is kept here too, so every vault the core writes gets it back (`merged`) without the core knowing.

// scrypt at its floor: the secret is 256 random bits, which no amount of stretching makes harder to guess.
const SERVICE_COST = { N: 2 ** 10, r: 8, p: 1 } as const;

const ServiceKeyFileSchema = z.object({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), wrap: WrapSchema.optional() }).strict();
type ServiceKeyFile = z.infer<typeof ServiceKeyFileSchema>;

const sameWrap = (a: Wrap, b: Wrap): boolean => a.method === "passphrase" && b.method === "passphrase" && a.salt === b.salt;

export class ServiceKey {
    readonly #path: string;
    readonly #dir: string;
    #file: ServiceKeyFile | undefined;

    constructor(path: string, dir: string) {
        this.#path = path;
        this.#dir = dir;
    }

    async #load(): Promise<ServiceKeyFile> {
        if (this.#file !== undefined) {
            return this.#file;
        }
        try {
            this.#file = ServiceKeyFileSchema.parse(JSON.parse(await readFile(this.#path, "utf8")));
        } catch (error) {
            if (!isMissing(error)) {
                throw error;
            }
            this.#file = { secret: randomBytes(32).toString("base64url") };
            await this.#save(this.#file);
        }
        return this.#file;
    }

    async #save(file: ServiceKeyFile): Promise<void> {
        await writeSecretFile(this.#path, this.#dir, `${JSON.stringify(file)}\n`);
    }

    /** The vault key, once a vault key was adopted; undefined before, which a migrated vault is until its first unlock. */
    async open(): Promise<Buffer | undefined> {
        const file = await this.#load();
        return file.wrap === undefined ? undefined : await unwrapPassphrase([file.wrap], file.secret);
    }

    /** Wraps `vaultKey` under the service's secret, once: from then on a polkit yes unlocks. */
    async adopt(vaultKey: Buffer): Promise<boolean> {
        const file = await this.#load();
        if (file.wrap !== undefined) {
            return false;
        }
        this.#file = { ...file, wrap: await wrapWithPassphrase(vaultKey, file.secret, SERVICE_COST) };
        await this.#save(this.#file);
        return true;
    }

    /** `vault` with the service's wrap among its wraps, whatever the core last wrote. */
    async merged(vault: VaultFile): Promise<VaultFile> {
        const wrap = (await this.#load()).wrap;
        return wrap === undefined || vault.wraps.some((each) => sameWrap(each, wrap)) ? vault : { ...vault, wraps: [...vault.wraps, wrap] };
    }
}
