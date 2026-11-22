const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET)
  throw new Error("JWT_SECRET is required in production");

const isTest = process.env.NODE_ENV === "test";
const db = new Database(process.env.DB_PATH || "commute.db");

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
app.set("trust proxy", 1); // Render sits behind a proxy; rate limiting needs the real client IP
app.use(
  cors({ origin: process.env.FRONTEND_URL || true }),
  express.json({ limit: "10kb" })
);

// ---------- Rate limiting (off in tests) ----------
const passThrough = (req, res, next) => next();
const makeLimiter = (windowMs, limit, message) =>
  isTest
    ? passThrough
    : rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error: message } });

const authLimiter = makeLimiter(15 * 60 * 1000, 20, "too many attempts, try again in 15 minutes");
const apiLimiter = makeLimiter(60 * 1000, 120, "too many requests, slow down");
app.use("/api", apiLimiter);

// ---------- Validation helpers ----------
const isNum = v => typeof v === "number" && Number.isFinite(v);
const validLat = v => isNum(v) && v >= -90 && v <= 90;
const validLng = v => isNum(v) && v >= -180 && v <= 180;
const validEmail = e =>
  typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const sign = id => jwt.sign({ id }, SECRET, { expiresIn: "7d" });

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  try { req.userId = jwt.verify(token, SECRET).id; next(); }
  catch { res.status(401).json({ error: "please log in" }); }
}

