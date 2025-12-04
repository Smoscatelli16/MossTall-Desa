import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log(' Iniciando la siembra de categorías...');

  // 1. Categoría: TECNOLOGÍA
  const tecno = await prisma.category.upsert({
    where: { slug: 'tecnologia' },
    update: {},
    create: {
      name: 'Tecnología',
      slug: 'tecnologia',
      children: {
        create: [
          { name: 'Celulares', slug: 'tecnologia-celulares' },
          { name: 'Computación', slug: 'tecnologia-computacion' },
          { name: 'Cámaras', slug: 'tecnologia-camaras' },
        ],
      },
    },
  });

  // 2. Categoría: HOGAR
  const hogar = await prisma.category.upsert({
    where: { slug: 'hogar' },
    update: {},
    create: {
      name: 'Hogar y Muebles',
      slug: 'hogar',
      children: {
        create: [
          { name: 'Muebles', slug: 'hogar-muebles' },
          { name: 'Decoración', slug: 'hogar-decoracion' },
          { name: 'Jardín', slug: 'hogar-jardin' },
        ],
      },
    },
  });

  // 3. Categoría: SERVICIOS (Importante para tu modelo de negocio)
  const servicios = await prisma.category.upsert({
    where: { slug: 'servicios' },
    update: {},
    create: {
      name: 'Servicios',
      slug: 'servicios',
      children: {
        create: [
          { name: 'Oficios (Plomería, Gas, etc)', slug: 'servicios-oficios' },
          { name: 'Tecnología y Diseño', slug: 'servicios-tech' },
          { name: 'Clases y Cursos', slug: 'servicios-clases' },
        ],
      },
    },
  });
  
  // 4. Categoría: VEHÍCULOS
  const vehiculos = await prisma.category.upsert({
    where: { slug: 'vehiculos' },
    update: {},
    create: {
      name: 'Vehículos',
      slug: 'vehiculos',
      children: {
        create: [
          { name: 'Autos', slug: 'vehiculos-autos' },
          { name: 'Motos', slug: 'vehiculos-motos' },
          { name: 'Repuestos', slug: 'vehiculos-repuestos' },
        ],
      },
    },
  });

  console.log('✅ ¡Siembra completada! Categorías creadas.');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });