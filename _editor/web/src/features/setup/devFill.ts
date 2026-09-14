import { environment } from "../../app/environments/environment";

/* Dev-only autofill for pasted secrets: remembers the last saved value per key in localStorage and offers it back after a sandbox/db reset. */

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
