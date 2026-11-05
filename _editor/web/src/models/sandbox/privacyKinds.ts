import type { PersonalDataClass } from "@intentic/sandbox-contract/schemas/privacy";
import { t } from "@intentic/ui/i18n";

// Each kind of personal data by its short name, as a chip beside a value says it (the activity's, the tried text's), for
// the surfaces outside the privacy page that name a kind too: a leak reported from a chat. Read inside a computed, so a
// language change redraws it.
export const shortKindNames = () =>
    ({
        "person-name": t(`sandbox.agentPrivacyShield.short.personName`),
        "national-id": t(`sandbox.agentPrivacyShield.short.nationalId`),
        "tax-id": t(`sandbox.agentPrivacyShield.short.taxId`),
        "identity-document": t(`sandbox.agentPrivacyShield.short.identityDocument`),
        "bank-account": t(`sandbox.agentPrivacyShield.short.bankAccount`),
        "payment-card": t(`sandbox.agentPrivacyShield.short.paymentCard`),
        email: t(`sandbox.agentPrivacyShield.short.email`),
        phone: t(`sandbox.agentPrivacyShield.short.phone`),
        address: t(`sandbox.agentPrivacyShield.short.address`),
    }) satisfies Record<PersonalDataClass, string>;
