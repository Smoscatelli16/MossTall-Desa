// src/controllers/userController.ts
import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';

// 1. DASHBOARD INTEGRAL (MÉTRICAS FINANCIERAS Y GESTIÓN DE ÓRDENES - BRIEF #025)
export const getDashboard = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Usuario no identificado.' });

    // --- AGREGACIONES FINANCIERAS (NATIVAS EN BD) ---
    const retainedAggregation = await prisma.transaction.aggregate({
      where: {
        sellerId: userId,
        state: { in: ['PAID_HELD', 'DISPUTED'] }
      },
      _sum: { sellerFinalAmount: true }
    });
    const retained = Number(retainedAggregation._sum.sellerFinalAmount || 0);

    const releasedAggregation = await prisma.transaction.aggregate({
      where: {
        sellerId: userId,
        state: 'FUNDS_RELEASED'
      },
      _sum: { sellerFinalAmount: true }
    });
    const released = Number(releasedAggregation._sum.sellerFinalAmount || 0);

    // --- HISTORIAL DE ÓRDENES (ÚLTIMAS 20) ---
    const purchases = await prisma.transaction.findMany({
      where: { buyerId: userId, deletedByBuyer: false },
      take: 20, 
      include: {
        product: { select: { title: true, price: true, images: true, id: true, type: true } },
        seller: { select: { name: true, email: true } },
        review: true 
      },
      orderBy: { createdAt: 'desc' }
    });

    const sales = await prisma.transaction.findMany({
      where: { sellerId: userId, deletedBySeller: false },
      take: 20,
      include: {
        product: { select: { title: true, price: true, images: true, id: true, type: true } },
        buyer: { select: { name: true, email: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    // --- NOTIFICACIONES (ADAPTADO A TIENDAS - BRIEF #040) ---
    const pendingQuestions = await prisma.question.findMany({
        where: { product: { store: { ownerId: userId } }, answer: null },
        include: {
            product: { select: { title: true, id: true, images: true } }, 
            asker: { select: { name: true } } 
        },
        orderBy: { createdAt: 'asc' }
    });

    const answersReceived = await prisma.question.findMany({
        where: { askerId: userId, answer: { not: null }, isReadByAsker: false },
        include: {
            product: { select: { title: true, id: true, images: true } },
            asker: { select: { name: true } }
        },
        orderBy: { updatedAt: 'desc' } 
    });

    const pendingReviews = await prisma.transaction.findMany({
        where: { buyerId: userId, state: 'FUNDS_RELEASED', review: null },
        include: {
            seller: { select: { id: true, name: true } },
            product: { select: { title: true } }
        }
    });

    // --- ESTRUCTURA JSON UNIFICADA ---
    res.json({ 
      metrics: { retained, released }, 
      orders: { purchases, sales },
      notifications: { pendingQuestions, answersReceived, pendingReviews }
    });

  } catch (error) {
    console.error('Error en dashboard:', error);
    res.status(500).json({ error: 'Error al cargar el panel.' });
  }
};

// 2. OBTENER PERFIL PROFESIONAL (EDICIÓN)
export const getUserProfile = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const profile = await prisma.professionalProfile.findUnique({
            where: { userId }
        });
        res.json(profile || null);
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({ error: 'Error al cargar perfil.' });
    }
};

// 3. GUARDAR/ACTUALIZAR PERFIL (UPSERT)
export const updateUserProfile = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const { profession, biography, experienceYears, education, portfolioImages, certifications } = req.body;

        const profile = await prisma.professionalProfile.upsert({
            where: { userId },
            update: {
                profession, biography,
                experienceYears: experienceYears ? Number(experienceYears) : null,
                education,
                portfolioImages: portfolioImages || [],
                certifications: certifications || []
            },
            create: {
                userId: userId!,
                profession, biography,
                experienceYears: experienceYears ? Number(experienceYears) : null,
                education,
                portfolioImages: portfolioImages || [],
                certifications: certifications || []
            }
        });

        res.json(profile);
    } catch (error) {
        console.error('Error saving profile:', error);
        res.status(500).json({ error: 'Error al guardar perfil.' });
    }
};

