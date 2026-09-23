import { sandboxRef } from "@intentic/extension-api";
import type { Router } from "vue-router";
import { storedValue, storeValue } from "../../lib/browserStorage";
import { useSandbox } from "../sandbox/client/useSandbox";
import { ADDRESS_TARGET_ID } from "./previewModel";

// The preview panel's own state (target, whether it exists), module-level like useChat/useLayout since the panel mounts
// above the router. `opened` is the panel's existence: nothing mounts until the user first looks, and once opened it
// stays mounted so the app's own state survives switching away.

// Last-shown target and typed address, keyed by sandbox so they return on reload; the id is re-validated against the
// live target list on read (previewModel.pickTarget).
const targetKey = (sandboxId: string | undefined): string => `intentic-preview-target:${sandboxId ?? ``}`;
const addressKey = (sandboxId: string | undefined): string => `intentic-preview-address:${sandboxId ?? ``}`;

// A switch closes the parked panel rather than keep the outgoing sandbox's app loaded, and brings back the incoming
// one's own last target. A floating window re-marks itself opened on arrival (pages/FloatingSection.vue).
const opened = sandboxRef(() => false);
const selectedId = sandboxRef<string | undefined>(() => storedValue(targetKey(useSandbox().activeSandboxId.value)));
const address = sandboxRef<string | undefined>(() => storedValue(addressKey(useSandbox().activeSandboxId.value)));

export const previewOpened = opened;
export const previewSelectedId = selectedId;
// The address the user typed, as text, turned into a target (or refused) by previewModel.addressTarget.
export const previewAddress = address;

export const selectPreviewTarget = (id: string): void => {
    selectedId.value = id;
    storeValue(targetKey(useSandbox().activeSandboxId.value), id);
};

// Points the preview at a typed address. Stores raw text, not a parsed URL; whether it names anything is
// addressTarget's judgement, and typing one also selects it.
export const setPreviewAddress = (typed: string): void => {
    const trimmed = typed.trim();
    address.value = trimmed === `` ? undefined : trimmed;
    storeValue(addressKey(useSandbox().activeSandboxId.value), address.value ?? ``);
    if (address.value !== undefined) {
        selectPreviewTarget(ADDRESS_TARGET_ID);
    }
};

export const markPreviewOpened = (): void => {
    opened.value = true;
};

// Entry point for the palette command and for an extension's "See it" (the rail tile just routes): selects a target
// (or a repo, resolved via pickTarget), opens the panel, and navigates to it.
export const openPreview = (router: Router, targetId?: string): void => {
    if (targetId !== undefined) {
        selectPreviewTarget(targetId);
    }
    markPreviewOpened();
    void router.push(`/preview`);
};

// Opens the preview once per sandbox, on first visit only; the user's later choice (open or closed) always wins after
// that. Stored, not in-memory, so the flag survives a reload; returns whether it opened.
const autoShownKey = (sandboxId: string | undefined): string => `intentic-preview-autoshown:${sandboxId ?? ``}`;

export const openPreviewOnFirstVisit = (router: Router, targetId: string): boolean => {
    const key = autoShownKey(useSandbox().activeSandboxId.value);
    if (storedValue(key) !== undefined) {
        return false;
    }
    storeValue(key, `1`);
    openPreview(router, targetId);
    return true;
};

// Toggle lives in previewFloating.ts, not here: the floating surface touches `window` at module scope, and this state
// module stays importable without one.
