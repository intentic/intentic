import type { InjectionKey } from "vue";
import { osLockIdle, osLockOff, osLockSetPin, osLockStatus, type OsLockStatus } from "../../../osSettings";

export interface SecurityActions {
    readonly status: () => Promise<OsLockStatus | null>;
    readonly setPin: (pin: string) => Promise<OsLockStatus>;
    readonly off: () => Promise<OsLockStatus>;
    readonly idle: (minutes: number) => Promise<OsLockStatus>;
}

/** The card's one seam: a preview or test supplies it without making a web page look like a Tauri window. */
export const SECURITY_ACTIONS: InjectionKey<SecurityActions> = Symbol(`screen lock`);
export const securityActions: SecurityActions = { status: osLockStatus, setPin: osLockSetPin, off: osLockOff, idle: osLockIdle };
