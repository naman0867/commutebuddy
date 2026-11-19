const people = [
  ["Ravi", 12.9279, 77.6271, 12.9750, 77.7480, 550],
  ["Meera", 12.9380, 77.6200, 12.9720, 77.7520, 545],
  ["Karthik", 12.9300, 77.6350, 12.9680, 77.7450, 560],
  ["Divya", 12.9500, 77.6100, 12.9700, 77.7510, 535],
];
(async () => {
  for (const [name, a, b, c, d, t] of people) {
    await fetch("http://localhost:4000/api/commuters", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, home_lat: a, home_lng: b, office_lat: c, office_lng: d, depart_minutes: t }),
    });
  }
  console.log("seeded");
})();