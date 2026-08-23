import { ArgumentsHost, BadGatewayException, Catch, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

/**
 * Cloudflare Tunnel remplace les réponses 502 émises par l'origine par sa propre
 * page d'erreur « error code: 502 » — sans nos en-têtes CORS. Le navigateur
 * affiche alors un blocage CORS au lieu du vrai message. On réémet donc les
 * BadGatewayException en 503 (Service Unavailable), qui traverse le tunnel tel quel.
 */
@Catch(BadGatewayException)
export class TunnelSafeExceptionFilter implements ExceptionFilter {
  catch(exception: BadGatewayException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const status = exception.getStatus();
    if (status !== 502) {
      response.status(status).send({ statusCode: status, message: exception.message, error: exception.name });
      return;
    }
    response.status(503).send({ statusCode: 503, message: exception.message, error: 'Service Unavailable' });
  }
}
