// src/routes/chatRoutes.ts
import { Router } from 'express';
import { 
  getInbox, 
  getOrCreateChatRoom, 
  getMessages, 
  sendMessage,
  generatePaymentOffer // <-- NUEVA FUNCIÓN IMPORTADA
} from '../controllers/chatController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// IMPORTANTE: Todas estas rutas ya heredan el prefijo '/api/chat' de src/index.ts

// 1. Obtener todos los chats (Bandeja de entrada) -> GET /api/chat/inbox
router.get('/inbox', authMiddleware, getInbox);

// 2. Entrar a una sala / crearla (Usa GET, no POST para "leer") -> GET /api/chat/:transactionId
router.get('/:transactionId', authMiddleware, getOrCreateChatRoom);

// 3. Obtener los mensajes de una sala -> GET /api/chat/room/:chatRoomId/messages
router.get('/room/:chatRoomId/messages', authMiddleware, getMessages);

// 4. Enviar un mensaje -> POST /api/chat/message
router.post('/message', authMiddleware, sendMessage);

// 5. NUEVO: Generar oferta de pago en el Mercado Inverso -> POST /api/chat/offer
router.post('/offer', authMiddleware, generatePaymentOffer);

export default router;