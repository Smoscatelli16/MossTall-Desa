// Importamos las herramientas
import express, { Express, Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client'; // Importamos tipos de Prisma
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend'; // Importamos Resend para Emails
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
const RESEND_API_KEY = process.env.RESEND_API_KEY; // API Key de Resend

if (!JWT_SECRET) {
  console.error("¡ERROR! La variable JWT_SECRET no está definida en el .env");
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.error("¡ERROR! La variable MP_ACCESS_TOKEN no está definida en el .env");
  process.exit(1);
}

// --- CONFIGURACIÓN CLIENTES EXTERNOS ---
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
// Inicializamos Resend (Email) solo si existe la key, sino avisamos
let resend: Resend | null = null;
if (RESEND_API_KEY) {
    resend = new Resend(RESEND_API_KEY);
} else {
    console.warn("⚠️ ADVERTENCIA: RESEND_API_KEY no definida. Los emails no se enviarán.");
}

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
  res.send('El servidor de MossTall está funcionando con Gestión de Stock e Inventario!');
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


// --- RUTAS DE DASHBOARD (COMPRAS Y VENTAS) ---

app.get('/api/dashboard', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Usuario no identificado.' });

    // 1. Buscar Compras (Donde soy comprador Y no lo borré)
    const purchases = await prisma.transaction.findMany({
      where: { 
        buyerId: userId,
        deletedByBuyer: false
      },
      include: {
        product: {
          select: { title: true, price: true, images: true, id: true, type: true }
        },
        seller: {
          select: { name: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // 2. Buscar Ventas (Donde soy vendedor Y no lo borré)
    const sales = await prisma.transaction.findMany({
      where: { 
        sellerId: userId,
        deletedBySeller: false
      },
      include: {
        product: {
          select: { title: true, price: true, images: true, id: true, type: true }
        },
        buyer: {
          select: { name: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ purchases, sales });

  } catch (error) {
    console.error('Error en dashboard:', error);
    res.status(500).json({ error: 'Error al cargar el panel.' });
  }
});


// --- NUEVAS RUTAS DE GESTIÓN DE INVENTARIO ("MIS PUBLICACIONES") ---

// 1. Obtener mis productos (Inventario)
app.get('/api/user/products', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    // Traemos todos los productos creados por el usuario, ordenados por fecha
    const products = await prisma.product.findMany({
      where: { creatorId: userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(products);
  } catch (error) {
    console.error('Error cargando inventario:', error);
    res.status(500).json({ error: 'Error al cargar tus productos.' });
  }
});

// 2. Eliminar producto (Solo si no tiene ventas activas)
app.delete('/api/products/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    // Verificar propiedad
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.creatorId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });

    // Verificar si tiene ventas activas (Pendientes o Pagadas)
    // No podemos borrar algo que alguien está comprando ahora mismo
    const activeTransactions = await prisma.transaction.count({
      where: { 
        productId: id,
        status: { in: ['INICIADO', 'PAGADO_EN_RETENCION'] }
      }
    });

    if (activeTransactions > 0) {
      return res.status(400).json({ error: 'No puedes eliminar un producto con ventas en curso. Cancélalas primero.' });
    }

    await prisma.product.delete({ where: { id } });
    res.json({ message: 'Producto eliminado.' });

  } catch (error) {
    console.error('Error eliminando producto:', error);
    res.status(500).json({ error: 'Error al eliminar producto.' });
  }
});

// 3. Actualizar producto (Pausar, Activar, Cambiar Stock)
app.patch('/api/products/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { status, stock } = req.body; // Solo permitimos editar esto por ahora

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.creatorId !== userId) return res.status(403).json({ error: 'No tienes permiso.' });

    const updateData: any = {};
    if (status) updateData.status = status;
    if (stock !== undefined) updateData.stock = Number(stock);

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: updateData
    });

    res.json(updatedProduct);
  } catch (error) {
    console.error('Error actualizando producto:', error);
    res.status(500).json({ error: 'Error al actualizar producto.' });
  }
});


// --- RUTAS DE PRODUCTOS PÚBLICOS (MOTOR DE BÚSQUEDA) ---

