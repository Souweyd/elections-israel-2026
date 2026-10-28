// Collecte et contrôle des résultats publiés par la Commission électorale centrale (CEC).
//
// Source : fichier officiel « résultats par localité » mis à jour pendant le dépouillement
//   https://media26.bechirot.gov.il/files/expc.csv
// Une ligne par localité ; colonnes de métadonnées puis une colonne par liste (lettres
// du bulletin). Les totaux nationaux sont la somme des lignes.
//
// La CEC est protégée par un pare-feu applicatif (AWS WAF) qui peut répondre HTTP 202
// avec l'en-tête « x-amzn-waf-action: challenge ». Ce défi n'est JAMAIS contourné :
// on le signale, on espace les tentatives et on conserve la dernière donnée vérifiée.

export const META_COLS = ["סמל ועדה", "שם ישוב", "סמל ישוב", "בזב", "מצביעים", "פסולים", "כשרים"];
const REQUIRED = ["בזב", "מצביעים", "פסולים", "כשרים"];

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'blocked' | 'http' | 'network' | 'format' | 'empty'
  }
}

/** Décode en UTF-8 ; à défaut, en Windows-1255 (encodage historique des fichiers CEC). */
export function decodeBody(buf) {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    // Windows-1255 : ASCII inchangé, lettres hébraïques 0xE0-0xFA → U+05D0-U+05EA
    let out = "";
    for (const b of bytes) {
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b >= 0xe0 && b <= 0xfa) out += String.fromCharCode(0x05d0 + (b - 0xe0));
      else if (b === 0xa0) out += " ";
      else out += "�";
    }
    return out;
  }
}

/** Analyse CSV minimale gérant les guillemets. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const toInt = (s) => {
  const n = parseInt(String(s ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Agrège le CSV par localité en totaux nationaux et contrôle la cohérence interne.
 * @returns {{totals, votes, localities, checks}}
 */
export function aggregate(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new SourceError("empty", "Fichier CEC vide ou sans ligne de données");
  const header = rows[0].map((h) => h.trim());
  for (const col of REQUIRED) {
    if (!header.includes(col)) {
      throw new SourceError("format", `Colonne obligatoire absente du fichier CEC : « ${col} »`);
    }
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const letters = header.filter((h) => h && !META_COLS.includes(h));
  if (letters.length === 0) throw new SourceError("format", "Aucune colonne de liste détectée");

  const totals = { eligible: 0, voters: 0, invalid: 0, valid: 0 };
  const votes = Object.fromEntries(letters.map((l) => [l, 0]));
  const anomalies = [];
  let localities = 0;
  let countedLocalities = 0;

  for (const r of rows.slice(1)) {
    localities++;
    const eligible = toInt(r[idx["בזב"]]);
    const voters = toInt(r[idx["מצביעים"]]);
    const invalid = toInt(r[idx["פסולים"]]);
    const valid = toInt(r[idx["כשרים"]]);
    let rowSum = 0;
    for (const l of letters) {
      const v = toInt(r[idx[l]]);
      votes[l] += v;
      rowSum += v;
    }
    totals.eligible += eligible;
    totals.voters += voters;
    totals.invalid += invalid;
    totals.valid += valid;
    if (voters > 0) countedLocalities++;
    if (rowSum !== valid && anomalies.length < 20) {
      anomalies.push(`Localité ${r[idx["שם ישוב"]] ?? "?"} : somme des listes ${rowSum} ≠ valides ${valid}`);
    }
  }

  const partySum = Object.values(votes).reduce((s, v) => s + v, 0);
  const checks = {
    partySumMatchesValid: partySum === totals.valid,
    validPlusInvalidMatchesVoters: totals.valid + totals.invalid === totals.voters,
    votersWithinEligible: totals.eligible === 0 || totals.voters <= totals.eligible,
    anomalies,
  };
  return { totals, votes, localities, countedLocalities, checks };
}

/**
 * Télécharge le fichier CEC. Requête conditionnelle (ETag / Last-Modified) pour ne pas
 * re-télécharger un fichier inchangé.
 */
export async function fetchCec(url, { etag, lastModified, userAgent } = {}) {
  const headers = { "User-Agent": userAgent, Accept: "text/csv,*/*;q=0.5" };
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;
  let res;
  try {
    res = await fetch(url, { headers, cf: { cacheTtl: 0 } });
  } catch (e) {
    throw new SourceError("network", `Source injoignable : ${e.message}`);
  }
  if (res.status === 304) return { notModified: true };
  if (res.status === 202 || res.headers.get("x-amzn-waf-action")) {
    throw new SourceError("blocked", "La CEC oppose un défi anti-robot (AWS WAF) : lecture suspendue, non contournée");
  }
  if (!res.ok) throw new SourceError("http", `La CEC a répondu HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new SourceError("empty", "Réponse vide de la CEC");
  return {
    notModified: false,
    text: decodeBody(buf),
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
}
