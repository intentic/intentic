import { INVENTORY_SERVICES, type InventoryServiceDescriptor } from "@intentic/capability-catalog";
import type { ServiceKind } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// INVENTORY_SERVICES says what each self-hosted service is in English; its name is the vendor's and stays. These are
// the Add-a-want dialog's words for the line under it, keyed by the service; serviceWords.test.ts holds the English
// copy equal to the package's, and a line the package has since changed keeps the package's English.
const DESCRIPTIONS: Readonly<Record<ServiceKind, () => string>> = {
    signoz: () => t(`views.inventoryServices.signoz`),
    outline: () => t(`views.inventoryServices.outline`),
    paperless: () => t(`views.inventoryServices.paperless`),
    openproject: () => t(`views.inventoryServices.openproject`),
    invoiceninja: () => t(`views.inventoryServices.invoiceninja`),
    infisical: () => t(`views.inventoryServices.infisical`),
};

const PACKAGE: ReadonlyMap<string, string> = new Map(INVENTORY_SERVICES.map((service) => [service.service, service.description]));

/** The line under a service's name, in the reader's language. */
export const serviceDescription = (service: Pick<InventoryServiceDescriptor, `service` | `description`>): string =>
    PACKAGE.get(service.service) === service.description ? DESCRIPTIONS[service.service]() : service.description;
