import { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const API = "http://localhost:4000/api";

async function api(path, token, method = "GET", body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || "Request failed"), { status: res.status });
  }
  return res.status === 204 ? null : res.json();
}

const toTime = m =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function Clicker({ onPick }) {
  useMapEvents({ click: e => onPick([e.latlng.lat, e.latlng.lng]) });
  return null;
}

function AuthScreen({ onToken }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    try {
      const { token } = await api(isNew ? "/register" : "/login", null, "POST", { email, password });
      onToken(token);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div style={{ maxWidth: 320, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h2>CommuteBuddy 🚗</h2>
      <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
        style={{ width: "100%", marginBottom: 8 }} />
      <input type="password" placeholder="Password (8+ characters)" value={password}
        onChange={e => setPassword(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
      <button onClick={submit} style={{ width: "100%" }}>{isNew ? "Register" : "Log in"}</button>
      <p style={{ color: "crimson" }}>{error}</p>
      <a href="#" onClick={e => { e.preventDefault(); setIsNew(!isNew); setError(""); }}>
        {isNew ? "I already have an account" : "Create an account"}
      </a>
    </div>
  );
}

function Main({ token, onLogout }) {
  const [name, setName] = useState("");
  const [time, setTime] = useState("09:00");
  const [home, setHome] = useState(null);
  const [office, setOffice] = useState(null);
  const [mode, setMode] = useState("home");
  const [matches, setMatches] = useState(null);
  const [reqs, setReqs] = useState({ incoming: [], outgoing: [] });
  const [msg, setMsg] = useState("");

  const call = (path, method, body) =>
    api(path, token, method, body).catch(e => {
      if (e.status === 401) onLogout();
      throw e;
    });

  const safe = fn => async (...args) => {
    try { setMsg(""); await fn(...args); } catch (e) { setMsg(e.message); }
  };

  const loadRequests = () => call("/requests").then(setReqs);
  const loadMatches = () => call("/me/matches").then(setMatches);

  useEffect(() => {
    safe(async () => {
      const { profile } = await call("/me");
      if (profile) {
        setName(profile.name);
        setHome([profile.home_lat, profile.home_lng]);
        setOffice([profile.office_lat, profile.office_lng]);
        setTime(toTime(profile.depart_minutes));
        setMode("home");
      }
      await loadRequests();
    })();
  }, []);

  const pick = pos => {
    if (mode === "home") { setHome(pos); setMode("office"); }
    else { setOffice(pos); setMode("home"); }
  };

  const findMatches = safe(async () => {
    const [h, m] = time.split(":").map(Number);
    await call("/me/profile", "PUT", {
      name, home_lat: home[0], home_lng: home[1],
      office_lat: office[0], office_lng: office[1], depart_minutes: h * 60 + m,
    });
    await loadMatches();
    await loadRequests();
  });

  const sendRequest = safe(async id => {
    await call("/requests", "POST", { to_id: id });
    await loadMatches();
    await loadRequests();
  });

  const respond = safe(async (id, status) => {
    await call(`/requests/${id}`, "PATCH", { status });
    await loadRequests();
    if (matches) await loadMatches();
  });

  const ready = name && home && office;
  const card = { border: "1px solid #ccc", borderRadius: 6, padding: 8, marginBottom: 8 };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "sans-serif" }}>
      <div style={{ width: 320, padding: 16, overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>CommuteBuddy 🚗</h2>
          <button onClick={onLogout}>Log out</button>
        </div>

        <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)}
          style={{ width: "100%", margin: "12px 0 8px" }} />
        <label>Departure time</label>
        <input type="time" value={time} onChange={e => setTime(e.target.value)}
          style={{ width: "100%", marginBottom: 12 }} />
        <p>
          {!home ? "Click the map to set your HOME"
            : !office ? "Now click your OFFICE" : "Profile ready. Click the map to change it."}
        </p>
        <button disabled={!ready} onClick={findMatches} style={{ width: "100%" }}>
          Save profile and find matches
        </button>
        {msg && <p style={{ color: "crimson" }}>{msg}</p>}

        {matches && (
          <div style={{ marginTop: 16 }}>
            <h3>{matches.length} match{matches.length !== 1 && "es"}</h3>
            {matches.map(m => (
              <div key={m.id} style={card}>
                <strong>{m.name}</strong>
                <div>Home {m.homeKm.toFixed(1)} km · Office {m.officeKm.toFixed(1)} km</div>
                <div>Time gap {m.gap} min</div>
                {m.detourKm != null && (
                  <div>
                    Detour if you drive: +{m.detourKm.toFixed(1)} km
                    {" "}({m.detourSource === "road" ? "by road" : "estimate"})
                  </div>
                )}
                {!m.request && (
                  <button onClick={() => sendRequest(m.id)} style={{ marginTop: 6 }}>Request ride</button>
                )}
                {m.request && (
                  <div style={{ marginTop: 6 }}>
                    <em>{m.request.direction === "sent" ? "You requested" : "They requested you"}: {m.request.status}</em>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <h3>Requests for you</h3>
        {reqs.incoming.length === 0 && <p>None yet.</p>}
        {reqs.incoming.map(r => (
          <div key={r.id} style={card}>
            <strong>{r.name}</strong> wants to ride with you ({r.status})
            {r.status === "pending" && (
              <div style={{ marginTop: 6 }}>
                <button onClick={() => respond(r.id, "accepted")}>Accept</button>{" "}
                <button onClick={() => respond(r.id, "declined")}>Decline</button>
              </div>
            )}
          </div>
        ))}

        <h3>Your requests</h3>
        {reqs.outgoing.length === 0 && <p>None yet.</p>}
        {reqs.outgoing.map(r => (
          <div key={r.id} style={card}><strong>{r.name}</strong>: {r.status}</div>
        ))}
      </div>

      <MapContainer center={[12.95, 77.68]} zoom={12} style={{ flex: 1 }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors" />
        <Clicker onPick={pick} />
        {home && <CircleMarker center={home} radius={9} pathOptions={{ color: "green" }}><Tooltip>Your home</Tooltip></CircleMarker>}
        {office && <CircleMarker center={office} radius={9} pathOptions={{ color: "red" }}><Tooltip>Your office</Tooltip></CircleMarker>}
        {home && office && <Polyline positions={[home, office]} pathOptions={{ color: "green" }} />}
        {matches?.map(m => (
          <span key={m.id}>
            <CircleMarker center={m.home} radius={7} pathOptions={{ color: "blue" }}><Tooltip>{m.name} home</Tooltip></CircleMarker>
            <CircleMarker center={m.office} radius={7} pathOptions={{ color: "orange" }}><Tooltip>{m.name} office</Tooltip></CircleMarker>
            <Polyline positions={[m.home, m.office]} pathOptions={{ color: "blue", dashArray: "6" }} />
          </span>
        ))}
      </MapContainer>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("token"));
  const saveToken = t => { localStorage.setItem("token", t); setToken(t); };
  const logout = () => { localStorage.removeItem("token"); setToken(null); };
  return token ? <Main token={token} onLogout={logout} /> : <AuthScreen onToken={saveToken} />;
}