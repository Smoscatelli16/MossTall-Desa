// src/middlewares/telemetryMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import { UAParser } from 'ua-parser-js';
import { PostHog } from 'posthog-node';
import crypto from 'crypto';

export interface TelemetryContext {
  $device_type: string;
  $device_model: string;
  $os: string;
  $browser: string;
  $network_isp: string;
  connection_tier: 'HIGH_END_MOBILE' | 'MID_LOW_MOBILE' | 'DESKTOP' | 'UNKNOWN';
}

declare global {
  namespace Express {
    interface Request {
      telemetry?: TelemetryContext;
      userId?: string;
    }
  }
}

// Cliente PostHog Node singleton (flush asíncrono por lotes para latencia cero)
const posthogClient = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt: 20,
      flushInterval: 10000,
    })
  : null;

// Tabla local en memoria de bloques IPv4 (ASN / ISP Argentina y Misiones)
const ISP_PREFIX_MAP: Array<{ prefixes: string[]; isp: string }> = [
  { prefixes: ['181.46.', '181.47.', '186.136.', '186.137.', '190.19.', '190.192.', '190.244.', '190.245.', '200.115.', '201.212.', '201.213.'], isp: 'Telecom / Fibertel' },
  { prefixes: ['181.164.', '181.165.', '181.166.', '181.167.', '186.18.', '186.19.', '190.172.', '190.173.', '190.174.', '190.175.', '200.45.', '200.51.'], isp: 'Movistar / Telefónica' },
  { prefixes: ['181.28.', '181.29.', '181.30.', '181.31.', '170.51.', '190.111.', '200.68.'], isp: 'Claro Argentina' },
  { prefixes: ['190.12.', '190.210.', '200.85.'], isp: 'Gigared (NEA / Posadas)' },
  { prefixes: ['179.0.', '45.224.', '45.225.'], isp: 'Marandú Comunicaciones (Misiones)' },
  { prefixes: ['143.131.', '149.19.', '98.97.', '129.222.'], isp: 'Starlink' },
];

function extractClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  let rawIp = '';

  if (typeof forwarded === 'string' && forwarded.length > 0) {
    rawIp = forwarded.split(',')[0].trim();
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    rawIp = forwarded[0].trim();
  } else {
    rawIp = (req.headers['x-real-ip'] as string) || req.socket?.remoteAddress || '';
  }

  return rawIp.replace(/^::ffff:/, '');
}

function resolveIspInMemory(ip: string): string {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return 'Local / Red Privada';
  }

  for (const entry of ISP_PREFIX_MAP) {
    for (const prefix of entry.prefixes) {
      if (ip.startsWith(prefix)) {
        return entry.isp;
      }
    }
  }

  return 'ISP Externo / Móvil';
}

function classifyHardwareTier(deviceType: string, deviceModel: string, osName: string): TelemetryContext['connection_tier'] {
  if (deviceType === 'desktop') return 'DESKTOP';
  if (deviceType === 'mobile' || deviceType === 'tablet') {
    const modelLower = deviceModel.toLowerCase();
    if (
      osName.toLowerCase().includes('ios') ||
      modelLower.includes('iphone') ||
      modelLower.includes('ipad') ||
      modelLower.includes('s23') ||
      modelLower.includes('s24') ||
      modelLower.includes('s25') ||
      modelLower.includes('pixel')
    ) {
      return 'HIGH_END_MOBILE';
    }
    return 'MID_LOW_MOBILE';
  }
  return 'UNKNOWN';
}

export const telemetryMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    const uaString = req.headers['user-agent'] || '';
    const parser = new UAParser(uaString);
    const device = parser.getDevice();
    const os = parser.getOS();
    const browser = parser.getBrowser();

    const deviceType = device.type || (uaString ? 'desktop' : 'unknown');
    const deviceModel = [device.vendor, device.model].filter(Boolean).join(' ') || (deviceType === 'desktop' ? 'PC / Workstation' : 'Genérico');
    const osFormatted = [os.name, os.version].filter(Boolean).join(' ') || 'Desconocido';
    const browserFormatted = [browser.name, browser.major].filter(Boolean).join(' ') || 'Desconocido';

    const clientIp = extractClientIp(req);
    const networkIsp = resolveIspInMemory(clientIp);
    const connectionTier = classifyHardwareTier(deviceType, deviceModel, os.name || '');

    const telemetryData: TelemetryContext = {
      $device_type: deviceType,
      $device_model: deviceModel,
      $os: osFormatted,
      $browser: browserFormatted,
      $network_isp: networkIsp,
      connection_tier: connectionTier,
    };

    req.telemetry = telemetryData;

    // Captura asíncrona en segundo plano (0ms de impacto en la respuesta HTTP)
    if (posthogClient && req.path.startsWith('/api/') && !req.path.includes('/webhook')) {
      const userIdSnapshot = req.userId;
      const pathSnapshot = req.path;
      const methodSnapshot = req.method;

      setImmediate(() => {
        try {
          // Identificador anónimo derivado por hash si no hay sesión autenticada (cumplimiento Ley 25.326)
          const distinctId = userIdSnapshot
            ? userIdSnapshot
            : `anon_${crypto.createHash('sha256').update(`${clientIp}|${uaString}`).digest('hex').slice(0, 16)}`;

          posthogClient.capture({
            distinctId,
            event: 'api_environment_profiled',
            properties: {
              ...telemetryData,
              endpoint: pathSnapshot,
              http_method: methodSnapshot,
            },
          });
        } catch {
          // Silencioso para no interrumpir nunca el proceso principal
        }
      });
    }
  } catch {
    // Nunca bloquear una petición transaccional por telemetría
  }

  next();
};