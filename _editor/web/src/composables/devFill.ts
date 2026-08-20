import { environment } from "../environments/environment";

/* Dev-only autofill for pasted secrets: remembers the last saved value per key in localStorage and offers it
 * back after a sandbox/db reset, so local development never re-pastes the same token twice. Inert in
 * production, get returns undefined, set is a no-op. Keys are namespaced: `secret.<ENV_KEY>` for sandbox .env
 * secrets, `capability.<entryId>.<fieldKey>` for capability form fields (entry-scoped because field keys like
 * `token` repeat across cards). */

const PREFIX = `intentic.devfill.`;

export const devFillGet = (key: string): string | undefined => {
    if (environment.production) {
        return undefined;
    }
    return localStorage.getItem(`${PREFIX}${key}`) ?? undefined;
};

export const devFillSet = (key: string, value: string): void => {
    if (environment.production || value === ``) {
        return;
    }
    localStorage.setItem(`${PREFIX}${key}`, value);
};
