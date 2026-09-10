import { ConfigService } from '@nestjs/config';
import { resolveCors } from './cors';

// ConfigService factice : seule resolveCors consomme .get<string>(clé, défaut).
function fakeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string, defaultValue?: T): T => ((values[key] as T | undefined) ?? defaultValue) as T,
  } as unknown as ConfigService;
}

describe('resolveCors', () => {
  describe('production', () => {
    const prod = { NODE_ENV: 'production' };

    it('refuse le démarrage en mode permissif copié du .env.example', () => {
      expect(() => resolveCors(fakeConfig({ ...prod, CORS_MODE: 'permissive' }))).toThrow(/permissive interdit/);
    });

    it('refuse le démarrage si CORS_ALLOWED_ORIGINS est vide', () => {
      expect(() => resolveCors(fakeConfig({ ...prod, CORS_ALLOWED_ORIGINS: '' }))).toThrow(/vide en production/);
    });

    it('refuse le démarrage si la liste n\'est que des espaces/virgules', () => {
      expect(() => resolveCors(fakeConfig({ ...prod, CORS_ALLOWED_ORIGINS: ' , ,  ' }))).toThrow(/vide en production/);
    });

    it('interdit le joker *', () => {
      expect(() => resolveCors(fakeConfig({ ...prod, CORS_ALLOWED_ORIGINS: '*' }))).toThrow(/non admise/);
    });

    it('interdit localhost et les origines http', () => {
      expect(() =>
        resolveCors(fakeConfig({ ...prod, CORS_ALLOWED_ORIGINS: 'https://mbolotv-web.vercel.app,http://localhost:3000' })),
      ).toThrow(/localhost:3000/);
    });

    it('interdit les origines avec chemin ou joker de sous-domaine', () => {
      expect(() => resolveCors(fakeConfig({ ...prod, CORS_ALLOWED_ORIGINS: 'https://mbolo.tv/app' }))).toThrow(/non admise/);
      expect(() => resolveCors(fakeConfig({ ...prod, CORS_ALLOWED_ORIGINS: 'https://*.mbolo.tv' }))).toThrow(/non admise/);
    });

    it('accepte une liste https concrète et normalise (espaces, / final)', () => {
      const result = resolveCors(
        fakeConfig({ ...prod, CORS_ALLOWED_ORIGINS: ' https://mbolotv-web.vercel.app/,https://mbolo.tv ' }),
      );
      expect(result).toEqual({ origins: ['https://mbolotv-web.vercel.app', 'https://mbolo.tv'] });
    });

    it('reste strict par défaut (aucune variable CORS définie)', () => {
      // NODE_ENV=production sans CORS_MODE : strict implicite, liste vide → refus.
      expect(() => resolveCors(fakeConfig(prod))).toThrow(/vide en production/);
    });
  });

  describe('hors production', () => {
    it('autorisé en mode permissif (comportement de développement)', () => {
      expect(resolveCors(fakeConfig({ NODE_ENV: 'development' }))).toEqual({ origins: true });
      expect(resolveCors(fakeConfig({ NODE_ENV: 'development', CORS_MODE: 'permissive' }))).toEqual({ origins: true });
    });

    it('liste vide en mode strict : CORS refusé sans empêcher le démarrage', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(resolveCors(fakeConfig({ NODE_ENV: 'development', CORS_MODE: 'strict', CORS_ALLOWED_ORIGINS: '' }))).toEqual({ origins: false });
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('pas de validation des origines hors production (localhost admis)', () => {
      expect(
        resolveCors(fakeConfig({ NODE_ENV: 'development', CORS_MODE: 'strict', CORS_ALLOWED_ORIGINS: 'http://localhost:3000' })),
      ).toEqual({ origins: ['http://localhost:3000'] });
    });
  });
});
