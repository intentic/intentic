import { z } from "zod";
import { childElements, textOf } from "../dom.js";

// ETSI TS 119 612 trusted lists, read into the little this verifier needs: per service its type, its certificates and
// its status over time; per list the pointers to other lists (the EU list of lists names every member state's list and
// the certificates that sign it). Read off the DOM by local name, so namespace prefixes do not matter.

export const SERVICE_TYPE = {
    caQualified: "http://uri.etsi.org/TrstSvc/Svctype/CA/QC",
    timestampQualified: "http://uri.etsi.org/TrstSvc/Svctype/TSA/QTST",
} as const;

export const TSL_MIME = "application/vnd.etsi.tsl+xml";

const StatusPeriodSchema = z.object({ status: z.string(), from: z.string() });

export const TrustedServiceSchema = z.object({
    territory: z.string(),
    provider: z.string(),
    name: z.string(),
    type: z.string(),
    // Base64 DER of every X509Certificate the service's digital identity lists.
    certificates: z.array(z.string()),
    // Newest first: the current status, then each ServiceHistoryInstance.
    history: z.array(StatusPeriodSchema),
    qualifiers: z.array(z.string()),
});
export type TrustedService = z.infer<typeof TrustedServiceSchema>;

export const ListPointerSchema = z.object({
    territory: z.string(),
    location: z.string(),
    mimeType: z.string(),
    certificates: z.array(z.string()),
});
export type ListPointer = z.infer<typeof ListPointerSchema>;

export interface TrustedListContent {
    readonly territory: string;
    readonly sequenceNumber: string;
    readonly issued: string;
    readonly nextUpdate: string;
    readonly services: readonly TrustedService[];
    readonly pointers: readonly ListPointer[];
}

const children = childElements;

const child = (parent: Element | undefined, localName: string): Element | undefined => children(parent, localName)[0];

const path = (parent: Element | undefined, ...names: string[]): Element | undefined => names.reduce<Element | undefined>((node, name) => child(node, name), parent);

// A multilingual name: English when there is one, else the first.
const nameIn = (holder: Element | undefined): string => {
    const names = children(holder, "Name");
    return textOf(names.find((name) => name.getAttribute("xml:lang") === "en") ?? names[0]);
};

const certificatesIn = (identity: Element | undefined): string[] =>
    children(identity, "DigitalId")
        .map((id) => textOf(child(id, "X509Certificate")).replaceAll(/\s/g, ""))
        .filter((value) => value !== "");

const qualifiersIn = (information: Element | undefined): string[] => {
    const extensions = child(information, "ServiceInformationExtensions");
    const found: string[] = [];
    for (const extension of children(extensions, "Extension")) {
        for (const element of Array.from(extension.getElementsByTagName("*"))) {
            if (element.localName === "Qualifier") {
                found.push(element.getAttribute("uri") ?? "");
            }
            if (element.localName === "AdditionalServiceInformation") {
                found.push(textOf(child(element, "URI")));
            }
        }
    }
    return found.filter((value) => value !== "");
};

const serviceOf = (territory: string, provider: string, service: Element): TrustedService => {
    const information = child(service, "ServiceInformation");
    const history = children(child(service, "ServiceHistory"), "ServiceHistoryInstance").map((instance) => ({
        status: textOf(child(instance, "ServiceStatus")),
        from: textOf(child(instance, "StatusStartingTime")),
    }));
    return {
        territory,
        provider,
        name: nameIn(child(information, "ServiceName")),
        type: textOf(child(information, "ServiceTypeIdentifier")),
        certificates: certificatesIn(child(information, "ServiceDigitalIdentity")),
        history: [{ status: textOf(child(information, "ServiceStatus")), from: textOf(child(information, "StatusStartingTime")) }, ...history].toSorted((left, right) =>
            right.from.localeCompare(left.from),
        ),
        qualifiers: qualifiersIn(information),
    };
};

const pointerOf = (pointer: Element): ListPointer => {
    const information = children(child(pointer, "AdditionalInformation"), "OtherInformation");
    const valueOf = (name: string): string => information.flatMap((entry) => children(entry, name)).map((element) => textOf(element))[0] ?? "";
    return {
        territory: valueOf("SchemeTerritory"),
        location: textOf(child(pointer, "TSLLocation")),
        mimeType: valueOf("MimeType"),
        certificates: children(child(pointer, "ServiceDigitalIdentities"), "ServiceDigitalIdentity").flatMap((identity) => certificatesIn(identity)),
    };
};

export const readTrustedList = (document: Document): TrustedListContent => {
    const root = document.documentElement;
    if (root === null || root.localName !== "TrustServiceStatusList") {
        throw new Error("not an ETSI trusted list (no TrustServiceStatusList)");
    }
    const scheme = child(root, "SchemeInformation");
    const territory = textOf(child(scheme, "SchemeTerritory"));
    const services = children(child(root, "TrustServiceProviderList"), "TrustServiceProvider").flatMap((provider) => {
        const name = nameIn(path(provider, "TSPInformation", "TSPName"));
        return children(child(provider, "TSPServices"), "TSPService").map((service) => serviceOf(territory, name, service));
    });
    return {
        territory,
        sequenceNumber: textOf(child(scheme, "TSLSequenceNumber")),
        issued: textOf(child(scheme, "ListIssueDateTime")),
        nextUpdate: textOf(path(scheme, "NextUpdate", "dateTime")),
        services,
        pointers: children(child(scheme, "PointersToOtherTSL"), "OtherTSLPointer").map(pointerOf),
    };
};

// The status a service had at a moment: the newest period that started at or before it.
export const statusAt = (service: TrustedService, at: Date): string | undefined =>
    service.history.find((period) => {
        const from = Date.parse(period.from);
        return !Number.isNaN(from) && from <= at.getTime();
    })?.status;
