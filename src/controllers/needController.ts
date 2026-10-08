// src/controllers/needController.ts
import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';

// Crear una nueva solicitud de necesidad
export const createNeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { title, description, estimatedBudget } = req.body;
    
    const userId = req.userId;

    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    if (!title || !description) {
      res.status(400).json({ error: 'El título y la descripción son obligatorios' });
      return;
    }

    const newNeed = await prisma.needListing.create({
      data: {
        title,
        description,
        estimatedBudget: estimatedBudget ? Number(estimatedBudget) : null,
        userId
      }
    });

    res.status(201).json(newNeed);
  } catch (error) {
    console.error('Error al crear necesidad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Obtener todas las necesidades abiertas
export const getOpenNeeds = async (req: Request, res: Response): Promise<void> => {
  try {
    const needs = await prisma.needListing.findMany({
      where: {
        status: 'OPEN'
      },
      include: {
        user: {
          select: { name: true, id: true }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.status(200).json(needs);
  } catch (error) {
    console.error('Error al obtener necesidades:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// BRIEF #039: Puente Atómico Financiero (Mercado Inverso -> Fideicomiso)
export const acceptNeedOffer = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const buyerId = req.userId; // El que creó la necesidad es el comprador final
    const { needId, sellerId, agreedAmount } = req.body;

    if (!buyerId || !needId || !sellerId || !agreedAmount) {
      res.status(400).json({ error: 'Faltan datos para concretar el acuerdo.' });
      return;
    }

    // Usamos $transaction para asegurar que si falla la creación del pago, el tablón no se cierre (Idempotencia)
    const result = await prisma.$transaction(async (tx) => {
      // 1. Verificamos la necesidad
      const need = await tx.needListing.findUnique({ where: { id: needId } });
      if (!need) throw new Error('Necesidad no encontrada en el sistema.');
      if (need.userId !== buyerId) throw new Error('Solo el creador del pedido puede aceptar una oferta.');
      if (need.status !== 'OPEN') throw new Error('Esta solicitud ya fue cerrada o completada.');

      // 2. Congelamos el Tablón de Necesidades
      await tx.needListing.update({
        where: { id: needId },
        data: { status: 'FULFILLED' }
      });

      // 3. Calculamos las comisiones (Reglas estándar de la plataforma)
      const amount = Number(agreedAmount);
      const platformFee = amount * 0.05; // Ejemplo: 5% de comisión
      const sellerPayout = amount - platformFee;

      // 4. Generamos atómicamente la Transacción en el Fideicomiso
      const transaction = await tx.transaction.create({
        data: {
          buyerId: buyerId,
          sellerId: sellerId,
          amount: amount,
          platformFee: platformFee,
          sellerPayout: sellerPayout,
          state: 'PENDING',
          paymentGateway: 'MERCADO_PAGO',
        }
      });

      return transaction;
    });

    res.status(200).json({ 
      message: 'Acuerdo cerrado exitosamente. Transacción generada en el Fideicomiso.', 
      transaction: result 
    });

  } catch (error: any) {
    console.error('Error puenteando mercado inverso:', error);
    res.status(400).json({ error: error.message || 'Error interno al procesar el acuerdo.' });
  }
};