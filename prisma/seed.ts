// prisma/seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando Seeding de Categorías (Estructura #015)...');

  // 1. Limpiar categorías existentes
  try {
      await prisma.category.deleteMany({});
      console.log('🧹 Categorías anteriores eliminadas.');
  } catch (e) {
      console.warn('⚠️ La tabla estaba vacía o hubo un aviso al limpiar.');
  }

  // 2. Definición de la Estructura
  const structure = [
    {
      name: 'Vehículos',
      children: ['Autos y Camionetas', 'Motos', 'Náutica', 'Repuestos y Accesorios', 'Otros Vehículos']
    },
    {
      name: 'Inmuebles',
      children: ['Venta de Casas', 'Alquiler', 'Terrenos y Lotes', 'Comercial', 'Otros Inmuebles']
    },
    {
      name: 'Tecnología',
      children: ['Celulares', 'Computación', 'Consolas y Videojuegos', 'Cámaras', 'Otros Tecnología']
    },
    {
      name: 'Hogar y Muebles',
      children: ['Muebles', 'Jardín y Aire Libre', 'Electrodomésticos', 'Decoración', 'Otros Hogar']
    },
    {
      name: 'Moda y Deportes',
      children: ['Ropa y Calzado', 'Accesorios', 'Deportes y Fitness', 'Otros Moda']
    },
    {
      name: 'Servicios',
      children: ['Hogar y Mantenimiento', 'Técnicos PC/Celulares', 'Profesionales', 'Eventos', 'Otros Servicios']
    },
    {
      name: 'Infoproductos',
      children: ['Cursos y Ebooks', 'Software', 'Entradas', 'Otros Infoproductos']
    },
    {
      name: 'Otros / Varios',
      children: ['Otros Productos', 'Otros Servicios', 'Otras Cosas']
    }
  ];

  // 3. Inserción en Base de Datos
  for (const mainCat of structure) {
    const slugPadre = mainCat.name.toLowerCase()
        .replace(/ /g, '-')
        .replace(/\//g, '-')
        .replace(/ñ/g, 'n')
        .replace(/[áéíóú]/g, (m) => ({'á':'a','é':'e','í':'i','ó':'o','ú':'u'}[m] || m));

    const parent = await prisma.category.upsert({
      where: { slug: slugPadre },
      update: {},
      create: {
        name: mainCat.name,
        slug: slugPadre,
      }
    });

    console.log(`📁 Creada rama: ${mainCat.name}`);

    for (const childName of mainCat.children) {
      const baseSlugHijo = childName.toLowerCase()
        .replace(/ /g, '-')
        .replace(/\//g, '-')
        .replace(/ñ/g, 'n')
        .replace(/[áéíóú]/g, (m) => ({'á':'a','é':'e','í':'i','ó':'o','ú':'u'}[m] || m));

      // GARANTÍA DE UNICIDAD: Padre + Hijo
      const slugHijo = `${slugPadre}-${baseSlugHijo}`;

      await prisma.category.upsert({
        where: { slug: slugHijo },
        update: { parentId: parent.id },
        create: {
          name: childName,
          slug: slugHijo,
          parentId: parent.id
        }
      });
    }
  }

  console.log('✅ Seeding completado con éxito.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });