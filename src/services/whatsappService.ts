// src/services/whatsappService.ts
export const sendOtpMessage = async (phone: string, code: string): Promise<void> => {
  const WHATSAPP_API_URL = process.env.META_WHATSAPP_API_URL; 
  const WHATSAPP_TOKEN = process.env.META_WHATSAPP_TOKEN;
  
  // --- FALLBACK DE DESARROLLO ---
  if (!WHATSAPP_API_URL || !WHATSAPP_TOKEN) {
    console.warn('⚠️ [DEV MODE] Credenciales de Meta Cloud API incompletas o ausentes.');
    console.log(`📱 Simulando envío de OTP por WhatsApp al número ${phone} ---> CÓDIGO: [ ${code} ]`);
    return;
  }
  // ------------------------------

  // Sanitizamos el número
  const cleanPhone = phone.replace(/\D/g, '');

  const payload = {
    messaging_product: 'whatsapp',
    to: cleanPhone,
    type: 'template',
    template: {
      name: 'auth_code_mv', // 1. Corregido: Coincide con el nombre aprobado en Meta
      language: {
        code: 'en' // 2. Corregido: En la captura quedó configurado en English
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
        }
        // 3. Corregido: Se eliminó el bloque de "button" porque la plantilla final de Utilidad no tiene botones interactivos.
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
      console.error('Error desde Meta API:', JSON.stringify(errorData, null, 2));
      throw new Error('Fallo al enviar el mensaje de WhatsApp.');
    }
  } catch (error) {
    console.error('Error conectando con el servicio de WhatsApp:', error);
    throw error;
  }
};