// ---------- Distance helpers ----------
function km(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = d => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function straightKm(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += km(...points[i], ...points[i + 1]);
  return total;
}

// Real driving distance through all points, via the public OSRM demo server.
// Returns null on any failure so callers can fall back to straight-line estimates.
const roadCache = new Map();
async function roadKm(points) {
  if (isTest || process.env.USE_OSRM === "false") return null;
  const key = points.map(p => p.map(n => n.toFixed(4)).join(",")).join(";");
  if (roadCache.has(key)) return roadCache.get(key);
  try {
    const coords = points.map(([lat, lng]) => `${lng},${lat}`).join(";"); // OSRM wants lng,lat
    const r = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`,
      { signal: AbortSignal.timeout(4000) }
    );
    const data = await r.json();
    const meters = data.routes && data.routes[0] && data.routes[0].distance;
    if (typeof meters === "number") {
      roadCache.set(key, meters / 1000);
      return meters / 1000;
    }
  } catch { /* fall through */ }
  return null;
}

async function pathKm(points) {
  const road = await roadKm(points);
  return road !== null
    ? { km: road, source: "road" }
    : { km: straightKm(points), source: "estimate" };
}

const myCommuter = uid => db.prepare("SELECT * FROM commuters WHERE user_id = ?").get(uid);

// ---------- Auth ----------
app.post("/api/register", authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!validEmail(email)) return res.status(400).json({ error: "enter a valid email" });
  if (typeof password !== "string" || password.length < 8 || password.length > 72)
    return res.status(400).json({ error: "password must be 8 to 72 characters" });
  try {
    const info = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(email.toLowerCase(), bcrypt.hashSync(password, 10));
    res.status(201).json({ token: sign(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: "email already registered" });
  }
});

app.post("/api/login", authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const user = typeof email === "string"
    ? db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase())
    : null;
  if (!user || typeof password !== "string" || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: "invalid email or password" });
  res.json({ token: sign(user.id) });
});

// ---------- Profile ----------
app.get("/api/me", auth, (req, res) => res.json({ profile: myCommuter(req.userId) || null }));

app.put("/api/me/profile", auth, (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 1 || name.length > 60)
    return res.status(400).json({ error: "name must be 1 to 60 characters" });
  if (!validLat(b.home_lat) || !validLat(b.office_lat) || !validLng(b.home_lng) || !validLng(b.office_lng))
    return res.status(400).json({ error: "invalid coordinates" });
  if (!Number.isInteger(b.depart_minutes) || b.depart_minutes < 0 || b.depart_minutes >= 1440)
    return res.status(400).json({ error: "invalid departure time" });

  if (myCommuter(req.userId)) {
    db.prepare(`UPDATE commuters SET name=?, home_lat=?, home_lng=?, office_lat=?,
      office_lng=?, depart_minutes=? WHERE user_id=?`)
      .run(name, b.home_lat, b.home_lng, b.office_lat, b.office_lng, b.depart_minutes, req.userId);
  } else {
    db.prepare(`INSERT INTO commuters (user_id, name, home_lat, home_lng, office_lat,
      office_lng, depart_minutes) VALUES (?,?,?,?,?,?,?)`)
      .run(req.userId, name, b.home_lat, b.home_lng, b.office_lat, b.office_lng, b.depart_minutes);
  }
  res.json(myCommuter(req.userId));
});

// ---------- Matches (detour-cost ranking) ----------
const MAX_KM = 2, MAX_GAP = 30, MAX_DETOUR = 5, MAX_CANDIDATES = 8;

app.get("/api/me/matches", auth, async (req, res) => {
  try {
    const me = myCommuter(req.userId);
    if (!me) return res.status(400).json({ error: "save your profile first" });
    const reqs = db.prepare("SELECT * FROM requests WHERE from_id = ? OR to_id = ?").all(me.id, me.id);

    // Step 1: cheap straight-line filter keeps road-routing calls to a handful
    const candidates = db.prepare("SELECT * FROM commuters WHERE id != ?").all(me.id)
      .map(o => ({
        o,
        homeKm: km(me.home_lat, me.home_lng, o.home_lat, o.home_lng),
        officeKm: km(me.office_lat, me.office_lng, o.office_lat, o.office_lng),
        gap: Math.abs(me.depart_minutes - o.depart_minutes),
      }))
      .filter(c => c.homeKm <= MAX_KM && c.officeKm <= MAX_KM && c.gap <= MAX_GAP)
      .sort((a, b) => (a.homeKm + a.officeKm) - (b.homeKm + b.officeKm))
      .slice(0, MAX_CANDIDATES);

    // Step 2: detour = extra distance if YOU drive and pick them up
    const myHome = [me.home_lat, me.home_lng], myOffice = [me.office_lat, me.office_lng];
    const direct = await pathKm([myHome, myOffice]);

    const matches = await Promise.all(candidates.map(async ({ o, homeKm, officeKm, gap }) => {
      const theirHome = [o.home_lat, o.home_lng], theirOffice = [o.office_lat, o.office_lng];
      const viaPoints = [myHome, theirHome, theirOffice, myOffice];
      const via = await pathKm(viaPoints);

      let detourKm, source;
      if (via.source === direct.source) {
        detourKm = via.km - direct.km;
        source = via.source;
      } else { // mixed sources would give nonsense, so compare like with like
        detourKm = straightKm(viaPoints) - straightKm([myHome, myOffice]);
        source = "estimate";
      }
      detourKm = Math.max(0, detourKm);

      const score = detourKm / MAX_DETOUR + gap / MAX_GAP; // lower is better
      const r = reqs.find(r =>
        (r.from_id === me.id && r.to_id === o.id) || (r.from_id === o.id && r.to_id === me.id));
      return {
        id: o.id, name: o.name, homeKm, officeKm, gap, detourKm, detourSource: source, score,
        home: theirHome, office: theirOffice,
        request: r ? { id: r.id, status: r.status, direction: r.from_id === me.id ? "sent" : "received" } : null,
      };
    }));

    res.json(matches.sort((a, b) => a.score - b.score));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "something went wrong" });
  }
});

// ---------- Ride requests ----------
app.post("/api/requests", auth, (req, res) => {
  const me = myCommuter(req.userId);
  if (!me) return res.status(400).json({ error: "save your profile first" });
  const toId = Number((req.body || {}).to_id);
  if (!Number.isInteger(toId) || toId === me.id) return res.status(400).json({ error: "invalid request" });
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
  const { status } = req.body || {};
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

// ---------- Health check and demo data ----------
app.get("/api/health", (req, res) => res.json({ ok: true }));

function seedDemo() {
  const people = [
    ["ravi@demo.com", "Ravi", 12.9279, 77.6271, 12.9750, 77.7480, 550],
    ["meera@demo.com", "Meera", 12.9380, 77.6200, 12.9720, 77.7520, 545],
    ["karthik@demo.com", "Karthik", 12.9300, 77.6350, 12.9680, 77.7450, 560],
    ["divya@demo.com", "Divya", 12.9500, 77.6100, 12.9700, 77.7510, 535],
    ["arjun@demo.com", "Arjun", 12.9340, 77.6260, 12.9780, 77.6400, 540],
    ["sneha@demo.com", "Sneha", 12.9370, 77.6210, 12.9800, 77.6430, 550],
    ["vikram@demo.com", "Vikram", 12.9310, 77.6280, 12.9760, 77.6380, 535],
  ];
  for (const [email, name, a, b, c, d, t] of people) {
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) continue;
    const u = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(email, bcrypt.hashSync("password123", 10));
    db.prepare(`INSERT INTO commuters (user_id, name, home_lat, home_lng, office_lat,
      office_lng, depart_minutes) VALUES (?,?,?,?,?,?,?)`)
      .run(u.lastInsertRowid, name, a, b, c, d, t);
  }
  console.log("demo data ready");
}
if (process.env.SEED_DEMO === "true") seedDemo();

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`API on :${PORT}`));
}
module.exports = { app, db };