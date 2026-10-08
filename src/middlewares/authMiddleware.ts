// src/middlewares/authMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma'; // Requerido para verificar el rol en DB

// Accedemos a la variable de entorno
const JWT_SECRET = process.env.JWT_SECRET;

// Exportamos la interfaz para que otros archivos (controladores) la puedan usar
export interface AuthRequest extends Request {
  userId?: string;
}

export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // Verificación de seguridad básica
    if (!JWT_SECRET) {
        console.error("FATAL: JWT_SECRET no definido en variables de entorno.");
        return res.status(500).json({ error: 'Error de configuración del servidor.' });
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Acceso no autorizado. Se requiere un token.' });
    }

    jwt.verify(token, JWT_SECRET, (err: any, decodedToken: any) => {
      if (err) {
        return res.status(403).json({ error: 'Token inválido o expirado.' });
      }
      req.userId = decodedToken.userId;
      next();
    });
  } catch (error) {
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
};

// Middleware exclusivo para Administradores (RBAC - Brief #019)
export const adminMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Acceso denegado. Usuario no identificado.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true }
    });

    if (!user || user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Acceso denegado (HTTP 403 Forbidden). Privilegios de administrador requeridos.' });
    }

    next();
  } catch (error) {
    console.error('Error validando rol de administrador:', error);
    res.status(500).json({ error: 'Error interno validando credenciales.' });
  }
};