process.env.DB_PATH = ":memory:";
const request = require("supertest");
const { app } = require("./server");

const PW = "password123";
const authHeader = t => ({ Authorization: `Bearer ${t}` });
const prof = (name, hLat, hLng, oLat, oLng, depart) => ({
  name, home_lat: hLat, home_lng: hLng, office_lat: oLat, office_lng: oLng, depart_minutes: depart,
});
const signup = async email =>
  (await request(app).post("/api/register").send({ email, password: PW })).body.token;
const save = (t, p) => request(app).put("/api/me/profile").set(authHeader(t)).send(p);

describe("auth", () => {
  test("rejects an invalid email", async () => {
    const res = await request(app).post("/api/register").send({ email: "nope", password: PW });
    expect(res.status).toBe(400);
  });

  test("rejects a short password", async () => {
    const res = await request(app).post("/api/register").send({ email: "a@test.com", password: "short" });
    expect(res.status).toBe(400);
  });

  test("blocks duplicate emails", async () => {
    const first = await request(app).post("/api/register").send({ email: "dup@test.com", password: PW });
    const second = await request(app).post("/api/register").send({ email: "dup@test.com", password: PW });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  test("login fails with a wrong password and works with the right one", async () => {
    await signup("login@test.com");
    const bad = await request(app).post("/api/login").send({ email: "login@test.com", password: "wrongpass1" });
    const good = await request(app).post("/api/login").send({ email: "login@test.com", password: PW });
    expect(bad.status).toBe(401);
    expect(good.status).toBe(200);
    expect(good.body.token).toBeTruthy();
  });

  test("protected routes need a token", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(401);
  });
});

describe("profile validation", () => {
  let t;
  beforeAll(async () => { t = await signup("profile@test.com"); });

  test("rejects latitude out of range", async () => {
    expect((await save(t, prof("A", 200, 77.6, 12.97, 77.75, 540))).status).toBe(400);
  });
  test("rejects an invalid departure time", async () => {
    expect((await save(t, prof("A", 12.93, 77.6, 12.97, 77.75, 1500))).status).toBe(400);
  });
  test("rejects an empty name", async () => {
    expect((await save(t, prof("   ", 12.93, 77.6, 12.97, 77.75, 540))).status).toBe(400);
  });
  test("accepts a valid profile", async () => {
    expect((await save(t, prof("Asha", 12.93, 77.6, 12.97, 77.75, 540))).status).toBe(200);
  });
});

describe("matching", () => {
  let a;
  beforeAll(async () => {
    a = await signup("a@test.com");
    const b = await signup("b@test.com");
    const far = await signup("far@test.com");
    const late = await signup("late@test.com");
    await save(a, prof("Asha", 12.9352, 77.6245, 12.9698, 77.7500, 540));
    await save(b, prof("Ravi", 12.9279, 77.6271, 12.9750, 77.7480, 550));
    await save(far, prof("Far", 13.1500, 77.6245, 12.9698, 77.7500, 540)); // home too far
    await save(late, prof("Late", 12.9300, 77.6250, 12.9700, 77.7500, 720)); // 3 hours later
  });

  test("returns only nearby commuters with a close departure time", async () => {
    const res = await request(app).get("/api/me/matches").set(authHeader(a));
    expect(res.status).toBe(200);
    expect(res.body.map(m => m.name)).toEqual(["Ravi"]);
  });

  test("includes a non-negative detour", async () => {
    const res = await request(app).get("/api/me/matches").set(authHeader(a));
    expect(res.body[0].detourKm).toBeGreaterThanOrEqual(0);
    expect(res.body[0].detourSource).toBe("estimate"); // OSRM is off in tests
  });

  test("requires a saved profile", async () => {
    const t = await signup("noprofile@test.com");
    const res = await request(app).get("/api/me/matches").set(authHeader(t));
    expect(res.status).toBe(400);
  });
});

describe("ride requests", () => {
  let x, y, z, yId;
  const incomingId = async () =>
    (await request(app).get("/api/requests").set(authHeader(y))).body.incoming[0].id;

  beforeAll(async () => {
    x = await signup("x@test.com");
    y = await signup("y@test.com");
    z = await signup("z@test.com");
    await save(x, prof("X", 12.9352, 77.6245, 12.9698, 77.7500, 540));
    await save(y, prof("Y", 12.9279, 77.6271, 12.9750, 77.7480, 545));
    await save(z, prof("Z", 12.9300, 77.6300, 12.9700, 77.7500, 541));
    const m = await request(app).get("/api/me/matches").set(authHeader(x));
    yId = m.body.find(c => c.name === "Y").id;
  });

  test("a commuter can send a request", async () => {
    const res = await request(app).post("/api/requests").set(authHeader(x)).send({ to_id: yId });
    expect(res.status).toBe(201);
  });

  test("duplicate requests are blocked", async () => {
    const res = await request(app).post("/api/requests").set(authHeader(x)).send({ to_id: yId });
    expect(res.status).toBe(409);
  });

  test("the sender cannot accept their own request", async () => {
    const id = await incomingId();
    const res = await request(app).patch(`/api/requests/${id}`).set(authHeader(x)).send({ status: "accepted" });
    expect(res.status).toBe(404);
  });

  test("a third user cannot accept someone else's request", async () => {
    const id = await incomingId();
    const res = await request(app).patch(`/api/requests/${id}`).set(authHeader(z)).send({ status: "accepted" });
    expect(res.status).toBe(404);
  });

  test("the recipient can accept", async () => {
    const id = await incomingId();
    const res = await request(app).patch(`/api/requests/${id}`).set(authHeader(y)).send({ status: "accepted" });
    expect(res.status).toBe(204);
    const list = await request(app).get("/api/requests").set(authHeader(y));
    expect(list.body.incoming[0].status).toBe("accepted");
  });
});