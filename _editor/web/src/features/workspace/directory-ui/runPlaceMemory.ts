import { z } from "zod";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { runPlaceKey, storedJson, storeJson } from "../../../app/storage/browserStorage";

// WHERE EACH REPOSITORY WAS LAST RUN FROM: the Run dialog's place (the sandbox or a computer's id), picked by the reader,
// kept per sandbox in this browser so the dialog opens on it again instead of on its default, which had the owner switch
// to his own computer on every open. Read once per open; a place no longer offered is ignored there (runRows.ts
// `openingPlace`), not cleaned up here.

const PlacesSchema = z.record(z.string(), z.string());

const keyNow = (): string => runPlaceKey(activeSandboxId.value ?? `none`);

export const rememberedPlace = (repo: string): string | undefined => storedJson(keyNow(), PlacesSchema)?.[repo];

export const rememberPlace = (repo: string, place: string): void => {
    const key = keyNow();
    storeJson(key, { ...storedJson(key, PlacesSchema), [repo]: place });
};
