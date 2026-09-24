-- The edge's wildcard certificate per ingress zone, ordered by the platform and fetched by every edge machine.
-- CreateTable
CREATE TABLE "edge_certificate" (
    "zone" TEXT NOT NULL,
    "certificate" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_certificate_pkey" PRIMARY KEY ("zone")
);

