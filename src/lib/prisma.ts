// src/lib/prisma.ts
import { PrismaClient } from '@prisma/client';

// Creamos una única instancia para usar en toda la app
const prisma = new PrismaClient();

export default prisma;