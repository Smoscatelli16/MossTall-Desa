import { Router } from 'express';
import { 
  createQuestion, 
  answerQuestion, 
  deleteQuestion, 
  deleteAnswer, 
  markQuestionAsRead 
} from '../controllers/questionController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// Rutas base: /api/questions
router.post('/', authMiddleware, createQuestion);
router.patch('/:id/answer', authMiddleware, answerQuestion);
router.delete('/:id', authMiddleware, deleteQuestion);
router.delete('/:id/answer', authMiddleware, deleteAnswer);
router.patch('/:id/read', authMiddleware, markQuestionAsRead);

export default router;