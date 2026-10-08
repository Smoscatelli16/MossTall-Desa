// src/controllers/chatController.ts
import { Response } from 'express';
import { Resend } from 'resend';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// 1. OBTENER MIS CHATS (INBOX)
export const getInbox = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.userId;
        const chats = await prisma.chatRoom.findMany({
            where: {
                OR: [
                    { transaction: { buyerId: userId } },
                    { transaction: { sellerId: userId } },
                    { needListing: { userId: userId } }, // Si soy el creador de la necesidad
                    { messages: { some: { senderId: userId } } } // Si soy el oferente que envió mensajes
                ]
            },
            include: {
                transaction: {
                    include: {
                        product: { select: { title: true, type: true } },
                        buyer: { select: { name: true, id: true } },
                        seller: { select: { name: true, id: true } }
                    }
                },
                needListing: {
                    include: {
                        user: { select: { name: true, id: true } }
                    }
                },
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                },
                _count: {
                    select: { 
                        messages: { 
                            where: { 
                                senderId: { not: userId },
                                isRead: false 
                            } 
                        } 
                    }
                }
            },
            orderBy: { updatedAt: 'desc' }
        });
        res.json(chats);
    } catch (error) {
        console.error('Error fetching chats:', error);
        res.status(500).json({ error: 'Error al cargar chats.' });
    }
};

// 2. ENTRAR A UNA SALA (GET OR CREATE - Híbrido Completo)
export const getOrCreateChatRoom = async (req: AuthRequest, res: Response) => {
    try {
        const { transactionId } = req.params; 
        const userId = req.userId;

        const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
        const isAdmin = user?.role === 'ADMIN';

        // A. PASO NUEVO: Intentamos buscar si el ID ya es directamente de una SALA DE CHAT existente
        let existingChatRoom = await prisma.chatRoom.findUnique({
            where: { id: transactionId },
            include: {
                transaction: {
                    include: {
                        product: { select: { title: true, type: true, price: true, images: true } },
                        buyer: { select: { name: true, id: true, email: true } },
                        seller: { select: { name: true, id: true, email: true } }
                    }
                },
                needListing: {
                    include: { user: { select: { name: true, id: true } } }
                }
            }
        });

        if (existingChatRoom) {
            if (existingChatRoom.transaction) {
                if (existingChatRoom.transaction.buyerId !== userId && existingChatRoom.transaction.sellerId !== userId && !isAdmin) {
                    return res.status(403).json({ error: 'No tienes permiso para ver este chat.' });
                }
            }
            return res.json(existingChatRoom);
        }

        // B. Si no es un ChatRoom, intentamos buscar si es una Transacción Clásica para crear la sala
        const transaction = await prisma.transaction.findUnique({
            where: { id: transactionId },
            include: { product: true }
        });

        if (transaction) {
            if (transaction.buyerId !== userId && transaction.sellerId !== userId && !isAdmin) {
                return res.status(403).json({ error: 'No tienes permiso para ver este chat.' });
            }
            
            const chatInclude = {
                transaction: {
                    include: {
                        product: { select: { title: true, type: true, price: true, images: true } },
                        buyer: { select: { name: true, id: true, email: true } },
                        seller: { select: { name: true, id: true, email: true } }
                    }
                }
            };

            let chatRoom = await prisma.chatRoom.findUnique({
                where: { transactionId },
                include: chatInclude 
            });

            if (!chatRoom) {
                chatRoom = await prisma.chatRoom.create({
                    data: { transactionId },
                    include: chatInclude
                });
            }
            return res.json(chatRoom);
        }

        // C. Si no es Transacción, intentamos buscar si es un Mercado Inverso (NeedListing) para crear la sala
        const needListing = await prisma.needListing.findUnique({
            where: { id: transactionId }
        });

        if (needListing) {
            let chatRoom;
            
            if (needListing.userId === userId) {
                return res.status(400).json({ error: 'Eres el creador de este anuncio. Revisa tu buzón para ver las ofertas.' });
            } else {
                chatRoom = await prisma.chatRoom.findFirst({
                    where: { 
                        needListingId: needListing.id,
                        messages: { some: { senderId: userId } } 
                    },
                    include: { needListing: { include: { user: { select: { name: true, id: true } } } } }
                });

                if (!chatRoom) {
                    chatRoom = await prisma.chatRoom.create({
                        data: { needListingId: needListing.id },
                        include: { needListing: { include: { user: { select: { name: true, id: true } } } } }
                    });
                }
            }
            return res.json(chatRoom);
        }

        res.status(404).json({ error: 'Referencia no encontrada.' });

    } catch (error) {
        console.error('Error accessing chat:', error);
        res.status(500).json({ error: 'Error al acceder al chat.' });
    }
};

