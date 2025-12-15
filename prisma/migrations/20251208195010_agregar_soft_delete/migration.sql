-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "deletedByBuyer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deletedBySeller" BOOLEAN NOT NULL DEFAULT false;
