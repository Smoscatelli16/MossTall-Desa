// src/controllers/otpController.ts
import { Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { sendOtpMessage } from '../services/whatsappService';

export const sendOtp = async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'El número de teléfono es obligatorio.' });
    }

    // Verificamos si el teléfono ya está registrado y activo (Task 49.2 / 50.2)
    const existingUser = await prisma.user.findUnique({ where: { phone } });
    if (existingUser) {
      return res.status(409).json({ error: 'Este número de teléfono ya está asociado a otra cuenta.' });
    }

    // Invalida códigos anteriores no verificados para este número
    await prisma.otpVerification.updateMany({
      where: { phone, verified: false },
      data: { expiresAt: new Date() }, // Los marcamos como expirados
    });

    // Genera código seguro de 6 dígitos
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // Válido por 5 minutos

    await prisma.otpVerification.create({
      data: {
        phone,
        code,
        expiresAt,
      }
    });

    // Delegamos la entrega por WhatsApp
    await sendOtpMessage(phone, code);

    // Seguridad por diseño: No devolver el código en el payload
    res.status(200).json({ message: 'Código enviado por WhatsApp exitosamente.' });
  } catch (error) {
    console.error('Error al generar OTP:', error);
    res.status(500).json({ error: 'No se pudo enviar el código de verificación.' });
  }
};

export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: 'Teléfono y código son obligatorios.' });
    }

    // Buscar el OTP activo más reciente para este número
    const otpRecord = await prisma.otpVerification.findFirst({
      where: { phone, verified: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      return res.status(404).json({ error: 'No hay códigos pendientes para este número.' });
    }

    if (new Date() > otpRecord.expiresAt) {
      return res.status(400).json({ error: 'El código ha expirado. Por favor, solicita uno nuevo.' });
    }

    if (otpRecord.attempts >= 3) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Por favor, solicita un nuevo código.' });
    }

    if (otpRecord.code !== code) {
      // Incrementar intentos si falla
      await prisma.otpVerification.update({
        where: { id: otpRecord.id },
        data: { attempts: otpRecord.attempts + 1 },
      });
      return res.status(400).json({ error: 'Código incorrecto.' });
    }

    // Código válido, marcamos como verificado
    await prisma.otpVerification.update({
      where: { id: otpRecord.id },
      data: { verified: true },
    });

    res.status(200).json({ message: 'Identidad verificada correctamente.' });
  } catch (error) {
    console.error('Error verificando OTP:', error);
    res.status(500).json({ error: 'Ocurrió un error al verificar el código.' });
  }
};