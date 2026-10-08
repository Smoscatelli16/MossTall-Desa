// src/controllers/questionController.ts
import { Response } from 'express';
import { Resend } from 'resend';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middlewares/authMiddleware';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// 1. CREAR PREGUNTA
export const createQuestion = async (req: AuthRequest, res: Response) => {
    try {
        const { productId, content } = req.body;
        const askerId = req.userId;
        
        if (!productId || !content) return res.status(400).json({ error: 'Faltan datos.' });
        
        const product = await prisma.product.findUnique({ 
            where: { id: productId }, 
            include: { store: { include: { owner: true } } } 
        });
        
        if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
        if (product.store.ownerId === askerId) return res.status(400).json({ error: 'No puedes preguntar en tu propia publicación.' });

        const question = await prisma.question.create({ 
            data: { productId, askerId: askerId!, content } 
        });

        // Notificar al Dueño de la Tienda
        if (resend && product.store.owner.email) {
            resend.emails.send({
                from: 'Mission Vende <onboarding@resend.dev>',
                to: product.store.owner.email,
                subject: `💬 Nueva pregunta en: ${product.title}`,
                html: `<p>Te preguntaron sobre <strong>${product.title}</strong>:</p><blockquote>"${content}"</blockquote>`
            }).catch(console.error);
        }
        res.status(201).json(question);
    } catch (error) { 
        res.status(500).json({ error: 'Error al enviar pregunta.' }); 
    }
};

// 2. RESPONDER PREGUNTA
export const answerQuestion = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { answer } = req.body;
        const userId = req.userId;
        
        if (!answer) return res.status(400).json({ error: 'Respuesta vacía.' });

        const question = await prisma.question.findUnique({ 
            where: { id }, 
            include: { product: { include: { store: true } }, asker: true } 
        });
        
        if (!question) return res.status(404).json({ error: 'Pregunta no encontrada.' });
        if (question.product.store.ownerId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });

        const updatedQuestion = await prisma.question.update({
            where: { id },
            data: { answer, answeredAt: new Date() }
        });

        // Notificar al Interesado
        if (resend && question.asker.email) {
            resend.emails.send({
                from: 'Mission Vende <onboarding@resend.dev>',
                to: question.asker.email,
                subject: `✅ Te respondieron sobre: ${question.product.title}`,
                html: `<p>Respuesta: <strong>${answer}</strong></p>`
            }).catch(console.error);
        }
        res.json(updatedQuestion);
    } catch (error) { 
        res.status(500).json({ error: 'Error al responder.' }); 
    }
};

// 3. ELIMINAR PREGUNTA
export const deleteQuestion = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.userId;
        
        const question = await prisma.question.findUnique({ 
            where: { id }, 
            include: { product: { include: { store: true } } } 
        });
        
        if (!question) return res.status(404).json({ error: 'No encontrada.' });

        const isAsker = question.askerId === userId;
        const isOwner = question.product.store.ownerId === userId;
        
        if (!isAsker && !isOwner) return res.status(403).json({ error: 'Sin permiso.' });

        await prisma.question.delete({ where: { id } });
        res.json({ message: 'Eliminada.' });
    } catch (error) { 
        res.status(500).json({ error: 'Error al eliminar.' }); 
    }
};

// 4. ELIMINAR RESPUESTA
export const deleteAnswer = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.userId;
        
        const question = await prisma.question.findUnique({ 
            where: { id }, 
            include: { product: { include: { store: true } } } 
        });
        
        if (!question) return res.status(404).json({ error: 'No encontrada.' });
        if (question.product.store.ownerId !== userId) return res.status(403).json({ error: 'Sin permiso.' });

        await prisma.question.update({ 
            where: { id }, 
            data: { answer: null, answeredAt: null } 
        });
        res.json({ message: 'Respuesta eliminada.' });
    } catch (error) { 
        res.status(500).json({ error: 'Error al eliminar respuesta.' }); 
    }
};

// 5. MARCAR COMO LEÍDA (POR EL PREGUNTADOR)
export const markQuestionAsRead = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.userId;
        
        const question = await prisma.question.findUnique({ where: { id } });
        if (!question) return res.status(404).json({ error: 'No encontrada' });
        if (question.askerId !== userId) return res.status(403).json({ error: 'Sin permiso' });

        await prisma.question.update({ 
            where: { id }, 
            data: { isReadByAsker: true } 
        });
        res.json({ message: 'Marcada como leída' });
    } catch (error) { 
        res.status(500).json({ error: 'Error al marcar como leído' }); 
    }
};