// 4. PERFIL PÚBLICO (VISTA CLIENTE)
export const getPublicProfile = async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true, 
                name: true, 
                createdAt: true,
                professionalProfile: true,
                reviewsReceived: {
                    include: { reviewer: { select: { name: true } } },
                    orderBy: { createdAt: 'desc' }
                },
                stores: {
                    include: {
                        products: {
                            where: { status: 'DISPONIBLE' },
                            select: { 
                                id: true, title: true, price: true, type: true, images: true,
                                category: { select: { name: true } } 
                            }
                        }
                    }
                }
            }
        });

        if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
        res.json(user);
    } catch (error) {
        console.error('Error fetching public profile:', error);
        res.status(500).json({ error: 'Error al cargar perfil público.' });
    }
};

// --- IMPLEMENTACIÓN BRIEF #018 / #040: SISTEMA BANCARIO (TIENDA / PAY-OUT BIND) ---

// 5. OBTENER DATOS BANCARIOS (CBU/CVU) DESDE LA TIENDA DEL USUARIO
export const getBankingDetails = async (req: AuthRequest, res: Response) => {
    try {
        const store = await prisma.store.findFirst({ 
            where: { ownerId: req.userId }, 
            select: { cbu: true, cvu: true, alias: true } 
        });
        res.json(store || { cbu: null, cvu: null, alias: null });
    } catch (error) {
        console.error('Error fetching banking details:', error);
        res.status(500).json({ error: 'Error al cargar datos bancarios.' });
    }
};

// 6. ACTUALIZAR DATOS BANCARIOS (PATCH) EN LA TIENDA
export const updateBankingDetails = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        let { cbu, cvu, alias } = req.body;

        if (!userId) return res.status(401).json({ error: 'No autorizado' });

        if (cbu) cbu = String(cbu).replace(/\D/g, '');
        if (cvu) cvu = String(cvu).replace(/\D/g, '');

        const exact22Digits = /^\d{22}$/;

        if (cbu && !exact22Digits.test(cbu)) {
            return res.status(400).json({ error: 'El CBU debe tener exactamente 22 dígitos numéricos.' });
        }
        if (cvu && !exact22Digits.test(cvu)) {
            return res.status(400).json({ error: 'El CVU debe tener exactamente 22 dígitos numéricos.' });
        }

        // Buscamos la tienda del usuario o creamos una por defecto si no tiene
        let store = await prisma.store.findFirst({ where: { ownerId: userId } });
        
        if (!store) {
            store = await prisma.store.create({
                data: {
                    name: 'Mi Tienda',
                    ownerId: userId,
                    cbu: cbu || null,
                    cvu: cvu || null,
                    alias: alias || null
                } as any
            });
        } else {
            store = await prisma.store.update({
                where: { id: store.id },
                data: { 
                    cbu: cbu || null, 
                    cvu: cvu || null, 
                    alias: alias || null 
                }
            });
        }

        res.json({ 
            message: 'Datos bancarios validados y actualizados correctamente', 
            banking: { cbu: store.cbu, cvu: store.cvu, alias: store.alias } 
        });
    } catch (error) {
        console.error('Error actualizando datos bancarios:', error);
        res.status(500).json({ error: 'Error interno del servidor al actualizar datos bancarios.' });
    }
};

// 7. OBTENER MIS PEDIDOS (MERCADO INVERSO) PARA EL DASHBOARD
export const getMyNeeds = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const needs = await prisma.needListing.findMany({
            where: { userId: userId },
            orderBy: { createdAt: 'desc' }
        });
        res.json(needs);
    } catch (error) {
        console.error('Error fetching my needs:', error);
        res.status(500).json({ error: 'Error al cargar pedidos del Mercado Inverso.' });
    }
};