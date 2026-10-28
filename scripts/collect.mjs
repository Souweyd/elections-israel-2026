// Collecteur exécuté par GitHub Actions (toutes les 5 minutes).
// Lit le fichier officiel de la Commission électorale centrale (CEC), contrôle sa cohérence,
// calcule la répartition des sièges (Bader-Ofer) et écrit data/latest.json, data/history.json,
// data/status.json. Le workflow ne publie (commit) que si l'un de ces fichiers a changé.
//
// Le défi anti-robot de la CEC (HTTP 202 + x-amzn-waf-action) n'est jamais contourné :
// il est seulement constaté et signalé sur la page.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { aggregate, decodeBody } from "./cec.mjs";
import { allocateSeats } from "./seats.mjs";

const CEC_URL = process.env.CEC_URL || "https://media26.bechirot.gov.il/files/expc.csv";
const UA = "Mozilla/5.0 (compatible; elections-israel-2026/1.0; +https://souweyd.github.io/elections-israel-2026/)";
const FINAL_TURNOUT = 0.777; // participation finale annoncée par la CEC le 27/10 au soir
const HEARTBEAT_MS = 30 * 60_000; // statut réécrit au moins toutes les 30 min, même sans changement
const TOLERANCE = 0.001;

// Lettres de bulletin (en-têtes du CSV CEC) → listes. Sources : CEC / presse (voir README).
export const PARTIES = {
  "מחל": { id: "likud", name: "Likoud", leader: "Benjamin Netanyahou", bloc: "coal", color: "#3987e5" },
  "דרך": { id: "yashar", name: "Yashar!", leader: "Gadi Eisenkot", bloc: "opp", color: "#d95926" },
  "ודם": { id: "joint", name: "Liste unifiée", leader: "Youssef Jabareen", bloc: "arab", color: "#2e9a4a" },
  "רק": { id: "ensemble", name: "Ensemble (Beyahad)", leader: "Naftali Bennett", bloc: "opp", color: "#1fa5b8" },
  "ג": { id: "utj", name: "Judaïsme unifié de la Torah", leader: "Yaakov Asher", bloc: "coal", color: "#7a8aa3" },
  "אמת": { id: "dem", name: "Les Démocrates", leader: "Yaïr Golan", bloc: "opp", color: "#d55181" },
  "ל": { id: "yb", name: "Israel Beytenou", leader: "Avigdor Liberman", bloc: "opp", color: "#9085e9" },
  "שס": { id: "shas", name: "Shass", leader: "Aryeh Deri", bloc: "coal", color: "#2f5fa8" },
  "ב": { id: "otzma", name: "Otzma Yehudit", leader: "Itamar Ben Gvir", bloc: "coal", color: "#c98500" },
  "ט": { id: "rzp", name: "Sionisme religieux – Zehout", leader: "Bezalel Smotrich", bloc: "coal", color: "#a88a3d" },
  "עם": { id: "raam", name: "Ra'am", leader: "Mansour Abbas", bloc: "arab", color: "#6fb85b" },
  "ני": { id: "noam", name: "Noam", leader: "Avi Maoz", bloc: "coal", color: "#8d8578" },
  "די": { id: "reserv", name: "Réservistes – Parti économique", leader: "Yoaz Hendel", bloc: "other", color: "#a3a3a3" },
  "ך": { id: "amcha", name: "Amcha Yisrael", leader: "Ofer Winter", bloc: "other", color: "#9ca3af" },
  "י": { id: "first", name: "Israel d'abord", leader: "Sharren Haskel", bloc: "other", color: "#9ca3af" },
};
// Accords d'excédents de voix (date limite 16/10/2026) — source : Wikipédia, à recouper avec la CEC.
const AGREEMENTS = [["רק", "ל"], ["דרך", "אמת"], ["ודם", "עם"], ["מחל", "ט"], ["שס", "ג"]];

const meta = (l) => PARTIES[l] ?? { id: `l-${l}`, name: `Liste « ${l} »`, leader: "—", bloc: "other", color: "#9ca3af" };

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 1) + "\n");

