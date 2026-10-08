// src/routes/reviewRoutes.ts
import { Router } from 'express';
import { createReview } from '../controllers/reviewController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// POST /api/reviews
router.post('/', authMiddleware, createReview);

export default router;