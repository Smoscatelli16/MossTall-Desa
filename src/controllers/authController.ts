// src/controllers/authController.ts
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma'; // Importamos la instancia compartida

const JWT_SECRET = process.env.JWT_SECRET || 'secret-fallback'; // Fallback por seguridad

// --- LOGICA DE REGISTRO ---
export const register = async (req: Request, res: Response) => {
  try {
    // BRIEF #046: Recibimos los nuevos campos del empalme KYC y legal
    const { email, name, password, dni, phone, otp, termsAccepted } = req.body;
    
    if (!email || !name || !password || !dni || !phone) {
      return res.status(400).json({ error: 'Faltan datos obligatorios.' });
    }

    // BRIEF #046: Validación estricta de términos en backend
    if (!termsAccepted) {
      return res.status(400).json({ error: 'Debes aceptar los Términos de Fideicomiso para operar.' });
    }

    // Validación básica OTP
    if (otp && otp.length !== 6) {
      return res.status(400).json({ error: 'Código OTP inválido.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await prisma.user.create({
      data: {
        email: email,
        name: name,
        password: hashedPassword,
        dni: dni,
        phone: phone,
        termsAccepted: termsAccepted,
        termsAcceptedAt: new Date(), // Registramos el momento exacto de la aceptación
      },
    });

    res.status(201).json({
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
    });

  } catch (error: any) {
    if (error.code === 'P2002') {
      // Prisma: Manejo de errores para campos únicos duplicados
      if (error.meta?.target?.includes('email')) {
         return res.status(409).json({ error: 'El email ya está en uso' });
      }
      if (error.meta?.target?.includes('dni')) {
         return res.status(409).json({ error: 'El DNI ya se encuentra registrado' });
      }
      if (error.meta?.target?.includes('phone')) {
         return res.status(409).json({ error: 'El teléfono ya se encuentra registrado' });
      }
      return res.status(409).json({ error: 'Un dato único ya está en uso' });
    }
    console.error('Error en el registro:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// --- LOGICA DE LOGIN ---
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son obligatorios.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email },
    });

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // TASK 6.1: Intercepción para cuentas de Google OAuth
    if (!user.password) {
      return res.status(401).json({ error: 'Esta cuenta está vinculada a Google. Por favor, iniciá sesión con Google.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.status(200).json({ token: token });

  } catch (error: any) {
    console.error('Error en el login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};