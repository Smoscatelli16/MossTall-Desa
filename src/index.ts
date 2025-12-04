// Importamos las herramientas
import express, { Express, Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
// Importamos Mercado Pago
import { MercadoPagoConfig, Preference } from 'mercadopago';

// --- CONFIGURACIÓN INICIAL ---
dotenv.config();
const app: Express = express();
app.use(cors());
app.use(express.json());
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const COMMISSION_RATE = 0.07; // Nuestra comisión de MossTall: 7%
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

if (!JWT_SECRET) {
  console.error("¡ERROR! La variable JWT_SECRET no está definida en el .env");
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.error("¡ERROR! La variable MP_ACCESS_TOKEN no está definida en el .env");
  process.exit(1);
}

// --- CONFIGURACIÓN CLIENTE MERCADO PAGO ---
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// --- (FIN DE LA CONFIGURACIÓN) ---


// --- INTERFAZ DE REQUEST AUTENTICADO ---
export interface AuthRequest extends Request {
  userId?: string;
}


// --- MIDDLEWARE DE AUTENTICACIÓN (EL "GUARDIA") ---
const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
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


// --- RUTAS DE AUTENTICACIÓN (Públicas) ---

app.get('/', (req: Request, res: Response) => {
  res.send('El servidor de MossTall está funcionando!');
});

app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Faltan datos obligatorios.' });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const newUser = await prisma.user.create({
      data: {
        email: email,
        name: name,
        password: hashedPassword,
      },
    });
    res.status(201).json({
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'El email ya está en uso' });
    }
    console.error('Error en el registro:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
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
});


// --- RUTAS DE CATEGORÍAS ---

app.get('/api/categories', async (req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      where: { parentId: null },
      include: { children: true },
      orderBy: { name: 'asc' }
    });
    res.status(200).json(categories);
  } catch (error) {
    console.error('Error al obtener categorías:', error);
    res.status(500).json({ error: 'Error interno al obtener categorías.' });
  }
});


// --- RUTAS DE PRODUCTOS ---

app.get('/api/products', async (req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { name: true } },
        category: { select: { name: true } }
      },
    });
    res.status(200).json(products);
  } catch (error) {
    console.error('Error al obtener los productos:', error);
    res.status(500).json({ error: 'Error interno al obtener los productos.' });
  }
});

app.get('/api/products/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({
      where: { id: id },
      include: {
        creator: { select: { name: true } },
        category: { select: { name: true } }
      },
    });

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }
    res.status(200).json(product);
  } catch (error) {
    console.error('Error al obtener el producto:', error);
    res.status(500).json({ error: 'Error interno al obtener el producto.' });
  }
});

// POST PRODUCTO: Lógica de Precios Avanzada
app.post('/api/products', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, price, images, categoryId, type } = req.body;
    const creatorId = req.userId;

    // 1. Validaciones Comunes (Todo menos precio)
    if (!title || !description || !categoryId || !type) {
      return res.status(400).json({ error: 'Faltan campos obligatorios (Título, Descripción, Categoría o Tipo).' });
    }
    if (!creatorId) {
      return res.status(401).json({ error: 'No se pudo identificar al usuario.' });
    }

    // 2. Lógica de Precio por TIPO
    let finalPrice = 0;
    
    // Convertimos a número si viene texto, o dejamos 0 si está vacío
    if (price) {
        finalPrice = parseFloat(price);
    }

    // REGLA A: Productos Físicos -> Precio Obligatorio
    if (type === 'PRODUCTO') {
        if (!finalPrice || finalPrice <= 0) {
            return res.status(400).json({ error: 'Para vender un Producto Físico, debes colocar un precio válido.' });
        }
    }

    // REGLA B: Servicios e Infoproductos -> Precio Opcional (0 significa "A Convenir" o "Gratis")
    // (No necesitamos if, ya que finalPrice es 0 por defecto)

    // 3. Crear Producto
    const newProduct = await prisma.product.create({
      data: {
        title: title,
        description: description,
        price: finalPrice,      // Guardamos el precio procesado
        images: images || [],
        creatorId: creatorId,
        categoryId: categoryId,
        type: type
      },
    });

    res.status(201).json(newProduct);

  } catch (error) {
    console.error('Error al crear producto:', error);
    res.status(500).json({ error: 'Error interno al crear el producto.' });
  }
});


