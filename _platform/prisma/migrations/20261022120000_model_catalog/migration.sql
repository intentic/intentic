CREATE TABLE "model_catalog" (
    "provider" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "models" JSONB NOT NULL,
    CONSTRAINT "model_catalog_pkey" PRIMARY KEY ("provider")
);
