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

    // Eliminamos códigos anteriores no verificados para evitar colisiones con registros expirados
    await prisma.otpVerification.deleteMany({
      where: { phone, verified: false },
    });

    // Genera código seguro de 6 dígitos
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // Válido por 10 minutos

    await prisma.otpVerification.create({
      data: {
        phone,
        code,
        expiresAt,
      }
    });

    // TASK 52.1: Modo Simulación (OTP Bypass)
    const isDevMode = process.env.DEV_MODE_SHOW_OTP === 'true';
    if (isDevMode) {
      console.log(`[DEV MODE] OTP para ${phone}: ${code}`);
      return res.status(200).json({ 
        message: 'Código generado (Modo Simulación).',
        devOtp: code 
      });
    }

    // Delegamos la entrega por WhatsApp si no está en modo desarrollo
    await sendOtpMessage(phone, code);

    // Seguridad por diseño: No devolver el código en el payload en producción real
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

    // Buscar el OTP más reciente para este número
    const otpRecord = await prisma.otpVerification.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      return res.status(404).json({ error: 'No hay códigos pendientes para este número.' });
    }

    const now = new Date();

    // Si ya fue verificado recientemente (ej: reintento tras un error en /register), permitir continuar si sigue vigente
    if (otpRecord.verified) {
      if (otpRecord.code === code && now <= otpRecord.expiresAt) {
        return res.status(200).json({ message: 'Identidad verificada correctamente.' });
      }
      return res.status(400).json({ error: 'Este código ya fue utilizado. Por favor, solicita uno nuevo.' });
    }

    if (now > otpRecord.expiresAt) {
      console.warn(`[OTP] Expirado para ${phone}. now=${now.toISOString()} expiresAt=${otpRecord.expiresAt.toISOString()}`);
      return res.status(400).json({ error: 'El código ha expirado. Por favor, solicita uno nuevo.' });
    }

    if (otpRecord.attempts >= 3) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Por favor, solicita un nuevo código.' });
    }

    if (otpRecord.code !== code) {
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