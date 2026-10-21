// src/controllers/bannerController.ts
import { Request, Response } from 'express';
import prisma from '../lib/prisma';

export const createBanner = async (req: Request, res: Response) => {
  try {
    const { title, targetUrl } = req.body;
    
    // Bypass de TypeScript: Le indicamos que req tendrá la propiedad files inyectada por Multer
    const files = (req as any).files;

    if (!files?.desktopImage || !files?.mobileImage) {
      return res.status(400).json({ error: 'Se requieren ambas imágenes (desktop y mobile).' });
    }

    // Aquí iría la integración con Cloudinary (o el storage que uses)
    // Asumimos que el middleware ya adjuntó las URLs en la propiedad cloudinaryUrl o path
    const desktopImageUrl = files.desktopImage[0].cloudinaryUrl || files.desktopImage[0].path || 'url_mock_desktop';
    const mobileImageUrl = files.mobileImage[0].cloudinaryUrl || files.mobileImage[0].path || 'url_mock_mobile';

    const newBanner = await prisma.banner.create({
      data: {
        title: title || null,
        desktopImageUrl,
        mobileImageUrl,
        targetUrl: targetUrl || null,
        isActive: true,
      },
    });

    res.status(201).json({ message: 'Banner creado exitosamente', banner: newBanner });
  } catch (error) {
    console.error('Error al crear banner:', error);
    res.status(500).json({ error: 'Ocurrió un error al procesar el banner.' });
  }
};

export const getActiveBanners = async (_req: Request, res: Response) => {
  try {
    const activeBanners = await prisma.banner.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' }
    });
    
    res.status(200).json(activeBanners);
  } catch (error) {
    console.error('Error obteniendo banners:', error);
    res.status(500).json({ error: 'No se pudieron recuperar los banners.' });
  }
};