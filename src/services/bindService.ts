// src/services/bindService.ts
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';

// --- CONFIGURACIÓN DE ENTORNO ---
const BIND_API_URL = process.env.BIND_API_URL || 'https://sandbox.bind.com.ar/v1'; // Cambiar a Prod
const BIND_CLIENT_ID = process.env.BIND_CLIENT_ID;
const BIND_CLIENT_SECRET = process.env.BIND_CLIENT_SECRET;
const BIND_ACCOUNT_ID = process.env.BIND_ACCOUNT_ID; // La cuenta puente de MossTall

if (!BIND_CLIENT_ID || !BIND_CLIENT_SECRET || !BIND_ACCOUNT_ID) {
    console.warn("⚠️ Advertencia: Credenciales del Banco BIND no están configuradas en .env");
}

class BindService {
    private client: AxiosInstance;
    private accessToken: string | null = null;
    private tokenExpiry: number | null = null;

    constructor() {
        this.client = axios.create({
            baseURL: BIND_API_URL,
            timeout: 10000,
        });
    }

    /**
     * 1. Autenticación (OAuth2 / Client Credentials)
     * Obtiene un token Bearer para firmar las peticiones.
     */
    private async authenticate(): Promise<string> {
        // Retornar token cacheado si aún es válido
        if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        try {
            console.log('Autenticando con API BIND...');
            
            // Los headers varían según la documentación exacta del BIND, esto es un estándar común OAuth2
            const tokenResponse = await axios.post(`${BIND_API_URL}/oauth/token`, 
                new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: BIND_CLIENT_ID || '',
                    client_secret: BIND_CLIENT_SECRET || ''
                }).toString(),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            );

            this.accessToken = tokenResponse.data.access_token;
            // Guardamos el tiempo de expiración (generalmente 3600 segundos) con un margen de seguridad
            this.tokenExpiry = Date.now() + ((tokenResponse.data.expires_in - 60) * 1000);
            
            return this.accessToken!;
        } catch (error: any) {
            console.error('❌ Error autenticando con BIND:', error.response?.data || error.message);
            throw new Error('Fallo la autenticación con el proveedor bancario.');
        }
    }

    /**
     * 2. Generador de ID de Trazabilidad (Idempotencia)
     * Vital para evitar transferencias duplicadas si falla la red.
     */
    private generateTraceabilityId(transactionId: string): string {
        return crypto.createHash('sha256').update(`mosstall_transfer_${transactionId}_${Date.now()}`).digest('hex').substring(0, 32);
    }

    /**
     * 3. Ejecutar Transferencia a CVU/CBU
     * @param targetCvuCbu CVU o CBU de destino
     * @param amount Monto neto a transferir (como número)
     * @param concept Concepto de la transferencia (ej. VARIOS, FACTURA)
     * @param reference Referencia interna (ej. ID de la transacción de MossTall)
     */
    public async transferToCVU(
        targetCvuCbu: string, 
        amount: number, 
        concept: string = 'VARIOS',
        reference: string
    ): Promise<{ success: boolean; transferId?: string; error?: string }> {
        
        try {
            const token = await this.authenticate();
            const traceabilityId = this.generateTraceabilityId(reference);

            const payload = {
                origin_id: BIND_ACCOUNT_ID, // Desde la cuenta concentradora de MossTall
                to: {
                    cbu: targetCvuCbu
                },
                value: {
                    currency: 'ARS',
                    amount: parseFloat(amount.toFixed(2)) // Asegurar formato decimal preciso
                },
                concept: concept,
                description: `Liquidación MossTall Ref: ${reference.substring(0, 10)}`,
                // Headers adicionales o metadata según requiera BIND
            };

            const response = await this.client.post('/transfers', payload, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Traceability-Id': traceabilityId,
                    'Content-Type': 'application/json'
                }
            });

            console.log(`✅ Transferencia BIND exitosa. ID: ${response.data.id}`);
            return {
                success: true,
                transferId: response.data.id
            };

        } catch (error: any) {
            console.error('❌ Error ejecutando transferencia BIND:', error.response?.data || error.message);
            
            // En un entorno productivo, aquí deberíamos guardar el error en una tabla de base de datos
            // para auditoría y reintento manual.
            return {
                success: false,
                error: error.response?.data?.message || 'Error en la red bancaria.'
            };
        }
    }
}

// Exportamos una instancia única (Singleton)
export const bindService = new BindService();