// --- RUTAS DE TRANSACCIONES ---

app.post('/api/transactions', authMiddleware, async (req: AuthRequest, res: Response) => {
  console.log('--- INICIO DE DEBUG TRANSACCIÓN ---');
  
  const { productId } = req.body;
  const buyerId = req.userId;

  try {
    console.log(`1. Datos recibidos - Comprador: ${buyerId}, Producto: ${productId}`);

    if (!buyerId || !productId) return res.status(400).json({ error: 'Faltan datos.' });

    const product = await prisma.product.findUnique({ where: { id: productId } });

    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.creatorId === buyerId) return res.status(400).json({ error: 'No puedes comprar tu propio producto.' });
    if (product.status !== 'DISPONIBLE') return res.status(400).json({ error: 'Este producto ya no está disponible.' });

    const amount = Number(product.price);
    
    // VALIDACIÓN EXTRA: No se puede transaccionar algo de precio 0 por Mercado Pago
    // Esto es vital: si es un servicio "A convenir" (precio 0), no podemos cobrar $0 en MP.
    if (amount <= 0) {
        return res.status(400).json({ error: 'Este ítem es "A Convenir" o "Gratis", no requiere pago por pasarela.' });
    }

    const platformFee = amount * COMMISSION_RATE;
    const sellerPayout = amount - platformFee;
    const sellerId = product.creatorId;

    console.log('2. Creando transacción en BD...');
    const newTransaction = await prisma.$transaction(async (tx) => {
      const createdTx = await tx.transaction.create({
        data: {
          buyerId, sellerId, productId, amount, platformFee, sellerPayout,
          status: 'INICIADO',
        }
      });
      await tx.product.update({
        where: { id: productId },
        data: { status: 'PENDIENTE' }
      });
      return createdTx;
    });
    console.log(`   Transacción creada ID: ${newTransaction.id}`);

    // PREPARACIÓN DE DATOS PARA MERCADO PAGO
    const preferenceData = {
      body: {
        items: [
          {
            id: productId,
            title: product.title,
            quantity: 1,
            unit_price: amount,
            currency_id: 'ARS',
          }
        ],
        back_urls: {
          success: 'http://localhost:3000/payment/success',
          failure: 'http://localhost:3000/payment/failure',
          pending: 'http://localhost:3000/payment/pending'
        },
        external_reference: newTransaction.id,
      }
    };

    console.log('3. PAYLOAD A ENVIAR A MERCADO PAGO:');
    console.log(JSON.stringify(preferenceData, null, 2));

    const preference = new Preference(client);
    const mpResult = await preference.create(preferenceData);

    console.log('4. ¡Respuesta de Mercado Pago exitosa!');
    console.log(`   Link generado: ${mpResult.init_point}`);

    res.status(201).json({
      transaction: newTransaction,
      paymentUrl: mpResult.init_point
    });

  } catch (error: any) {
    console.error('--- ERROR CRÍTICO ---');
    console.error('Mensaje:', error.message);
    
    if (error.cause) {
        console.error('Causa detallada MP:', JSON.stringify(error.cause, null, 2));
    }
    
    // Devolvemos el producto a DISPONIBLE si falla MP
    if (productId) {
        try {
            await prisma.product.update({
                where: { id: productId },
                data: { status: 'DISPONIBLE' }
            });
            console.log('   >> Producto liberado automáticamente tras error.');
        } catch(e) { console.error('Error al liberar producto', e); }
    }
    
    res.status(500).json({ 
      error: 'No se pudo generar el link de pago.', 
      details: error.message 
    });
  } finally {
      console.log('--- FIN DE DEBUG ---');
  }
});


// --- INICIAR EL SERVIDOR ---
const startServer = async () => {
  try {
    await prisma.$connect();
    console.log('[prisma]: Conectado a la base de datos PostgreSQL.');
    app.listen(PORT, () => {
      console.log(`[servidor]: Servidor corriendo en http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('[prisma]: No se pudo conectar a la base de datos.');
    console.error(error);
    process.exit(1);
  }
};

startServer();