app.get('/api/products', async (req: Request, res: Response) => {
  try {
    console.log('--- 🔍 MOTOR DE BÚSQUEDA V3 ACTIVADO ---');
    console.log('Filtros recibidos:', req.query);

    const { 
      search, categoryId, minPrice, maxPrice, sort, 
      condition, brand, minYear, maxYear, maxKm 
    } = req.query;

    // Filtro Base: Solo DISPONIBLES y con STOCK > 0
    const whereClause: Prisma.ProductWhereInput = {
        status: 'DISPONIBLE',
        stock: { gt: 0 } 
    };

    // A. BÚSQUEDA TOKENIZADA
    if (search) {
      const terms = String(search).trim().split(/\s+/);
      if (terms.length > 0) {
        whereClause.AND = terms.map(term => ({
          OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } },
            { brand: { contains: term, mode: 'insensitive' } },
            { model: { contains: term, mode: 'insensitive' } }
          ]
        }));
      }
    }

    // B. FILTROS ESTRICTOS
    if (categoryId && categoryId !== '') {
      whereClause.categoryId = String(categoryId);
    }

    if (minPrice || maxPrice) {
      whereClause.price = {};
      if (minPrice) whereClause.price.gte = Number(minPrice);
      if (maxPrice) whereClause.price.lte = Number(maxPrice);
    }

    if (condition) whereClause.condition = condition as any; 
    if (brand) whereClause.brand = { contains: String(brand), mode: 'insensitive' };
    
    if (minYear || maxYear) {
      whereClause.year = {};
      if (minYear) whereClause.year.gte = Number(minYear);
      if (maxYear) whereClause.year.lte = Number(maxYear);
    }
    
    if (maxKm) whereClause.mileage = { lte: Number(maxKm) };

    // C. ORDENAMIENTO
    let orderBy: Prisma.ProductOrderByWithRelationInput = { createdAt: 'desc' };
    if (sort === 'price_asc') orderBy = { price: 'asc' };
    if (sort === 'price_desc') orderBy = { price: 'desc' };
    if (sort === 'oldest') orderBy = { createdAt: 'asc' };

    // D. EJECUCIÓN
    const products = await prisma.product.findMany({
      where: whereClause,
      orderBy: orderBy,
      include: {
        creator: { select: { name: true } },
        category: { select: { name: true } }
      },
    });

    console.log(`✅ Resultados encontrados: ${products.length}`);
    res.status(200).json(products);

  } catch (error) {
    console.error('❌ Error crítico en búsqueda:', error);
    res.status(500).json({ error: 'Error interno al obtener los productos.' });
  }
});

// GET DETALLE DE PRODUCTO (MODIFICADO PARA INCLUIR PREGUNTAS)
app.get('/api/products/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({
      where: { id: id },
      include: {
        creator: { select: { name: true, email: true } }, // Traemos email para lógica interna, cuidado con exponer
        category: { select: { name: true } },
        // --- INCLUSIÓN DE PREGUNTAS ---
        questions: {
            orderBy: { createdAt: 'desc' }, // Las más nuevas arriba
            include: {
                asker: { select: { name: true } } // Ver nombre de quien preguntó
            }
        }
      },
    });

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }
    
    // IMPORTANTE: Sanitizar datos. No queremos enviar el email del creador al frontend público.
    const { creator, ...rest } = product;
    const safeProduct = {
        ...rest,
        creator: { name: creator.name } // Solo enviamos el nombre
    };

    res.status(200).json(safeProduct);
  } catch (error) {
    console.error('Error al obtener el producto:', error);
    res.status(500).json({ error: 'Error interno al obtener el producto.' });
  }
});

