const ISO_TO_NAME = {
  AD: 'Andorre', AE: 'Émirats arabes unis', AL: 'Albanie', AM: 'Arménie', AO: 'Angola', AR: 'Argentine', AT: 'Autriche', AU: 'Australie', AZ: 'Azerbaïdjan',
  BA: 'Bosnie-Herzégovine', BD: 'Bangladesh', BE: 'Belgique', BF: 'Burkina Faso', BG: 'Bulgarie', BI: 'Burundi', BJ: 'Bénin', BO: 'Bolivie', BR: 'Brésil',
  BW: 'Botswana', BY: 'Biélorussie', CA: 'Canada', CD: 'RD Congo', CF: 'République centrafricaine', CG: 'Congo', CH: 'Suisse', CI: "Côte d'Ivoire", CL: 'Chili',
  CM: 'Cameroun', CN: 'Chine', CO: 'Colombie', CR: 'Costa Rica', CU: 'Cuba', CY: 'Chypre', CZ: 'Tchéquie',
  DE: 'Allemagne', DJ: 'Djibouti', DK: 'Danemark', DO: 'République dominicaine', DZ: 'Algérie',
  EC: 'Équateur', EE: 'Estonie', EG: 'Égypte', ER: 'Érythrée', ES: 'Espagne', ET: 'Éthiopie',
  FI: 'Finlande', FJ: 'Fidji', FR: 'France', GA: 'Gabon', GB: 'Royaume-Uni', GE: 'Géorgie', GH: 'Ghana', GM: 'Gambie', GN: 'Guinée', GQ: 'Guinée équatoriale', GR: 'Grèce', GT: 'Guatemala', GY: 'Guyane',
  HK: 'Hong Kong', HN: 'Honduras', HR: 'Croatie', HT: 'Haïti', HU: 'Hongrie',
  ID: 'Indonésie', IE: 'Irlande', IL: 'Israël', IN: 'Inde', IQ: 'Irak', IR: 'Iran', IS: 'Islande', IT: 'Italie',
  JM: 'Jamaïque', JO: 'Jordanie', JP: 'Japon', KE: 'Kenya', KG: 'Kirghizistan', KH: 'Cambodge', KM: 'Comores', KP: 'Corée du Nord', KR: 'Corée du Sud', KW: 'Koweït', KZ: 'Kazakhstan',
  LA: 'Laos', LB: 'Liban', LK: 'Sri Lanka', LR: 'Liberia', LT: 'Lituanie', LU: 'Luxembourg', LV: 'Lettonie', LY: 'Libye',
  MA: 'Maroc', MC: 'Monaco', MD: 'Moldavie', ME: 'Monténégro', MG: 'Madagascar', MK: 'Macédoine du Nord', ML: 'Mali', MM: 'Myanmar', MN: 'Mongolie', MR: 'Mauritanie', MT: 'Malte', MU: 'Maurice', MV: 'Maldives', MW: 'Malawi', MX: 'Mexique', MY: 'Malaisie', MZ: 'Mozambique',
  NA: 'Namibie', NE: 'Niger', NG: 'Nigeria', NI: 'Nicaragua', NL: 'Pays-Bas', NO: 'Norvège', NP: 'Népal', NZ: 'Nouvelle-Zélande',
  OM: 'Oman', PA: 'Panama', PE: 'Pérou', PG: 'Papouasie-Nouvelle-Guinée', PH: 'Philippines', PK: 'Pakistan', PL: 'Pologne', PT: 'Portugal',
  PY: 'Paraguay', QA: 'Qatar', RO: 'Roumanie', RS: 'Serbie', RU: 'Russie', RW: 'Rwanda',
  SA: 'Arabie saoudite', SC: 'Seychelles', SD: 'Soudan', SE: 'Suède', SG: 'Singapour', SI: 'Slovénie', SK: 'Slovaquie', SL: 'Sierra Leone', SN: 'Sénégal', SO: 'Somalie', SR: 'Suriname', SV: 'Salvador', SY: 'Syrie', SZ: 'Eswatini',
  TD: 'Tchad', TG: 'Togo', TH: 'Thaïlande', TN: 'Tunisie', TR: 'Turquie', TT: 'Trinité-et-Tobago', TW: 'Taïwan', TZ: 'Tanzanie',
  UA: 'Ukraine', UG: 'Ouganda', US: 'États-Unis', UY: 'Uruguay', UZ: 'Ouzbékistan', VE: 'Venezuela', VN: 'Vietnam', YE: 'Yémen', ZA: 'Afrique du Sud', ZM: 'Zambie', ZW: 'Zimbabwe',
};

function stripAccents(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function slugify(value) {
  return stripAccents(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeUpper(value) {
  return stripAccents(value).toUpperCase().replace(/[^A-Z]/g, '');
}

const NAME_TO_ISO = Object.fromEntries(Object.entries(ISO_TO_NAME).map(([iso, name]) => [normalizeUpper(name), iso]));
const BRACKET_PATTERN = /\[([A-Za-z]{2})\]/g;

function fromBracket(value) {
  BRACKET_PATTERN.lastIndex = 0;
  let match;
  while ((match = BRACKET_PATTERN.exec(value)) !== null) {
    const iso = match[1].toUpperCase();
    if (ISO_TO_NAME[iso]) return ISO_TO_NAME[iso];
  }
  return null;
}

// Les drapeaux sont deux Regional Indicator Symbols : 0x1F1E6 ('A') .. 0x1F1FF ('Z').
function fromFlag(value) {
  for (const char of value) {
    if (!char.startsWith('🇦')) continue;
    const codes = [...char].map((part) => part.codePointAt(0));
    if (codes.length !== 2 || codes[0] < 0x1f1e6 || codes[0] > 0x1f1ff || codes[1] < 0x1f1e6 || codes[1] > 0x1f1ff) continue;
    const iso = String.fromCharCode(codes[0] - 0x1f1e6 + 65, codes[1] - 0x1f1e6 + 65);
    if (ISO_TO_NAME[iso]) return ISO_TO_NAME[iso];
  }
  return null;
}

function fromName(value) {
  const normalized = normalizeUpper(value);
  for (const [name, iso] of Object.entries(NAME_TO_ISO)) {
    if (normalized.includes(name)) return ISO_TO_NAME[iso];
  }
  return null;
}

// Réplique de common/normalize/country.ts : [FR] → drapeau → nom de pays.
export function detectCountry(title, groupTitle) {
  for (const candidate of [title, groupTitle ?? '']) {
    const bracket = fromBracket(candidate);
    if (bracket) return bracket;
  }
  for (const candidate of [title, groupTitle ?? '']) {
    const flag = fromFlag(candidate);
    if (flag) return flag;
  }
  for (const candidate of [title, groupTitle ?? '']) {
    const name = fromName(candidate);
    if (name) return name;
  }
  return null;
}
