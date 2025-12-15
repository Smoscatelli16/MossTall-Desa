-- CreateEnum
CREATE TYPE "ProductCondition" AS ENUM ('NUEVO', 'USADO', 'REACONDICIONADO');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "condition" "ProductCondition",
ADD COLUMN     "mileage" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "year" INTEGER;