// 3. ENVIAR MENSAJE
export const sendMessage = async (req: AuthRequest, res: Response) => {
    try {
        const { chatRoomId, content } = req.body;
        const senderId = req.userId;

        if (!content || !content.trim()) return res.status(400).json({ error: 'Mensaje vacío.' });

        const chatRoom = await prisma.chatRoom.findUnique({
            where: { id: chatRoomId },
            include: { 
                transaction: { include: { buyer: true, seller: true } },
                needListing: { include: { user: true } }
            }
        });

        if (!chatRoom) return res.status(404).json({ error: 'Sala de chat no encontrada.' });
        
        let receiverEmail: string | undefined;
        let senderName: string | undefined;

        if (chatRoom.transaction) {
            if (chatRoom.transaction.state === 'REFUNDED') {
                return res.status(403).json({ error: 'La transacción fue cancelada. No se pueden enviar mensajes.' });
            }

            const isBuyer = chatRoom.transaction.buyerId === senderId;
            const isSeller = chatRoom.transaction.sellerId === senderId;

            if (!isBuyer && !isSeller) return res.status(403).json({ error: 'No perteneces a este chat.' });

            receiverEmail = isBuyer ? chatRoom.transaction.seller.email : chatRoom.transaction.buyer.email;
            senderName = isBuyer ? chatRoom.transaction.buyer?.name || 'Usuario' : chatRoom.transaction.seller?.name || 'Usuario';
        } 
        else if (chatRoom.needListing) {
            const isCreator = chatRoom.needListing.userId === senderId;
            
            if (isCreator) {
                const otherMessage = await prisma.message.findFirst({
                    where: { chatRoomId, senderId: { not: senderId } },
                    include: { sender: true }
                });
                receiverEmail = otherMessage?.sender?.email;
                senderName = chatRoom.needListing.user.name || 'Usuario';
            } else {
                receiverEmail = chatRoom.needListing.user.email;
                const offerer = await prisma.user.findUnique({ where: { id: senderId } });
                senderName = offerer?.name || 'Usuario';
            }
        } else {
            return res.status(400).json({ error: 'Sala inválida.' });
        }

        const message = await prisma.message.create({
            data: {
                chatRoomId,
                senderId: senderId!,
                content,
                isRead: false
            }
        });

        await prisma.chatRoom.update({
            where: { id: chatRoomId },
            data: { updatedAt: new Date() }
        });

        if (resend && receiverEmail) {
            resend.emails.send({
                from: 'Mission Vende Chat <onboarding@resend.dev>',
                to: receiverEmail,
                subject: `💬 Nuevo mensaje de ${senderName}`,
                html: `<p><strong>${senderName}</strong> te escribió:</p><blockquote>"${content}"</blockquote><p>Entra a Mission Vende para responder.</p>`
            }).catch(console.error);
        }

        res.status(201).json(message);

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Error al enviar mensaje.' });
    }
};

// 4. OBTENER MENSAJES DE UNA SALA
export const getMessages = async (req: AuthRequest, res: Response) => {
    try {
        const { chatRoomId } = req.params;
        const userId = req.userId;

        const chatRoom = await prisma.chatRoom.findUnique({
            where: { id: chatRoomId },
            include: { transaction: true, needListing: true }
        });

        if (!chatRoom) return res.status(404).json({ error: 'Sala no encontrada.' });

        const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
        const isAdmin = user?.role === 'ADMIN';

        if (chatRoom.transaction) {
            if (chatRoom.transaction.buyerId !== userId && chatRoom.transaction.sellerId !== userId && !isAdmin) {
                return res.status(403).json({ error: 'Sin permiso.' });
            }
        }

        if (!isAdmin) {
            await prisma.message.updateMany({
                where: {
                    chatRoomId: chatRoomId,
                    senderId: { not: userId }, 
                    isRead: false
                },
                data: { isRead: true }
            });
        }

        const messages = await prisma.message.findMany({
            where: { chatRoomId },
            orderBy: { createdAt: 'asc' },
            include: { sender: { select: { name: true, id: true } } }
        });

        res.json(messages);

    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Error al cargar mensajes.' });
    }
};

