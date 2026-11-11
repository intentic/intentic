import { evaluateWhen, parseWhen } from "@intentic/base/when";
import type { AddCapabilityInput, CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import { stashedMarker } from "@intentic/sandbox-contract/schemas/capabilities";
import type { DeviceSignInStart, DeviceSignInWait } from "@intentic/sandbox-contract/schemas/device-sign-in";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { ref, shallowRef } from "vue";
import type { FormValues } from "../form";

// Sign in with Microsoft, as the form drives it: the sandbox asks Microsoft for a one-time code (a device-code sign-in,
// declared on the card as `refreshToken.deviceCode`), the person types it on Microsoft's own page in a new tab, and the
// sandbox, asked while the form waits, finds out when they are done. Microsoft's endpoints answer no browser, which is
// why the sandbox asks and not this page. The token stays in the sandbox: the field gets a stash marker for the
// ordinary Save to install, as a generated SSH key's private half does.

// The field the sign-in stands in for, while the card's declaration holds for these answers (`!clientSecret`: an app
// with a secret of its own pastes the token its own flow made, so the plain box comes back).
export const signsInWithMicrosoft = (entry: CapabilityCatalogEntry, field: CapabilityField, values: Readonly<FormValues>): boolean =>
    field.signIn === `microsoft` && (entry.signInWhen === undefined || evaluateWhen(parseWhen(entry.signInWhen), values));

// Microsoft's own mark, the four squares its sign-in buttons carry, drawn here: simple-icons does not carry it.
export const MICROSOFT_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>`;

export interface DeviceSignInCalls {
    readonly start: (input: AddCapabilityInput) => Promise<DeviceSignInStart>;
    readonly wait: (flow: string) => Promise<DeviceSignInWait>;
}

// A finished sign-in, as the form keeps it: the marker it put in the field, and what to say about it.
export interface MicrosoftGrant {
    readonly marker: string;
    readonly who: string | undefined;
    readonly granted: readonly string[];
    // The fields it is only good for as they are now: changing one before Save needs a new sign-in.
    readonly bound: readonly string[];
}

export type SignInPhase =
    | { readonly kind: `idle` }
    | { readonly kind: `starting` }
    | { readonly kind: `waiting`; readonly code: string; readonly page: string };

const IDLE: SignInPhase = { kind: `idle` };

// One form's sign-in: start, show the code, and wait with the sandbox until it ends. A newer start, a cancel or a
// closed form ends the wait; a late answer for an attempt that was let go is dropped.
export const useDeviceSignIn = (calls: DeviceSignInCalls) => {
    const phase = shallowRef<SignInPhase>(IDLE);
    const problem = ref<string>();
    let attempt = 0;
    // Whether an attempt is still the one the form shows: a newer start or a cancel lets it go, between two awaits.
    const live = (mine: number): boolean => mine === attempt;

    const waitFor = async (mine: number, flow: string): Promise<MicrosoftGrant | undefined> => {
        while (live(mine)) {
            let said: DeviceSignInWait;
            try {
                said = await calls.wait(flow);
            } catch (error) {
                if (live(mine)) {
                    phase.value = IDLE;
                    problem.value = messageOr(error, t(`capabilities.microsoftSignInField.couldntFinish`));
                }
                return undefined;
            }
            if (!live(mine) || said.state === `waiting`) {
                continue;
            }
            phase.value = IDLE;
            if (said.state === `failed`) {
                problem.value = said.message;
                return undefined;
            }
            return { marker: stashedMarker(said.token), who: said.who, granted: said.granted, bound: said.bound };
        }
        return undefined;
    };

    // Resolves with the grant once someone has signed in; undefined when it failed or was let go.
    const begin = async (input: AddCapabilityInput): Promise<MicrosoftGrant | undefined> => {
        attempt += 1;
        const mine = attempt;
        problem.value = undefined;
        phase.value = { kind: `starting` };
        let started: DeviceSignInStart;
        try {
            started = await calls.start(input);
        } catch (error) {
            if (live(mine)) {
                phase.value = IDLE;
                problem.value = messageOr(error, t(`capabilities.microsoftSignInField.couldntStart`));
            }
            return undefined;
        }
        if (!live(mine)) {
            return undefined;
        }
        phase.value = { kind: `waiting`, code: started.userCode, page: started.verificationUri };
        return waitFor(mine, started.flow);
    };

    const cancel = (): void => {
        attempt += 1;
        phase.value = IDLE;
    };

    return { phase, problem, begin, cancel };
};

// The line under a fresh sign-in: what Microsoft granted, by each permission's short name.
export const grantedLine = (granted: readonly string[]): string =>
    granted.length === 0
        ? t(`capabilities.microsoftSignInField.savingStores`)
        : t(`capabilities.microsoftSignInField.granted`, { permissions: granted.join(`, `) });
