// src/controllers/storeController.ts
import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';

// 1. OBTENER TIENDAS PÚBLICAS
export const getStores = async (req: Request, res: Response) => {
    try {
        const stores = await prisma.store.findMany({
            include: { owner: { select: { name: true } } },
            orderBy: { createdAt: 'desc' }
        });
        res.json(stores);
    } catch (error) {
        console.error('Error al obtener tiendas:', error);
        res.status(500).json({ error: 'Error interno al cargar tiendas.' });
    }
};

// 2. OBTENER MIS TIENDAS (PROTEGIDO)
export const getMyStores = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const stores = await prisma.store.findMany({
            where: { ownerId: userId },
            orderBy: { createdAt: 'desc' }
        });
        res.json(stores);
    } catch (error) {
        console.error('Error al obtener mis tiendas:', error);
        res.status(500).json({ error: 'Error interno al cargar tus tiendas.' });
    }
};

// 3. OBTENER UNA TIENDA POR ID (PÚBLICO)
export const getStoreById = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const store = await prisma.store.findUnique({
            where: { id },
            include: {
                owner: {
                    select: {
                        id: true,
                        name: true,
                        professionalProfile: true
                    }
                },
                products: {
                    where: { 
                        status: 'DISPONIBLE',
                        stock: { gt: 0 }
                    },
                    orderBy: { createdAt: 'desc' },
                    include: { category: { select: { name: true } } }
                }
            }
        });

        if (!store) return res.status(404).json({ error: 'Tienda o perfil no encontrado.' });

        res.json(store);
    } catch (error) {
        console.error('Error al obtener la tienda:', error);
        res.status(500).json({ error: 'Error interno al cargar la tienda.' });
    }
};

// 4. CREAR TIENDA CON MURO KYC (PROTEGIDO)
export const createStore = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        // Se agrega `dni` al destructuring para capturarlo en el salto comercial
        const { name, description, logoUrl, bannerUrl, type, cbu, cvu, alias, dni } = req.body;

        if (!name) return res.status(400).json({ error: 'El nombre de la tienda es obligatorio.' });
        
        // BRIEF #040: El CBU/CVU es obligatorio para el nuevo modelo comercial
        if (!cbu && !cvu) return res.status(400).json({ error: 'Debes proporcionar un CBU o CVU para recibir pagos.' });
        
        // --- MURO KYC COMERCIAL: Validación en tiempo real ---
        const user = await prisma.user.findUnique({ where: { id: userId! } });
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

        // Si el usuario no tiene DNI registrado y no lo está enviando en el formulario
        if (!user.dni && !dni) {
            return res.status(403).json({ 
                error: 'KYC_REQUIRED', 
                message: 'Para abrir una tienda y recibir pagos, es obligatorio validar tu identidad ingresando tu DNI.' 
            });
        }
        // ----------------------------------------------------

        // Validar que el tipo sea uno de los permitidos en la nueva arquitectura
        const validTypes = ['PRODUCT_STORE', 'SERVICE_PROFESSIONAL', 'DIGITAL_CREATOR'];
        const storeType = validTypes.includes(type) ? type : 'PRODUCT_STORE';

        // BRIEF #041: Requisito de Perfil Profesional
        if (storeType === 'SERVICE_PROFESSIONAL') {
            const profProfile = await prisma.professionalProfile.findUnique({
                where: { userId: userId! }
            });

            // Requerimos que al menos existan credenciales o formación cargadas
            if (!profProfile || (!profProfile.certifications.length && !profProfile.education)) {
                return res.status(403).json({ 
                    error: 'Requisito profesional incompleto. Debes configurar tu formación o matrícula en tu Perfil Profesional antes de abrir una tienda de servicios.' 
                });
            }
        }

        // --- TRANSACCIÓN ATÓMICA: Empalme KYC y Alta de Tienda ---
        const result = await prisma.$transaction(async (tx) => {
            // Si el usuario envió su DNI ahora, lo guardamos para blanquear su identidad
            if (!user.dni && dni) {
                await tx.user.update({
                    where: { id: userId! },
                    data: { dni: dni }
                });
            }

            // Creamos la tienda acoplada al usuario
            const newStore = await tx.store.create({
                data: {
                    name, description, logoUrl, bannerUrl, 
                    type: storeType, 
                    cbu: cbu || null,
                    cvu: cvu || null,
                    alias: alias || null,
                    ownerId: userId!
                } as any
            });

            return newStore;
        });

        res.status(201).json(result);
    } catch (error: any) {
        // Manejo de error si otro usuario ya registró el mismo DNI
        if (error.code === 'P2002' && error.meta?.target?.includes('dni')) {
            return res.status(409).json({ error: 'El DNI ingresado ya se encuentra vinculado a otro perfil comercial.' });
        }
        console.error('Error al crear tienda:', error);
        res.status(500).json({ error: 'Error interno al crear la tienda.' });
    }
};

// 5. ACTUALIZAR TIENDA (PROTEGIDO)
export const updateStore = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.userId;
        const { name, description, logoUrl, bannerUrl, type, cbu, cvu, alias } = req.body;

        const store = await prisma.store.findUnique({ where: { id } });
        if (!store) return res.status(404).json({ error: 'Tienda no encontrada.' });
        if (store.ownerId !== userId) return res.status(403).json({ error: 'No tienes permiso para editar esta tienda.' });

        // Validar tipo si se intenta cambiar
        let updateType = store.type;
        if (type) {
             const validTypes = ['PRODUCT_STORE', 'SERVICE_PROFESSIONAL', 'DIGITAL_CREATOR'];
             if(validTypes.includes(type)) updateType = type;
        }

        const updatedStore = await prisma.store.update({
            where: { id },
            data: { 
                name, description, logoUrl, bannerUrl, 
                type: updateType, 
                cbu, cvu, alias 
            } as any
        });

        res.json(updatedStore);
    } catch (error) {
        console.error('Error al actualizar tienda:', error);
        res.status(500).json({ error: 'Error interno al actualizar la tienda.' });
    }
};