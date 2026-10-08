// src/controllers/reviewController.ts
import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';

export const createReview = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const { transactionId, rating, comment } = req.body;

        if (!transactionId || !rating) {
            return res.status(400).json({ error: 'Faltan datos obligatorios para la reseña.' });
        }

        // 1. Verificamos la transacción E INCLUIMOS LA RESEÑA (Idempotencia Atómica)
        const transaction = await prisma.transaction.findUnique({
            where: { id: transactionId },
            include: { review: true } // BRIEF #039: Traemos la reseña ligada en la misma query
        });

        if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });
        if (transaction.buyerId !== userId) return res.status(403).json({ error: 'Solo el comprador puede dejar una reseña.' });
        
        // La transacción debe estar finalizada para poder calificar
        if (transaction.state !== 'FUNDS_RELEASED') {
             return res.status(400).json({ error: 'Solo puedes calificar compras finalizadas.' });
        }

        // BRIEF #039: Bloqueo de Idempotencia estricto
        if (transaction.review) {
            return res.status(409).json({ error: 'Ya has calificado esta compra.' });
        }

        // 3. Creamos la reseña y actualizamos el Trust Score del vendedor atómicamente
        const review = await prisma.$transaction(async (tx) => {
            // A. Creamos la reseña
            const newReview = await tx.review.create({
                data: {
                    rating: Number(rating),
                    comment: comment || null,
                    transactionId: transactionId,
                    reviewerId: userId,
                    reviewedId: transaction.sellerId
                }
            });

            // B. Recalculamos el promedio del vendedor
            const allReviews = await tx.review.aggregate({
                where: { reviewedId: transaction.sellerId },
                _avg: { rating: true },
                _count: { rating: true }
            });

            const newAverage = allReviews._avg.rating || 0;
            const reviewCount = allReviews._count.rating || 0;

            // C. Actualizamos el perfil público del vendedor con el nuevo Trust Score
            await tx.user.update({
                where: { id: transaction.sellerId },
                data: {
                    ratingAverage: newAverage,
                    totalReviews: reviewCount
                }
            });

            return newReview;
        });

        res.status(201).json({ message: 'Reseña guardada con éxito', review });

    } catch (error) {
        console.error('Error al crear reseña:', error);
        res.status(500).json({ error: 'Error interno al procesar la calificación.' });
    }
};