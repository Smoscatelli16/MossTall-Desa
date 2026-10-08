// src/routes/transactionRoutes.ts
import { Router } from 'express';
import { 
  createTransaction, 
  createDynamicCheckout, 
  releaseFunds, 
  cancelTransaction, 
  deleteTransaction, 
  handlePaymentWebhook,
  disputeTransaction,
  resolveDispute,
  getDisputes,
  confirmDelivery,
  getTransactionById,
  simulatePayment // <-- 1. IMPORTADO AQUÍ
} from '../controllers/transactionController';
import { authMiddleware, adminMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// --- RUTAS DE ADMINISTRACIÓN ---
router.get('/disputes', authMiddleware, adminMiddleware, getDisputes);

// --- RUTAS PROTEGIDAS (Requieren Login) ---
router.post('/', authMiddleware, createTransaction);
router.post('/:id/checkout-dynamic', authMiddleware, createDynamicCheckout); 

// Acción manual exclusiva del comprador (Brief #022)
router.patch('/:id/confirm-delivery', authMiddleware, confirmDelivery);

router.patch('/:id/release', authMiddleware, releaseFunds);
router.patch('/:id/dispute', authMiddleware, disputeTransaction); 
router.patch('/:id/resolve-dispute', authMiddleware, adminMiddleware, resolveDispute); 
router.patch('/:id/cancel', authMiddleware, cancelTransaction); 

// Atajo de Testing
router.patch('/:id/simulate-payment', authMiddleware, simulatePayment); // <-- 2. UBICADO AQUÍ

router.delete('/:id', authMiddleware, deleteTransaction); 

// Endpoint para traer detalles de la Tx y Polling (Brief #031)
router.get('/:id', authMiddleware, getTransactionById); 

// --- RUTAS PÚBLICAS (Webhooks) ---
router.post('/webhook', handlePaymentWebhook); 

export default router; // <-- 3. SIEMPRE AL FINAL