// POST PRODUCTO: CREAR CON STOCK
app.post('/api/products', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { 
      title, description, price, images, categoryId, type, 
      condition, brand, model, year, mileage, stock // <-- Recibimos stock
    } = req.body;
    
    const creatorId = req.userId;

    if (!title || !description || !categoryId || !type) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }
    if (!creatorId) {
      return res.status(401).json({ error: 'No se pudo identificar al usuario.' });
    }

    let finalPrice = 0;
    if (price) finalPrice = parseFloat(price);

    if (type === 'PRODUCTO') {
        if (!finalPrice || finalPrice <= 0) {
            return res.status(400).json({ error: 'Para vender un Producto Físico, debes colocar un precio válido.' });
        }
    }

    const parsedYear = year ? parseInt(year) : null;
    const parsedMileage = mileage ? parseInt(mileage) : null;

    const newProduct = await prisma.product.create({
      data: {
        title, description, price: finalPrice, images: images || [],
        creatorId: creatorId, categoryId, type,
        condition: condition || null,
        brand: brand || null,
        model: model || null,
        year: parsedYear,
        mileage: parsedMileage,
        stock: stock ? parseInt(stock) : 1 // <-- Guardamos el stock inicial
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
    const product = await prisma.product.findUnique({ where: { id: productId } });

    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    if (product.creatorId === buyerId) return res.status(400).json({ error: 'No puedes comprar tu propio producto.' });
    
    // VALIDACIÓN DE STOCK
    if (product.stock <= 0) return res.status(400).json({ error: 'Lo sentimos, este producto se ha agotado.' });
    if (product.status !== 'DISPONIBLE') return res.status(400).json({ error: 'Este producto no está disponible.' });

    const amount = Number(product.price);
    
    if (amount <= 0) {
        return res.status(400).json({ error: 'Este ítem es "A Convenir" o "Gratis", no requiere pago por pasarela.' });
    }

    const platformFee = amount * COMMISSION_RATE;
    const sellerPayout = amount - platformFee;

    // TRANSACCIÓN ATÓMICA CON RESTA DE STOCK
    const newTransaction = await prisma.$transaction(async (tx) => {
      // 1. Crear Transacción
      const t = await tx.transaction.create({
        data: {
          buyerId: buyerId!, sellerId: product.creatorId, productId, 
          amount, platformFee, sellerPayout, status: 'INICIADO',
        }
      });

      // 2. Restar Stock
      const newStock = product.stock - 1;
      
      // 3. Si stock llega a 0, pausamos automáticamente
      const newStatus = newStock > 0 ? 'DISPONIBLE' : 'PAUSADO';

      await tx.product.update({
        where: { id: productId },
        data: { 
            stock: newStock,
            status: newStatus 
        }
      });

      return t;
    });

    // Preferencia MP
    const preference = new Preference(client);
    const mpResult = await preference.create({
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
    });

    res.status(201).json({
      transaction: newTransaction,
      paymentUrl: mpResult.init_point
    });

  } catch (error: any) {
    console.error('Error Transacción:', error);
    // Rollback manual si falla MP
    if (productId) {
       await prisma.product.update({ 
           where: { id: productId }, 
           data: { stock: { increment: 1 }, status: 'DISPONIBLE' } 
       }).catch(console.error);
    }
    res.status(500).json({ error: 'Error al generar pago.', details: error.message });
  }
});

// CANCELACIÓN DE ORDEN (DEVOLUCIÓN DE STOCK)
app.patch('/api/transactions/:id/cancel', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.userId;

  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id },
      include: { product: true }
    });

    if (!transaction) return res.status(404).json({ error: 'Transacción no encontrada.' });

    if (transaction.buyerId !== userId && transaction.sellerId !== userId) {
      return res.status(403).json({ error: 'No tienes permiso para cancelar esta orden.' });
    }

    if (transaction.status === 'COMPLETADO' || transaction.status === 'CANCELADO') {
        return res.status(400).json({ error: 'Estado inválido para cancelar.' });
    }

    const updatedTransaction = await prisma.$transaction(async (tx) => {
        const t = await tx.transaction.update({
            where: { id },
            data: { status: 'CANCELADO' }
        });

        // DEVOLVER STOCK Y REACTIVAR
        if (transaction.productId) {
            await tx.product.update({
                where: { id: transaction.productId },
                data: { 
                    stock: { increment: 1 }, // Devolvemos la unidad
                    status: 'DISPONIBLE'     // Aseguramos que se vea de nuevo en la vidriera
                }
            });
        }
        return t;
    });

    res.json(updatedTransaction);

  } catch (error) {
    console.error('Error al cancelar:', error);
    res.status(500).json({ error: 'Error interno al cancelar.' });
  }
});

