import { messageOr } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { t } from "../i18n.js";
import type { PasswordItem, PasswordRequest, PasswordsEvent, PasswordsPort, SandboxRef, VaultStatus } from "./port.js";

// WHAT THE APP KNOWS, read through the port and read again when something changes: the vault's status, its passwords,
// the requests waiting, and the sandboxes that may be given access. One read at a time; a read that a newer one
// overtook is dropped, so a slow list never paints over a fresh one.

export interface Toast {
    readonly id: number;
    readonly name: string;
    readonly title: string;
    readonly via: string;
    readonly at: number;
    readonly outcome: `saved` | `updated`;
}

export function usePasswordsState(port: PasswordsPort) {
    const status = shallowRef<VaultStatus | undefined>(undefined);
    const items = shallowRef<readonly PasswordItem[]>([]);
    const requests = shallowRef<readonly PasswordRequest[]>([]);
    const sandboxes = shallowRef<readonly SandboxRef[]>([]);
    const readError = ref<string | undefined>(undefined);
    const toasts = ref<Toast[]>([]);
    let generation = 0;
    let toastId = 0;

    const load = async (): Promise<void> => {
        generation += 1;
        const mine = generation;
        try {
            const read = await port.status();
            if (mine !== generation) {
                return;
            }
            status.value = read;
            if (read.kind !== `ready`) {
                return;
            }
            const [list, waiting, linked] = await Promise.all([port.list(), port.requests(), port.sandboxes()]);
            if (mine !== generation) {
                return;
            }
            items.value = list;
            requests.value = waiting;
            sandboxes.value = linked;
            readError.value = undefined;
        } catch (failure) {
            if (mine === generation) {
                readError.value = messageOr(failure, t(`app.error.read`));
            }
        }
    };

    const dismissToast = (id: number): void => {
        toasts.value = toasts.value.filter((toast) => toast.id !== id);
    };

    const hear = (event: PasswordsEvent): void => {
        if (event.kind === `captured`) {
            toastId += 1;
            // The newest on top, and no more than three: a burst of imports is one look at the list, not a wall.
            toasts.value = [{ id: toastId, name: event.name, title: event.title, via: event.via, at: event.at, outcome: event.outcome }, ...toasts.value].slice(0, 3);
        }
        void load();
    };

    // Without a way to hear, a return to the window is when something may have changed.
    const onFocus = (): void => void load();
    let unsubscribe: (() => void) | undefined;
    onMounted(() => {
        void load();
        if (port.subscribe === undefined) {
            window.addEventListener(`focus`, onFocus);
        } else {
            unsubscribe = port.subscribe(hear);
        }
    });
    onBeforeUnmount(() => {
        unsubscribe?.();
        window.removeEventListener(`focus`, onFocus);
    });

    return {
        status,
        items,
        requests,
        sandboxes,
        readError,
        toasts,
        load,
        dismissToast,
        ready: computed(() => (status.value?.kind === `ready` ? status.value : undefined)),
    };
}