// 5. NUEVA FUNCIÓN: GENERAR OFERTA DE PAGO Y CERRAR ANUNCIO
export const generatePaymentOffer = async (req: AuthRequest, res: Response) => {
    try {
        const { chatRoomId, amount, description } = req.body;
        const userId = req.userId;

        const chatRoom = await prisma.chatRoom.findUnique({
            where: { id: chatRoomId },
            include: { needListing: true, transaction: true }
        });

        if (!chatRoom || !chatRoom.needListing) {
            return res.status(404).json({ error: 'Sala no válida para generar ofertas.' });
        }

        if (chatRoom.transaction) {
            return res.status(400).json({ error: 'Ya existe una oferta de pago activa en esta sala.' });
        }

        // Validamos que sea el oferente (vendedor) el que cobra, no el creador del anuncio
        if (chatRoom.needListing.userId === userId) {
            return res.status(403).json({ error: 'El creador de la necesidad no puede auto-cobrarse.' });
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ error: 'Monto inválido.' });
        }

        const buyerId = chatRoom.needListing.userId; // El que paga (creador de necesidad)
        const sellerId = userId!; // El que cobra (oferente)

        // Buscamos o requerimos una tienda del oferente para asociar el producto fantasma
        let sellerStore = await prisma.store.findFirst({ where: { ownerId: sellerId } });
        if (!sellerStore) {
            // Creamos una tienda por defecto sin forzar el tipo estricto que causaba conflicto
            sellerStore = await prisma.store.create({
                data: {
                    name: 'Mi Tienda',
                    ownerId: sellerId
                } as any
            });
        }

        // 1. Crear un producto oculto adaptado a la arquitectura Multi-Tienda
        const phantomProduct = await prisma.product.create({
            data: {
                title: description || `Servicio a medida: ${chatRoom.needListing.title}`,
                description: `Acuerdo privado generado desde el Mercado Inverso.`,
                price: amountNum,
                storeId: sellerStore.id,
                type: 'SERVICIO',
                status: 'PAUSADO', // Pausado para que no salga en el catálogo público
                stock: 1
            }
        });

        // 2. Calcular comisiones
        const platformFee = amountNum * 0.10;
        const sellerPayout = amountNum - platformFee;

        // 3. Crear la Transacción
        const transaction = await prisma.transaction.create({
            data: {
                buyerId,
                sellerId,
                productId: phantomProduct.id,
                paymentGateway: 'MERCADO_PAGO',
                state: 'PENDING',
                amount: amountNum,
                grossAmount: amountNum,
                platformFee,
                taxFeeAmount: platformFee * 0.21,
                netPlatformFeeAmount: platformFee * 0.79,
                gatewayFeeAmount: amountNum * 0.0449,
                sellerPayout,
                sellerFinalAmount: sellerPayout,
                targetNetAmount: amountNum
            }
        });

        // 4. Transformar el Chat y Dar de Baja el Anuncio
        await prisma.$transaction([
            // Enlazamos la nueva transacción al chat existente
            prisma.chatRoom.update({
                where: { id: chatRoomId },
                data: { transactionId: transaction.id }
            }),
            // Damos de baja el anuncio automáticamente
            prisma.needListing.update({
                where: { id: chatRoom.needListing.id },
                data: { status: 'FULFILLED' }
            }),
            // Enviamos un mensaje automático del sistema avisando
            prisma.message.create({
                data: {
                    chatRoomId,
                    senderId: sellerId,
                    content: `💳 He generado un botón de pago seguro por $${amountNum}. Al pagarlo el dinero quedará protegido por Mission Vende hasta que finalice el trabajo.`,
                    isRead: false
                }
            })
        ]);

        res.status(200).json({ message: 'Oferta generada con éxito.', transaction });

    } catch (error) {
        console.error('Error al generar oferta:', error);
        res.status(500).json({ error: 'Error interno al generar la oferta.' });
    }
};