// BORRADO LÓGICO DE TRANSACCIONES
app.delete('/api/transactions/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.userId;

  try {
    const transaction = await prisma.transaction.findUnique({ where: { id } });
    if (!transaction) return res.status(404).json({ error: 'No encontrada.' });

    if (transaction.buyerId === userId) {
      await prisma.transaction.update({ where: { id }, data: { deletedByBuyer: true } });
    } else if (transaction.sellerId === userId) {
      await prisma.transaction.update({ where: { id }, data: { deletedBySeller: true } });
    } else {
      return res.status(403).json({ error: 'Sin permiso.' });
    }

    res.json({ message: 'Eliminada del panel.' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar.' });
  }
});


// --- RUTAS DE PREGUNTAS Y RESPUESTAS (Q&A) ---

// 1. CREAR PREGUNTA (Por el interesado)
app.post('/api/questions', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { productId, content } = req.body;
        const askerId = req.userId;

        if (!productId || !content) return res.status(400).json({ error: 'Faltan datos.' });

        const product = await prisma.product.findUnique({ 
            where: { id: productId },
            include: { creator: true } // Traemos al dueño para enviarle el email
        });

        if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
        if (product.creatorId === askerId) return res.status(400).json({ error: 'No puedes preguntar en tu propia publicación.' });

        // Crear la pregunta
        const question = await prisma.question.create({
            data: { productId, askerId: askerId!, content }
        });

        // EMAIL: Notificar al Vendedor
        if (resend && product.creator.email) {
            try {
                await resend.emails.send({
                    from: 'MossTall Notificaciones <onboarding@resend.dev>', // Email de prueba de Resend
                    to: product.creator.email, // CUIDADO: En modo Test solo envía al email registrado en Resend
                    subject: `💬 Nueva pregunta en: ${product.title}`,
                    html: `<p>Hola ${product.creator.name},</p><p>Te hicieron una pregunta sobre <strong>${product.title}</strong>:</p><blockquote>"${content}"</blockquote><p>Entra a MossTall para responder.</p>`
                });
                console.log('📧 Email de pregunta enviado');
            } catch (emailError) {
                console.error('⚠️ Error enviando email (Resend):', emailError);
            }
        }

        res.status(201).json(question);

    } catch (error) {
        console.error('Error creando pregunta:', error);
        res.status(500).json({ error: 'Error al enviar pregunta.' });
    }
});

// 2. RESPONDER PREGUNTA (Por el dueño)
app.patch('/api/questions/:id/answer', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params; // ID de la pregunta
        const { answer } = req.body;
        const userId = req.userId;

        if (!answer) return res.status(400).json({ error: 'La respuesta no puede estar vacía.' });

        // Buscamos la pregunta y el producto asociado
        const question = await prisma.question.findUnique({
            where: { id },
            include: { 
                product: true,
                asker: true // Traemos a quien preguntó para avisarle
            }
        });

        if (!question) return res.status(404).json({ error: 'Pregunta no encontrada.' });

        // Validación: Solo el dueño del producto puede responder
        if (question.product.creatorId !== userId) {
            return res.status(403).json({ error: 'No tienes permiso para responder esta pregunta.' });
        }

        // Guardar respuesta
        const updatedQuestion = await prisma.question.update({
            where: { id },
            data: { 
                answer,
                answeredAt: new Date()
            }
        });

        // EMAIL: Notificar al Interesado (Asker)
        if (resend && question.asker.email) {
            try {
                await resend.emails.send({
                    from: 'MossTall Notificaciones <onboarding@resend.dev>',
                    to: question.asker.email,
                    subject: `✅ Te respondieron sobre: ${question.product.title}`,
                    html: `<p>Hola ${question.asker.name},</p><p>El vendedor respondió tu pregunta sobre <strong>${question.product.title}</strong>:</p><blockquote>"${answer}"</blockquote><p>Entra a MossTall para ver más detalles.</p>`
                });
                console.log('📧 Email de respuesta enviado');
            } catch (emailError) {
                console.error('⚠️ Error enviando email (Resend):', emailError);
            }
        }

        res.json(updatedQuestion);

    } catch (error) {
        console.error('Error respondiendo pregunta:', error);
        res.status(500).json({ error: 'Error al guardar respuesta.' });
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