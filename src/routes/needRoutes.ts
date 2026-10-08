// src/routes/needRoutes.ts
import { Router } from 'express';
import { createNeed, getOpenNeeds } from '../controllers/needController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// Rutas base: /api/needs
router.post('/', authMiddleware, createNeed);
router.get('/', getOpenNeeds); // Público para que todos puedan ver las necesidades

export default router;