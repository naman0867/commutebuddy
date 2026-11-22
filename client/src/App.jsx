import { Fragment, useEffect, useState } from "react";
import {
  MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, ZoomControl, useMap, useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000/api";

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
const fmtCoord = p => `${p[0].toFixed(4)}, ${p[1].toFixed(4)}`;
const STATUS_LABEL = { pending: "Pending", accepted: "Accepted", declined: "Declined" };

function Avatar({ name }) {
  const hue = [...(name || "?")].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 360;
  return (
    <div
      className="avatar"
      style={{ background: `hsl(${hue} 60% 92%)`, color: `hsl(${hue} 55% 28%)` }}
      aria-hidden="true"
    >
      {(name || "?").trim().charAt(0).toUpperCase()}
    </div>
  );
}

function StatusBadge({ status }) {
  return <span className={`status ${status}`}>{STATUS_LABEL[status] || status}</span>;
}

function Clicker({ onPick }) {
  useMapEvents({ click: e => onPick([e.latlng.lat, e.latlng.lng]) });
  return null;
}

// Zooms the map to fit your route and all matches, leaving room for the panel.
function FitBounds({ points }) {
  const map = useMap();
  const key = JSON.stringify(points);
  useEffect(() => {
    if (!points.length) return;
    const wide = window.innerWidth > 760;
    map.fitBounds(points, wide
      ? { paddingTopLeft: [440, 60], paddingBottomRight: [60, 60], maxZoom: 14 }
      : { paddingTopLeft: [40, 60], paddingBottomRight: [40, 380], maxZoom: 14 });
  }, [key]);
  return null;
}

function AuthScreen({ onToken }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { token } = await api(isNew ? "/register" : "/login", null, "POST", { email, password });
      onToken(token);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const useDemo = () => {
    setEmail("ravi@demo.com");
    setPassword("password123");
    setIsNew(false);
    setError("");
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand"><span className="logo" aria-hidden="true" />CommuteBuddy</div>
        <h1>Share the ride to work</h1>
        <p className="muted">Find coworkers whose route and departure time match yours.</p>

        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" value={email}
          onChange={e => setEmail(e.target.value)} />

        <label htmlFor="password">Password</label>
        <input id="password" type="password" value={password}
          autoComplete={isNew ? "new-password" : "current-password"}
          placeholder="At least 8 characters"
          onChange={e => setPassword(e.target.value)} />

        {error && <p className="error" role="alert">{error}</p>}

        <button className="btn primary block" type="submit" disabled={busy}>
          {busy ? "Please wait" : isNew ? "Create account" : "Log in"}
        </button>

        <div className="auth-foot">
          <button type="button" className="link"
            onClick={() => { setIsNew(!isNew); setError(""); }}>
            {isNew ? "I already have an account" : "Create an account"}
          </button>
          <button type="button" className="link" onClick={useDemo}>Use the demo account</button>
        </div>
      </form>
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
  const [tab, setTab] = useState("rides");
  const [loading, setLoading] = useState(false);
  const [hoverId, setHoverId] = useState(null);

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
    setLoading(true);
    try {
      const [h, m] = time.split(":").map(Number);
      await call("/me/profile", "PUT", {
        name, home_lat: home[0], home_lng: home[1],
        office_lat: office[0], office_lng: office[1], depart_minutes: h * 60 + m,
      });
      await loadMatches();
      await loadRequests();
      setTab("rides");
    } finally {
      setLoading(false);
    }
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

  const ready = name.trim() && home && office;
  const pending = reqs.incoming.filter(r => r.status === "pending").length;
  const fitPoints = matches && home && office
    ? [home, office, ...matches.flatMap(m => [m.home, m.office])]
    : [];

  return (
    <div className="app">
      <MapContainer className="map" center={[12.95, 77.68]} zoom={12} zoomControl={false}>
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
          maxZoom={19}
          attribution="&copy; OpenStreetMap contributors &copy; CARTO"
        />
        <ZoomControl position="bottomright" />
        <Clicker onPick={pick} />
        <FitBounds points={fitPoints} />

        {home && office && (
          <Polyline positions={[home, office]} pathOptions={{ color: "#101828", weight: 4 }} />
        )}
        {home && (
          <CircleMarker center={home} radius={9}
            pathOptions={{ color: "#fff", weight: 3, fillColor: "#101828", fillOpacity: 1 }}>
            <Tooltip>Your home</Tooltip>
          </CircleMarker>
        )}
        {office && (
          <CircleMarker center={office} radius={9}
            pathOptions={{ color: "#fff", weight: 3, fillColor: "#2f5bff", fillOpacity: 1 }}>
            <Tooltip>Your office</Tooltip>
          </CircleMarker>
        )}

        {matches?.map(m => {
          const active = hoverId === m.id;
          return (
            <Fragment key={m.id}>
              <Polyline positions={[m.home, m.office]}
                pathOptions={{
                  color: "#2f5bff", dashArray: active ? undefined : "6 8",
                  weight: active ? 5 : 3, opacity: active ? 1 : 0.4,
                }} />
              <CircleMarker center={m.home} radius={6}
                pathOptions={{ color: "#fff", weight: 2, fillColor: "#2f5bff", fillOpacity: 1 }}>
                <Tooltip>{m.name}'s home</Tooltip>
              </CircleMarker>
              <CircleMarker center={m.office} radius={6}
                pathOptions={{ color: "#fff", weight: 2, fillColor: "#2f5bff", fillOpacity: 1 }}>
                <Tooltip>{m.name}'s office</Tooltip>
              </CircleMarker>
            </Fragment>
          );
        })}
      </MapContainer>

      {matches && (
        <div className="legend">
          <div><span className="swatch" />Your route</div>
          <div><span className="swatch dashed" />Other commuters</div>
        </div>
      )}

      <aside className="panel">
        <div className="panel-head">
          <div className="brand"><span className="logo" aria-hidden="true" />CommuteBuddy</div>
          <button className="btn ghost small" onClick={onLogout}>Log out</button>
        </div>

        <div className="planner">
          <div className="stops">
            <button type="button" className={`stop ${mode === "home" ? "active" : ""}`}
              onClick={() => setMode("home")}>
              <span className="dot from" />
              <span className="stop-text">
                <strong>{home ? "Home" : "Set your home"}</strong>
                <span>{home ? fmtCoord(home) : "Click the map to drop a pin"}</span>
              </span>
            </button>
            <button type="button" className={`stop ${mode === "office" ? "active" : ""}`}
              onClick={() => setMode("office")}>
              <span className="dot to" />
              <span className="stop-text">
                <strong>{office ? "Office" : "Set your office"}</strong>
                <span>{office ? fmtCoord(office) : "Click the map to drop a pin"}</span>
              </span>
            </button>
          </div>

          <div className="fields">
            <input aria-label="Your name" placeholder="Your name" value={name}
              onChange={e => setName(e.target.value)} />
            <input aria-label="Departure time" type="time" value={time}
              onChange={e => setTime(e.target.value)} />
          </div>

          <button className="btn primary block" disabled={!ready || loading} onClick={findMatches}>
            {loading ? "Finding rides" : "Find rides"}
          </button>
          {msg && <p className="error" role="alert">{msg}</p>}
        </div>

        <div className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={tab === "rides"}
            onClick={() => setTab("rides")}>Rides</button>
          <button className="tab" role="tab" aria-selected={tab === "requests"}
            onClick={() => setTab("requests")}>
            Requests{pending > 0 && <span className="count">{pending}</span>}
          </button>
        </div>

        <div className="list">
          {tab === "rides" && (
            <>
              {!matches && (
                <div className="empty">
                  <strong>Where are you headed?</strong>
                  Pin your home and office, pick a departure time, then find rides.
                </div>
              )}
              {matches && matches.length === 0 && (
                <div className="empty">
                  <strong>No rides match yet</strong>
                  Try a different departure time, or move your pins closer to other commuters.
                </div>
              )}
              {matches?.map(m => (
                <article key={m.id} className="ride"
                  onMouseEnter={() => setHoverId(m.id)} onMouseLeave={() => setHoverId(null)}>
                  <div className="ride-top">
                    <Avatar name={m.name} />
                    <div className="ride-who">
                      <strong>{m.name}</strong>
                      <span className="muted">
                        {m.gap === 0 ? "Departs at the same time as you" : `Departs ${m.gap} min before or after you`}
                      </span>
                    </div>
                    {m.detourKm != null && <span className="chip">+{m.detourKm.toFixed(1)} km detour</span>}
                  </div>
                  <ul className="facts">
                    <li>{m.homeKm.toFixed(1)} km from your home</li>
                    <li>{m.officeKm.toFixed(1)} km from your office</li>
                    {m.detourKm != null && (
                      <li>{m.detourSource === "road" ? "Detour measured by road" : "Detour is an estimate"}</li>
                    )}
                  </ul>
                  <div className="ride-actions">
                    {!m.request && (
                      <button className="btn accent small" onClick={() => sendRequest(m.id)}>
                        Request ride
                      </button>
                    )}
                    {m.request && (
                      <>
                        <StatusBadge status={m.request.status} />
                        <span className="muted">
                          {m.request.direction === "sent" ? "You requested" : "They requested you"}
                        </span>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </>
          )}

          {tab === "requests" && (
            <>
              <h3 className="section-title">Requests for you</h3>
              {reqs.incoming.length === 0 && (
                <div className="empty">
                  <strong>Nothing waiting</strong>
                  When someone asks to ride with you, it shows up here.
                </div>
              )}
              {reqs.incoming.map(r => (
                <article key={r.id} className="ride">
                  <div className="ride-top">
                    <Avatar name={r.name} />
                    <div className="ride-who">
                      <strong>{r.name}</strong>
                      <span className="muted">wants to ride with you</span>
                    </div>
                    {r.status !== "pending" && <StatusBadge status={r.status} />}
                  </div>
                  {r.status === "pending" && (
                    <div className="ride-actions" style={{ marginTop: 12 }}>
                      <button className="btn primary small" onClick={() => respond(r.id, "accepted")}>
                        Accept
                      </button>
                      <button className="btn ghost small" onClick={() => respond(r.id, "declined")}>
                        Decline
                      </button>
                    </div>
                  )}
                </article>
              ))}

              <h3 className="section-title">Your requests</h3>
              {reqs.outgoing.length === 0 && (
                <div className="empty">
                  <strong>No requests sent</strong>
                  Request a ride from the Rides tab.
                </div>
              )}
              {reqs.outgoing.map(r => (
                <article key={r.id} className="ride">
                  <div className="ride-top">
                    <Avatar name={r.name} />
                    <div className="ride-who"><strong>{r.name}</strong></div>
                    <StatusBadge status={r.status} />
                  </div>
                </article>
              ))}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("token"));
  const saveToken = t => { localStorage.setItem("token", t); setToken(t); };
  const logout = () => { localStorage.removeItem("token"); setToken(null); };
  return token ? <Main token={token} onLogout={logout} /> : <AuthScreen onToken={saveToken} />;
}