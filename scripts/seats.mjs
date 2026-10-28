// Répartition des 120 sièges — Loi sur les élections à la Knesset, art. 81-81A
// (méthode Bader-Ofer, variante de D'Hondt), seuil de 3,25 % des suffrages valides,
// avec prise en compte des accords d'excédents de voix.
//
// ATTENTION : appliquée à des voix PARTIELLES, cette répartition est une PROJECTION.
// Elle ne vaut attribution officielle qu'appliquée aux résultats définitifs publiés
// par la CEC.

export const TOTAL_SEATS = 120;
export const THRESHOLD = 0.0325;

/** Répartit `seats` sièges entre des entités {id, votes} par plus forte moyenne. */
function largestAverage(entities, seats) {
  const totalVotes = entities.reduce((s, e) => s + e.votes, 0);
  const result = Object.fromEntries(entities.map((e) => [e.id, 0]));
  if (totalVotes === 0 || seats === 0) return result;
  const quota = totalVotes / seats;
  let given = 0;
  for (const e of entities) {
    result[e.id] = Math.floor(e.votes / quota);
    given += result[e.id];
  }
  while (given < seats) {
    let best = null;
    let bestAvg = -1;
    for (const e of entities) {
      const avg = e.votes / (result[e.id] + 1);
      // départage déterministe : plus grand nombre de voix, puis ordre des lettres
      if (avg > bestAvg || (avg === bestAvg && best && e.votes > best.votes)) {
        bestAvg = avg;
        best = e;
      }
    }
    result[best.id] += 1;
    given += 1;
  }
  return result;
}

/**
 * @param {Record<string, number>} votes  voix par lettres de liste
 * @param {string[][]} agreements          paires d'accords d'excédents
 * @returns {{seats: Record<string, number>, qualified: string[], thresholdVotes: number}}
 */
export function allocateSeats(votes, agreements = []) {
  const valid = Object.values(votes).reduce((s, v) => s + v, 0);
  const thresholdVotes = valid * THRESHOLD;
  const qualified = Object.keys(votes).filter((k) => votes[k] >= thresholdVotes && votes[k] > 0);
  const seats = Object.fromEntries(Object.keys(votes).map((k) => [k, 0]));
  if (qualified.length === 0) return { seats, qualified, thresholdVotes };

  const qSet = new Set(qualified);
  const qualifiedVotes = qualified.reduce((s, k) => s + votes[k], 0);
  const quota = qualifiedVotes / TOTAL_SEATS;

  // 1) sièges entiers au quotient général
  let given = 0;
  for (const k of qualified) {
    seats[k] = Math.floor(votes[k] / quota);
    given += seats[k];
  }

  // 2) entités pour les restes : une paire d'accord compte comme une seule liste
  //    si les DEUX listes ont franchi le seuil.
  const pairOf = {};
  for (const [a, b] of agreements) {
    if (qSet.has(a) && qSet.has(b)) {
      pairOf[a] = `${a}+${b}`;
      pairOf[b] = `${a}+${b}`;
    }
  }
  const entities = {};
  for (const k of qualified) {
    const id = pairOf[k] || k;
    entities[id] ??= { id, votes: 0, seats: 0, members: [] };
    entities[id].votes += votes[k];
    entities[id].seats += seats[k];
    entities[id].members.push(k);
  }
  const ents = Object.values(entities);
  while (given < TOTAL_SEATS) {
    let best = null;
    let bestAvg = -1;
    for (const e of ents) {
      const avg = e.votes / (e.seats + 1);
      if (avg > bestAvg || (avg === bestAvg && e.votes > best.votes)) {
        bestAvg = avg;
        best = e;
      }
    }
    best.seats += 1;
    given += 1;
  }

  // 3) au sein de chaque paire, nouvelle répartition des sièges de la paire
  for (const e of ents) {
    if (e.members.length === 1) {
      seats[e.members[0]] = e.seats;
    } else {
      const split = largestAverage(
        e.members.map((m) => ({ id: m, votes: votes[m] })),
        e.seats,
      );
      for (const m of e.members) seats[m] = split[m];
    }
  }
  return { seats, qualified, thresholdVotes };
}
