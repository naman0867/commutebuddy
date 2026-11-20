const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
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

const people = [
  ["ravi@demo.com", "Ravi", 12.9279, 77.6271, 12.9750, 77.7480, 550],
  ["meera@demo.com", "Meera", 12.9380, 77.6200, 12.9720, 77.7520, 545],
  ["karthik@demo.com", "Karthik", 12.9300, 77.6350, 12.9680, 77.7450, 560],
  ["divya@demo.com", "Divya", 12.9500, 77.6100, 12.9700, 77.7510, 535],
];

for (const [email, name, a, b, c, d, t] of people) {
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) continue;
  const u = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
    .run(email, bcrypt.hashSync("password123", 10));
  db.prepare(`INSERT INTO commuters (user_id, name, home_lat, home_lng, office_lat,
    office_lng, depart_minutes) VALUES (?,?,?,?,?,?,?)`)
    .run(u.lastInsertRowid, name, a, b, c, d, t);
}
console.log("seeded. Demo login: ravi@demo.com / password123");