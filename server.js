const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const db = new Database("commute.db");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commuters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  home_lat REAL NOT NULL, home_lng REAL NOT NULL,
  office_lat REAL NOT NULL, office_lng REAL NOT NULL,
  depart_minutes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(from_id, to_id)
);
`);

const app = express();
app.use(cors(), express.json());

const sign = id => jwt.sign({ id }, SECRET, { expiresIn: "7d" });

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  try { req.userId = jwt.verify(token, SECRET).id; next(); }
  catch { res.status(401).json({ error: "please log in" }); }
}

function km(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = d => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const myCommuter = uid => db.prepare("SELECT * FROM commuters WHERE user_id = ?").get(uid);

// ---------- Auth ----------
app.post("/api/register", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 8)
    return res.status(400).json({ error: "email and 8+ character password required" });
  try {
    const info = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(email.toLowerCase(), bcrypt.hashSync(password, 10));
    res.status(201).json({ token: sign(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: "email already registered" });
  }
});

app.post("/api/login", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE email = ?")
    .get((req.body.email || "").toLowerCase());
  if (!user || !bcrypt.compareSync(req.body.password || "", user.password_hash))
    return res.status(401).json({ error: "invalid email or password" });
  res.json({ token: sign(user.id) });
});

// ---------- Profile ----------
app.get("/api/me", auth, (req, res) => res.json({ profile: myCommuter(req.userId) || null }));

app.put("/api/me/profile", auth, (req, res) => {
  const { name, home_lat, home_lng, office_lat, office_lng, depart_minutes } = req.body;
  const nums = [home_lat, home_lng, office_lat, office_lng, depart_minutes];
  if (!name || nums.some(v => typeof v !== "number" || !isFinite(v)))
    return res.status(400).json({ error: "invalid profile" });
  if (depart_minutes < 0 || depart_minutes >= 1440)
    return res.status(400).json({ error: "invalid departure time" });

  if (myCommuter(req.userId)) {
    db.prepare(`UPDATE commuters SET name=?, home_lat=?, home_lng=?, office_lat=?,
      office_lng=?, depart_minutes=? WHERE user_id=?`)
      .run(name, home_lat, home_lng, office_lat, office_lng, depart_minutes, req.userId);
  } else {
    db.prepare(`INSERT INTO commuters (user_id, name, home_lat, home_lng, office_lat,
      office_lng, depart_minutes) VALUES (?,?,?,?,?,?,?)`)
      .run(req.userId, name, home_lat, home_lng, office_lat, office_lng, depart_minutes);
  }
  res.json(myCommuter(req.userId));
});

// ---------- Matches ----------
app.get("/api/me/matches", auth, (req, res) => {
  const me = myCommuter(req.userId);
  if (!me) return res.status(400).json({ error: "save your profile first" });
  const MAX_KM = 2, MAX_GAP = 30;
  const reqs = db.prepare("SELECT * FROM requests WHERE from_id = ? OR to_id = ?").all(me.id, me.id);

  const matches = db.prepare("SELECT * FROM commuters WHERE id != ?").all(me.id)
    .map(o => {
      const homeKm = km(me.home_lat, me.home_lng, o.home_lat, o.home_lng);
      const officeKm = km(me.office_lat, me.office_lng, o.office_lat, o.office_lng);
      const gap = Math.abs(me.depart_minutes - o.depart_minutes);
      const score = homeKm / MAX_KM + officeKm / MAX_KM + gap / MAX_GAP;
      const r = reqs.find(r =>
        (r.from_id === me.id && r.to_id === o.id) || (r.from_id === o.id && r.to_id === me.id));
      return {
        id: o.id, name: o.name, homeKm, officeKm, gap, score,
        home: [o.home_lat, o.home_lng], office: [o.office_lat, o.office_lng],
        request: r ? { id: r.id, status: r.status, direction: r.from_id === me.id ? "sent" : "received" } : null,
      };
    })
    .filter(m => m.homeKm <= MAX_KM && m.officeKm <= MAX_KM && m.gap <= MAX_GAP)
    .sort((a, b) => a.score - b.score);

  res.json(matches);
});

// ---------- Ride requests ----------
app.post("/api/requests", auth, (req, res) => {
  const me = myCommuter(req.userId);
  if (!me) return res.status(400).json({ error: "save your profile first" });
  const toId = Number(req.body.to_id);
  if (!toId || toId === me.id) return res.status(400).json({ error: "invalid request" });
  if (!db.prepare("SELECT 1 FROM commuters WHERE id = ?").get(toId))
    return res.status(404).json({ error: "commuter not found" });
  const existing = db.prepare(
    "SELECT 1 FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)"
  ).get(me.id, toId, toId, me.id);
  if (existing) return res.status(409).json({ error: "request already exists" });
  const info = db.prepare("INSERT INTO requests (from_id, to_id) VALUES (?, ?)").run(me.id, toId);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get("/api/requests", auth, (req, res) => {
  const me = myCommuter(req.userId);
  if (!me) return res.json({ incoming: [], outgoing: [] });
  const incoming = db.prepare(`SELECT r.id, r.status, c.name FROM requests r
    JOIN commuters c ON c.id = r.from_id WHERE r.to_id = ? ORDER BY r.id DESC`).all(me.id);
  const outgoing = db.prepare(`SELECT r.id, r.status, c.name FROM requests r
    JOIN commuters c ON c.id = r.to_id WHERE r.from_id = ? ORDER BY r.id DESC`).all(me.id);
  res.json({ incoming, outgoing });
});

app.patch("/api/requests/:id", auth, (req, res) => {
  const { status } = req.body;
  if (!["accepted", "declined"].includes(status))
    return res.status(400).json({ error: "status must be accepted or declined" });
  const me = myCommuter(req.userId);
  if (!me) return res.status(400).json({ error: "save your profile first" });
  // Only the RECIPIENT can respond, and only while it's still pending
  const info = db.prepare(
    "UPDATE requests SET status = ? WHERE id = ? AND to_id = ? AND status = 'pending'"
  ).run(status, req.params.id, me.id);
  if (info.changes === 0) return res.status(404).json({ error: "request not found" });
  res.sendStatus(204);
});

app.listen(4000, () => console.log("API on :4000"));