async function fetchCec() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(CEC_URL, { headers: { "User-Agent": UA, "Cache-Control": "no-cache" }, signal: ctrl.signal });
    if (res.status === 202 || res.headers.get("x-amzn-waf-action")) {
      return { status: "blocked", message: "La Commission électorale oppose un contrôle anti-robot aux serveurs de GitHub (non contourné)." };
    }
    if (!res.ok) return { status: "http", message: `La Commission électorale a répondu HTTP ${res.status}.` };
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) return { status: "empty", message: "Fichier de la Commission électorale vide." };
    return { status: "ok", text: decodeBody(buf), lastModified: res.headers.get("last-modified") };
  } catch (e) {
    return { status: "network", message: `Source injoignable : ${e.name === "AbortError" ? "délai dépassé" : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function buildSnapshot(agg, fetchedAt, lastModified) {
  const { totals, votes } = agg;
  const { seats, qualified } = allocateSeats(votes, AGREEMENTS);
  const pct = (v) => (totals.valid ? (100 * v) / totals.valid : 0);
  const parties = Object.keys(votes)
    .map((l) => ({ letters: l, ...meta(l), votes: votes[l], pct: +pct(votes[l]).toFixed(3), seats: seats[l] ?? 0, qualified: qualified.includes(l) }))
    .sort((a, b) => b.votes - a.votes);
  const progress = totals.eligible ? Math.min(100, (100 * totals.voters) / (totals.eligible * FINAL_TURNOUT)) : null;
  return {
    fetchedAt, sourceModified: lastModified ?? null, source: CEC_URL,
    totals, localities: agg.localities, countedLocalities: agg.countedLocalities,
    progress: progress == null ? null : +progress.toFixed(2),
    parties,
  };
}

async function main() {
  const now = new Date().toISOString();
  const status = await readJson("data/status.json", {});
  const history = await readJson("data/history.json", []);
  const r = await fetchCec();

  let next = { status: r.status, message: r.message ?? null };
  if (r.status === "ok") {
    try {
      const agg = aggregate(r.text);
      const { totals, votes, checks } = agg;
      const partySum = Object.values(votes).reduce((s, v) => s + v, 0);
      const gap = totals.valid ? Math.abs(partySum - totals.valid) / totals.valid : 0;
      if (!checks.validPlusInvalidMatchesVoters || !checks.votersWithinEligible || gap > TOLERANCE) {
        next = { status: "incoherent", message: `Relevé rejeté (incohérent) : Σ listes ${partySum}, valides ${totals.valid}, valides+nuls ${totals.valid + totals.invalid}, votants ${totals.voters}.` };
      } else if (totals.valid === 0) {
        next = { status: "waiting", message: "Le dépouillement n'a pas encore commencé dans le fichier officiel." };
      } else {
        const fp = createHash("sha256").update(JSON.stringify([totals, votes])).digest("hex").slice(0, 16);
        const last = history[history.length - 1];
        if (last?.fp === fp) {
          next = { status: "unchanged", message: null };
        } else {
          const snap = buildSnapshot(agg, now, r.lastModified);
          const seats = Object.fromEntries(snap.parties.map((p) => [p.id, p.seats]));
          const pcts = Object.fromEntries(snap.parties.map((p) => [p.id, p.pct]));
          history.push({ t: now, fp, valid: totals.valid, progress: snap.progress, seats, pct: pcts, regression: last ? totals.valid < last.valid : false });
          await writeJson("data/latest.json", snap);
          await writeJson("data/history.json", history);
          next = { status: "new", message: null };
        }
        next.lastOkAt = now;
      }
    } catch (e) {
      next = { status: "format", message: `Format du fichier officiel non reconnu : ${e.message}` };
    }
  }

  const changed = next.status !== status.status || next.message !== status.message || next.status === "new";
  const heartbeatDue = !status.lastWriteAt || Date.now() - Date.parse(status.lastWriteAt) > HEARTBEAT_MS;
  const out = { ...status, ...next, lastOkAt: next.lastOkAt ?? status.lastOkAt ?? null, lastCheckAt: now };
  if (changed || heartbeatDue) {
    out.lastWriteAt = now;
    await writeJson("data/status.json", out);
  }
  console.log(`[${now}] ${next.status}${next.message ? " — " + next.message : ""}`);
}

await main();
