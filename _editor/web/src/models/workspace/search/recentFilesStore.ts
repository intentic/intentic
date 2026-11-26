import { sandboxRef, sandboxValue } from "@intentic/extension-api";
import { z } from "zod";
import { recentFilesKey, storedJson, storeJson } from "../../../app/storage/browserStorage";
import { useSandboxScope } from "../../../client/sandbox/scope/useSandboxScope";
import { KEEP, remembered } from "./recentFiles";

// Where quick-open's remembered files live (recentFiles.ts has the rule): per sandbox, since a path names a file in one
// sandbox's /work, and in localStorage, the account's, so sign-out takes it, like the composer's prompt history.

// A list of paths; an entry that is not text is skipped rather than costing the rest.
const StoredRecentSchema = z.array(z.unknown()).transform((entries) => entries.filter((entry): entry is string => typeof entry === `string`));

// Read once per sandbox scope; the sandbox is recorded at restore, not read live, so a write mid-switch cannot land in
// the incoming sandbox's key. A module-level store: the scope it stands in is the active sandbox's, as the tabs' is.
const scope = useSandboxScope();
const scopedSandboxId = sandboxValue<string | undefined>(() => scope.id.value);
const recent = sandboxRef<readonly string[]>(() => {
    const id = scopedSandboxId.value;
    return id === undefined ? [] : (storedJson(recentFilesKey(id), StoredRecentSchema) ?? []).slice(0, KEEP);
});

/** This sandbox's remembered files, most recent first. */
export const recentFiles = (): readonly string[] => recent.value;

/** Records a file opened. Storage full or blocked keeps it for this page's lifetime. */
export const rememberFile = (path: string): void => {
    recent.value = remembered(recent.value, path);
    const id = scopedSandboxId.value;
    if (id !== undefined) {
        storeJson(recentFilesKey(id), recent.value);
    }
};
