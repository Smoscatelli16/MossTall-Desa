// src/controllers/needController.ts
import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';
import { Resend } from 'resend';

// Inicializamos Resend para las notificaciones del Matchmaking
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Crear una nueva solicitud de necesidad
export const createNeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Se agrega categoryId para asociar el pedido a un rubro
    const { title, description, estimatedBudget, categoryId } = req.body;
    
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
        userId,
        // Guardamos la categoría si viene en la petición y si existe en tu esquema de Prisma
        ...(categoryId && { categoryId })
      }
    });

    // --- ALGORITMO DE MATCHMAKING (TASK 8.2) OPTIMIZADO ---
    // Buscamos a los dueños de tiendas para notificarles la nueva oportunidad
    try {
        if (resend) {
            const potentialStores = await prisma.store.findMany({
                where: { 
                    ownerId: { not: userId }, // No enviarle mail al mismo usuario que pide
                    ...(categoryId && { categoryId }) // Filtro inteligente por rubro/categoría
                },
                include: { owner: true },
                take: 5, // Reducido a 5 para apuntar mejor y cuidar los costos del plan gratuito
                orderBy: { createdAt: 'desc' }
            });

            // Disparamos notificaciones por correo de manera asíncrona
            for (const store of potentialStores) {
                if (store.owner.email) {
                    resend.emails.send({
                        from: 'Mission Vende <onboarding@resend.dev>',
                        to: store.owner.email,
                        subject: '🔥 ¡Nueva oportunidad de venta en Mercado Inverso!',
                        html: `
                            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
                                <h3 style="color: #1a237e;">Hola ${store.owner.name || store.name},</h3>
                                <p>Un comprador en Mission Vende acaba de publicar una solicitud que coincide exactamente con tu rubro:</p>
                                <div style="background-color: #f8fafc; padding: 15px; border-left: 4px solid #1a237e; margin: 20px 0;">
                                    <strong>${title}</strong><br/>
                                    <p style="color: #64748b;">${description}</p>
                                    <p style="margin-top: 10px; font-weight: bold;">💰 Presupuesto estimado: $${estimatedBudget || 'A convenir'}</p>
                                </div>
                                <p>Ingresá al Mercado Inverso para ver los detalles y enviarle tu propuesta antes que la competencia.</p>
                                <a href="https://mosstall-desa-production.up.railway.app/mercado-inverso" style="display: inline-block; background-color: #1a237e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">Hacer una oferta</a>
                            </div>
                        `
                    }).catch(e => console.error("Error enviando email de matchmaking:", e));
                }
            }
        }
    } catch (matchError) {
        console.error('Error silencioso en algoritmo de matchmaking:', matchError);
    }
    // -------------------------------------------

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