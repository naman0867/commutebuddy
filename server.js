const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");

const db = new Database("commute.db");
db.exec(`CREATE TABLE IF NOT EXISTS commuters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  home_lat REAL NOT NULL, home_lng REAL NOT NULL,
  office_lat REAL NOT NULL, office_lng REAL NOT NULL,
  depart_minutes INTEGER NOT NULL  -- minutes after midnight, e.g. 9:00 = 540
)`);

const app = express();
app.use(cors(), express.json());

// Haversine distance in km
function km(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = d => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

app.post("/api/commuters", (req, res) => {
  const { name, home_lat, home_lng, office_lat, office_lng, depart_minutes } = req.body;
  if (!name || [home_lat, home_lng, office_lat, office_lng, depart_minutes].some(v => typeof v !== "number"))
    return res.status(400).json({ error: "invalid input" });
  const info = db.prepare(
    "INSERT INTO commuters (name, home_lat, home_lng, office_lat, office_lng, depart_minutes) VALUES (?,?,?,?,?,?)"
  ).run(name, home_lat, home_lng, office_lat, office_lng, depart_minutes);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get("/api/commuters/:id/matches", (req, res) => {
  const me = db.prepare("SELECT * FROM commuters WHERE id = ?").get(req.params.id);
  if (!me) return res.sendStatus(404);
  const MAX_KM = 2, MAX_GAP = 30;

  const matches = db.prepare("SELECT * FROM commuters WHERE id != ?").all(me.id)
    .map(o => {
      const homeKm = km(me.home_lat, me.home_lng, o.home_lat, o.home_lng);
      const officeKm = km(me.office_lat, me.office_lng, o.office_lat, o.office_lng);
      const gap = Math.abs(me.depart_minutes - o.depart_minutes);
      // lower is better; each term normalized to roughly 0..1
      const score = homeKm / MAX_KM + officeKm / MAX_KM + gap / MAX_GAP;
   return { id: o.id, name: o.name, homeKm, officeKm, gap, score,
  home: [o.home_lat, o.home_lng], office: [o.office_lat, o.office_lng] };
    })
    .filter(m => m.homeKm <= MAX_KM && m.officeKm <= MAX_KM && m.gap <= MAX_GAP)
    .sort((a, b) => a.score - b.score);

  res.json(matches);
});

app.listen(4000, () => console.log("API on :4000"));