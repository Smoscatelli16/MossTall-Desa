// src/services/whatsappService.ts
export const sendOtpMessage = async (phone: string, code: string): Promise<void> => {
  const WHATSAPP_API_URL = process.env.META_WHATSAPP_API_URL; // Ej: https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages
  const WHATSAPP_TOKEN = process.env.META_WHATSAPP_TOKEN;
  
  // --- FALLBACK DE DESARROLLO ---
  // Si no hay credenciales configuradas, simulamos el envío por consola para no bloquear el testeo
  if (!WHATSAPP_API_URL || !WHATSAPP_TOKEN) {
    console.warn('⚠️ [DEV MODE] Credenciales de Meta Cloud API incompletas o ausentes.');
    console.log(`📱 Simulando envío de OTP por WhatsApp al número ${phone} ---> CÓDIGO: [ ${code} ]`);
    return; // Retornamos exitosamente para que el controlador siga su curso
  }
  // ------------------------------

  // Sanitizamos el número (remover prefijo + si viene y asegurarnos que sea formato internacional)
  const cleanPhone = phone.replace(/\D/g, '');

  const payload = {
    messaging_product: 'whatsapp',
    to: cleanPhone,
    type: 'template',
    template: {
      name: 'auth_code_mosstall', // Nombre de la plantilla pre-aprobada en Meta
      language: {
        code: 'es_AR'
      },
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: code
            }
          ]
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [
            {
              type: 'text',
              text: code // Por si la plantilla usa botones de autocompletado (opcional según el setup en Meta)
            }
          ]
        }
      ]
    }
  };

  try {
    const response = await fetch(WHATSAPP_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Error desde Meta API:', errorData);
      throw new Error('Fallo al enviar el mensaje de WhatsApp.');
    }
  } catch (error) {
    console.error('Error conectando con el servicio de WhatsApp:', error);
    throw error;
  }
};