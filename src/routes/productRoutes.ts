// src/routes/productRoutes.ts
import { Router } from 'express';
import { 
  getCategories, 
  getPublicProducts, 
  getProductDetail, 
  getUserInventory, 
  createProduct, 
  deleteProduct, 
  updateProduct,
  askQuestion,
  answerQuestion
} from '../controllers/productController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// --- RUTAS PÚBLICAS ---
router.get('/categories', getCategories);       // GET /api/categories
router.get('/products', getPublicProducts);     // GET /api/products
router.get('/products/:id', getProductDetail);  // GET /api/products/:123

// --- RUTAS PROTEGIDAS (Requieren Login) ---
router.get('/user/products', authMiddleware, getUserInventory); // GET /api/user/products
router.post('/products', authMiddleware, createProduct);        // POST /api/products
router.delete('/products/:id', authMiddleware, deleteProduct);  // DELETE /api/products/:123
router.patch('/products/:id', authMiddleware, updateProduct);   // PATCH /api/products/:123

// --- RUTAS DE PREGUNTAS (Q&A) - BRIEF #029 ---
router.post('/products/:id/questions', authMiddleware, askQuestion);  // POST /api/products/:id/questions
router.patch('/questions/:id/answer', authMiddleware, answerQuestion); // PATCH /api/questions/:id/answer

export default router;