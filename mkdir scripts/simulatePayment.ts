// simulatePayment.ts
import prisma from '../src/lib/prisma';

async function main() {
  const lastTx = await prisma.transaction.findFirst({
    orderBy: { createdAt: 'desc' }
  });

  if (!lastTx) {
    console.log('❌ No hay transacciones en la base de datos.');
    return;
  }

  const updatedTx = await prisma.transaction.update({
    where: { id: lastTx.id },
    data: { state: 'PAID_HELD' }
  });

  console.log('\n==================================================');
  console.log('✅ PAGO SIMULADO CON ÉXITO');
  console.log('ID Transacción:', updatedTx.id);
  console.log('Nuevo Estado:', updatedTx.state);
  console.log('==================================================\n');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());