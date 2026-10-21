// src/routes/bannerRoutes.ts
import { Router } from 'express';
import multer from 'multer';
import { createBanner, getActiveBanners } from '../controllers/bannerController';

const router = Router();

// Configuración segura de Multer usando memoria (ideal para Railway / Vercel antes de Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // Límite máximo de 5MB por imagen
  },
});

// GET /api/banners -> Devuelve los banners activos al carrusel público
router.get('/', getActiveBanners);

// POST /api/banners -> Recibe las imágenes multipart/form-data y crea el registro
router.post(
  '/',
  upload.fields([
    { name: 'desktopImage', maxCount: 1 },
    { name: 'mobileImage', maxCount: 1 }
  ]),
  createBanner
);

export default router;