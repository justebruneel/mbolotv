// Carte des relais résidentiels partagée par play/healthcheck/epgimport/macportal.
// Priorité : RELAY_MAP (hôte exact) > RELAY_DOMAIN_MAP (suffixe domaine, pour
// les panels aux serveurs médias numérotés) > RELAY_DEFAULT_ORIGIN : tout
// fournisseur inconnu sort automatiquement par le relais générique relay-dns
// — aucune config à ajouter lors de l'import d'une nouvelle playlist.
// Le forwarder local route via « x-upstream-authority » et exige le jeton
// partagé « x-relay-token » (secret RELAY_TOKEN, même valeur que le proxy).

export function isPrivateHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(':')) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  return !host.includes('.');
}

export function resolveRelay(env, targetUrl) {
  const plain = { url: targetUrl, headers: {} };
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return plain;
    const authority = parsed.host;
    let destination = null;
    if (env?.RELAY_MAP) destination = JSON.parse(env.RELAY_MAP)[authority] ?? null;
    if (!destination && env?.RELAY_DOMAIN_MAP) {
      const domainMap = JSON.parse(env.RELAY_DOMAIN_MAP);
      for (const [domain, relay] of Object.entries(domainMap)) {
        if (parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)) { destination = relay; break; }
      }
    }
    const defaultOrigin = env?.RELAY_DEFAULT_ORIGIN ? String(env.RELAY_DEFAULT_ORIGIN).trim().replace(/\/+$/, '') : '';
    if (!destination && defaultOrigin) {
      const defaultHost = new URL(defaultOrigin).host;
      if (authority !== defaultHost && !isPrivateHostname(parsed.hostname)) destination = defaultOrigin;
    }
    if (!destination || new URL(destination).host === authority) return plain;
    const headers = { 'x-upstream-authority': authority };
    const token = env?.RELAY_TOKEN ? String(env.RELAY_TOKEN).trim() : '';
    if (token) headers['x-relay-token'] = token;
    return {
      url: targetUrl.replace(`${parsed.protocol}//${parsed.host}`, destination.replace(/\/+$/, '')),
      headers,
    };
  } catch {
    return plain;
  }
}
