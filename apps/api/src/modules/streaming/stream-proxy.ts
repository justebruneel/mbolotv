import { BadGatewayException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { HostValidationCache } from './host-validation.cache';

const MAX_REDIRECTS = 5;
const HEADERS_TIMEOUT_MS = 15_000;
const MAX_FETCH_RETRIES = 2;
const FETCH_RETRY_DELAY_MS = 400;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface StreamProxyResponse {
  status: number;
  contentType: string | null;
  contentLength: number | null;
  contentRange: string | null;
  acceptRanges: string | null;
  stream: Readable;
  finalUrl: string;
}

export class StreamProxy {
  private readonly userAgent: string;

  constructor(
    userAgent = BROWSER_USER_AGENT,
    private readonly hostValidation = new HostValidationCache(),
  ) {
    this.userAgent = userAgent;
  }

  async fetch(
    rawUrl: string,
    options: { headers?: Record<string, string>; allowedHostnames: Set<string> },
  ): Promise<StreamProxyResponse> {
    // Les pannes fournisseur sont souvent transitoires (502, timeout, connexion
    // interrompue) : on retente rapidement avant de renvoyer une erreur au client.
    for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt += 1) {
      try {
        return await this.fetchOnce(rawUrl, options);
      } catch (error) {
        const retriable = isTransientError(error) && attempt < MAX_FETCH_RETRIES;
        if (!retriable) throw error;
        await sleep(FETCH_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    // Inatteignable : le try/catch ci-dessus sort toujours via un throw.
    throw new BadGatewayException('Connexion fournisseur impossible');
  }

  private async fetchOnce(
    rawUrl: string,
    options: { headers?: Record<string, string>; allowedHostnames: Set<string> },
  ): Promise<StreamProxyResponse> {
    let url: URL | undefined;
    let needsInitialCheck = true;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);

      try {
        if (needsInitialCheck) {
          url = await this.assertAllowed(rawUrl, options.allowedHostnames);
          needsInitialCheck = false;
        }

        const response = await fetch(url!, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': this.userAgent,
            accept: '*/*',
            ...options.headers,
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            // Corps non lu + fermeture du fournisseur => assert undici (#5360).
            await response.body?.cancel();
            throw new BadGatewayException('Redirection fournisseur sans destination');
          }
          await response.body?.cancel();
          // Les redirections du fournisseur sont suivies après validation SSRF
          // (hôte public uniquement), sans appliquer l'allowlist de session.
          url = new URL(location, url!);
          await this.hostValidation.assertSafeHost(url);
          continue;
        }

        if (response.status < 200 || response.status >= 400) {
          await response.body?.cancel();
          throw new BadGatewayException(`Réponse HTTP ${response.status} du fournisseur`);
        }

        if (!response.body) {
          throw new BadGatewayException('Réponse fournisseur sans contenu');
        }

        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          contentLength: toNullableInt(response.headers.get('content-length')),
          contentRange: response.headers.get('content-range'),
          acceptRanges: response.headers.get('accept-ranges'),
          stream: Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
          finalUrl: url!.toString(),
        };
      } catch (error) {
        if (error instanceof BadGatewayException) throw error;
        const reason = error instanceof Error ? error.name : 'UNKNOWN';
        if (reason === 'AbortError') {
          throw new BadGatewayException('Délai dépassé chez le fournisseur');
        }
        throw new BadGatewayException('Connexion fournisseur impossible');
      } finally {
        clearTimeout(timer);
      }
    }

    throw new BadGatewayException('Trop de redirections chez le fournisseur');
  }

  private async assertAllowed(rawUrl: string, allowedHostnames: Set<string>): Promise<URL> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BadGatewayException('URL fournisseur invalide');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadGatewayException('Protocole fournisseur non autorisé');
    }
    // Vérification de la liste blanche avant toute résolution DNS : on ne résout
    // jamais un hôte qui n'est pas autorisé (évite aussi les tests réseau lents).
    const hostname = url.hostname.toLowerCase();
    const allowed = [...allowedHostnames].some((allowedHost) => {
      const allowedLower = allowedHost.toLowerCase();
      return hostname === allowedLower || hostname.endsWith(`.${allowedLower}`);
    });
    if (!allowed) {
      throw new BadGatewayException('Hôte fournisseur non autorisé');
    }
    // Contrôle SSRF (protocole, DNS, IP privées) sur un hôte autorisé uniquement.
    // La résolution DNS est mise en cache par hostname (10 min) : sans cache,
    // chaque segment paierait une ou deux résolutions DNS.
    await this.hostValidation.assertSafeHost(url);
    return url;
  }
}

function toNullableInt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Une erreur 4xx est déterministe (le segment n'existe pas), pas la peine de retenter.
// Les 5xx, timeouts et échecs de connexion sont transitoires et méritent un retry.
function isTransientError(error: unknown): boolean {
  if (!(error instanceof BadGatewayException)) return false;
  return !/R\u00e9ponse HTTP 4\d{2}/.test(error.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
