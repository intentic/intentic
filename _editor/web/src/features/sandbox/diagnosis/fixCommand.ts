import type { FixCode } from "@intentic/api-contract";
import { oneLinerFits } from "@intentic/constants";
import type { CommandOs } from "@intentic/ui";
import { onScopeDispose, shallowRef, watch, type Ref } from "vue";
import { bashCommand, oneLiner, psCommand } from "../../../app/environments/scriptCommand";
import { apiClient } from "../../../lib/useApi";

// THE ONE COMMAND a sandbox that stopped answering hands out: `ic sandbox fix` on the machine it runs on, fetched fresh
// by the /fix script (the installed `ic` may predate what is needed). It checks every layer of that machine, heals what
// is safe, and asks in its own terminal before anything else, so the reader is never asked to choose between commands.
// The code in it lets the run report back to the page that handed it out (FixCodeSchema), without a credential in the
// shell's history; a command with no code still works, it only runs unobserved.

// With a code it is the `fix/<code>` one-liner; the Worker refuses anything the platform did not mint the shape of, and
// so does this, falling back to the plain /fix script, which runs unobserved.
export const fixCommand = (code: string | undefined, os: CommandOs): string => {
    if (code !== undefined && oneLinerFits(`fix`, [code])) {
        return oneLiner(`fix`, [code], os);
    }
    return os === `windows` ? psCommand(`fixPs1`, ``) : bashCommand(`fix`, ``, ``);
};

// Minted codes by sandbox, reused until a minute before they lapse, so a panel shown twice hands out the same command.
const minted = new Map<string, FixCode>();
const SPARE_MS = 60_000;

const live = (code: FixCode | undefined, now: number): code is FixCode => code !== undefined && Date.parse(code.expiresAt) - SPARE_MS > now;

const mint = async (sandboxId: string): Promise<FixCode | undefined> => {
    const held = minted.get(sandboxId);
    if (live(held, Date.now())) {
        return held;
    }
    try {
        const fresh = await apiClient.sandbox.fixCode({ sandboxId });
        minted.set(sandboxId, fresh);
        return fresh;
    } catch (error) {
        console.warn("Could not mint a sandbox fix code", error);
        // A platform from before fix codes, or one that refused: the command runs without reporting back.
        return undefined;
    }
};

// The code for this sandbox while `wanted` holds, minted once and renewed before it lapses.
export const useFixCode = (sandboxId: Ref<string | undefined>, wanted: Ref<boolean>): Ref<string | undefined> => {
    const code = shallowRef<string | undefined>(undefined);
    let renew: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
        clearTimeout(renew);
        const id = sandboxId.value;
        if (id === undefined || !wanted.value) {
            code.value = undefined;
            return;
        }
        const fresh = await mint(id);
        if (sandboxId.value !== id) {
            return;
        }
        code.value = fresh?.code;
        if (fresh !== undefined) {
            renew = setTimeout(() => void refresh(), Math.max(SPARE_MS, Date.parse(fresh.expiresAt) - Date.now() - SPARE_MS));
        }
    };
    watch([sandboxId, wanted], () => void refresh(), { immediate: true });
    onScopeDispose(() => clearTimeout(renew));
    return code;
};
