import { useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const API = "http://localhost:4000/api/commuters";

function Clicker({ onPick }) {
  useMapEvents({ click: e => onPick([e.latlng.lat, e.latlng.lng]) });
  return null;
}

export default function App() {
  const [name, setName] = useState("");
  const [time, setTime] = useState("09:00");
  const [home, setHome] = useState(null);
  const [office, setOffice] = useState(null);
  const [mode, setMode] = useState("home");
  const [matches, setMatches] = useState(null);

  const pick = pos => {
    if (mode === "home") { setHome(pos); setMode("office"); }
    else { setOffice(pos); setMode("home"); }
  };

  const findMatches = async () => {
    const [h, m] = time.split(":").map(Number);
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name, home_lat: home[0], home_lng: home[1],
        office_lat: office[0], office_lng: office[1],
        depart_minutes: h * 60 + m,
      }),
    });
    const { id } = await res.json();
    setMatches(await fetch(`${API}/${id}/matches`).then(r => r.json()));
  };

  const ready = name && home && office;

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div style={{ width: 300, padding: 16, overflowY: "auto" }}>
        <h2>CommuteBuddy 🚗</h2>
        <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)}
          style={{ width: "100%", marginBottom: 8 }} />
        <label>Departure time</label>
        <input type="time" value={time} onChange={e => setTime(e.target.value)}
          style={{ width: "100%", marginBottom: 12 }} />
        <p>
          {!home ? "Click the map to set your HOME" :
           !office ? "Now click your OFFICE" : "Ready. Click the map again to reset."}
        </p>
        <button disabled={!ready} onClick={findMatches} style={{ width: "100%" }}>
          Find matches
        </button>
        <button onClick={() => { setHome(null); setOffice(null); setMatches(null); setMode("home"); }}
          style={{ width: "100%", marginTop: 6 }}>Reset</button>

        {matches && (
          <div style={{ marginTop: 16 }}>
            <h3>{matches.length} match{matches.length !== 1 && "es"}</h3>
            {matches.map(m => (
              <div key={m.id} style={{ border: "1px solid #ccc", borderRadius: 6, padding: 8, marginBottom: 8 }}>
                <strong>{m.name}</strong>
                <div>Home {m.homeKm.toFixed(1)} km away</div>
                <div>Office {m.officeKm.toFixed(1)} km away</div>
                <div>Time gap {m.gap} min</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <MapContainer center={[12.95, 77.68]} zoom={12} style={{ flex: 1 }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
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