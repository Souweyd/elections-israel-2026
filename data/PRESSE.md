# Relevés de presse (data/press.json)

Ajoutés chaque heure par une tâche programmée. Chaque point est un relevé **publié** et **daté**
des résultats partiels de la Commission électorale centrale (CEC), repris par un média.

Champs d'un point :
- `t` : heure du relevé, ISO 8601 avec fuseau d'Israël (`2026-10-28T11:30:00+02:00`)
- `prog` : avancement tel qu'énoncé par la source (« 72,4 % des bureaux »)
- `source` : `{ "label": "Média — précision", "url": "https://…" }`
- `seats` : sièges par liste, identifiants : likud, yashar, joint, ensemble, utj, dem, yb, shas, otzma, rzp, raam, noam
- `full` : `true` seulement si `seats` couvre toutes les listes et totalise 120
- facultatifs : `pct` (% des voix), `votes`, `valid` (suffrages valides)

Règles : jamais de chiffre estimé, interpolé ou déduit ; un point n'est ajouté que s'il est
postérieur au dernier point existant et que sa source est accessible publiquement.
