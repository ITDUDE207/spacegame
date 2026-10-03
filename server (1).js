const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const STATIONS = {
  Steering: [['Rudder Trim', ['Left', 'Centre', 'Right']], ['Nav Lock', ['Off', 'On']], ['Star Chart', ['1', '2', '3', '4']], ['Horizon Gyro', ['Low', 'Mid', 'High']]],
  Shields: [['Aegis Field', ['Off', 'On']], ['Power Split', ['Front', 'Even', 'Rear']], ['Deflector Hue', ['Blue', 'Green', 'Red']], ['Capacitor', ['1', '2', '3', '4']]],
  Weapons: [['Flux Cannon', ['Safe', 'Armed']], ['Targeting', ['Auto', 'Manual']], ['Torpedo Bay', ['1', '2', '3', '4']], ['Laser Pitch', ['Low', 'Mid', 'High']]],
  Engines: [['Warp Core', ['Off', 'On']], ['Thrust', ['1', '2', '3', '4']], ['Coolant Pump', ['Off', 'On']], ['Gamma Thruster', ['Left', 'Centre', 'Right']]],
};
const NAMES = Object.keys(STATIONS);
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS) || 2; // run with MIN_PLAYERS=1 to test solo
const rooms = new Map();
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

function makeCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => rnd([...'ABCDEFGHJKLMNPQRSTUVWXYZ'])).join(''); } while (rooms.has(c));
  return c;
}

function newInstr(room, p) {
  const taken = room.players.filter((q) => q !== p && q.instr).map((q) => q.instr.controlId);
  let pool = room.controls.filter((c) => c.owner !== p.id && !taken.includes(c.id));
  if (!pool.length) pool = room.controls.filter((c) => !taken.includes(c.id));
  if (!pool.length) pool = room.controls;
  const c = rnd(pool);
  const option = rnd(c.options.filter((o) => o !== c.value));
  p.instr = { controlId: c.id, option, text: `Set ${c.name} to ${option}`, total: room.time, expires: Date.now() + room.time };
}

function startGame(room) {
  Object.assign(room, { phase: 'play', hull: 100, score: 0, time: 12000, controls: [], space: [], nextId: 0, dodges: 0 });
  room.players.forEach((p) => { p.stations = []; p.instr = null; });
  // Fewer than 4 players: stations are shared out so every station is always manned.
  NAMES.forEach((s, i) => {
    const owner = room.players[i % room.players.length];
    owner.stations.push(s);
    STATIONS[s].forEach(([name, options], j) =>
      room.controls.push({ id: s + j, name, station: s, owner: owner.id, options, value: rnd(options) }));
  });
  room.players.forEach((p) => newInstr(room, p));
}

function setControl(room, p, id, value) {
  const c = room.controls.find((x) => x.id === id);
  if (room.phase !== 'play' || !c || c.owner !== p.id || !c.options.includes(value)) return;
  c.value = value;
  room.players.forEach((q) => {
    if (q.instr && q.instr.controlId === c.id && q.instr.option === value) {
      room.score++;
      room.hull = Math.min(100, room.hull + 2);
      room.time = Math.max(6000, room.time - 250); // orders get shorter as you succeed
      newInstr(room, q);
    }
  });
}

function send(room) {
  const crew = room.players.map((p) => ({ name: p.name, stations: p.stations }));
  room.players.forEach((p, i) => {
    const msg = { t: 'state', code: room.code, phase: room.phase, host: i === 0, min: MIN_PLAYERS, crew, hull: Math.max(0, room.hull), score: room.score, dodges: room.dodges || 0, fx: room.fx || null };
    if (room.phase === 'play') {
      msg.controls = room.controls.filter((c) => c.owner === p.id);
      msg.instr = { text: p.instr.text, left: p.instr.expires - Date.now(), total: p.instr.total };
      if (p.stations.includes('Steering')) msg.space = room.space; // only Steering sees outside
    }
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  });
}

setInterval(() => {
  rooms.forEach((room) => {
    if (room.phase !== 'play') return;
    const now = Date.now();
    room.players.forEach((p) => {
      if (now > p.instr.expires) { room.hull -= 10; newInstr(room, p); }
    });
    // Objects drift in toward the ship: a = bearing (0 = ahead), d = distance (1 far, 0 at the hull).
    room.space.forEach((o) => { o.d -= o.v * 0.25; o.a += o.w * 0.25; });
    // A hazard that reaches the hull hits unless Steering has turned away from its side. Aegis Field halves the damage.
    const trim = room.controls.find((c) => c.name === 'Rudder Trim').value;
    const aegis = room.controls.find((c) => c.name === 'Aegis Field').value;
    room.space.forEach((o) => {
      if (!o.hz || o.d > 0.03) return;
      const dodged = o.a > 1 ? trim === 'Left' : o.a < -1 ? trim === 'Right' : trim !== 'Centre';
      if (dodged) room.dodges++;
      else { room.hull -= aegis === 'On' ? 4 : 8; room.fx = 'hit'; }
    });
    room.space = room.space.filter((o) => o.d > 0.03);
    if (room.space.length < 7 && Math.random() < 0.12) {
      // Some objects are hazards on a collision course from the front, port or starboard (max 2 at once).
      const hz = Math.random() < 0.3 && room.space.filter((o) => o.hz).length < 2;
      room.space.push({ id: ++room.nextId, hz, a: hz ? rnd([0, 1.57, -1.57]) + (Math.random() - 0.5) * 0.4 : Math.random() * Math.PI * 2, d: 1, v: hz ? 0.1 + Math.random() * 0.06 : 0.08 + Math.random() * 0.12, w: hz ? 0 : (Math.random() - 0.5) * 0.3, r: 0.7 + Math.random() * 0.7, k: Math.random() < 0.2 ? 'ship' : 'rock' });
    }
    if (room.hull <= 0) room.phase = 'over';
    send(room);
    room.fx = null;
  });
}, 250);

wss.on('connection', (ws) => {
  let room, me;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const fail = (msg) => ws.send(JSON.stringify({ t: 'error', msg }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !room) {
      const code = String(m.room || '').toUpperCase().trim();
      let r = code ? rooms.get(code) : null;
      if (code && !r) return fail('No room with that code.');
      if (!r) {
        r = { code: makeCode(), players: [], phase: 'lobby', hull: 100, score: 0, controls: [], time: 12000 };
        rooms.set(r.code, r);
      }
      if (r.players.length >= 4 || r.phase === 'play') return fail('That room is full or already flying.');
      me = { id: Math.random().toString(36).slice(2), ws, name: String(m.name || 'Crew').slice(0, 14), stations: [], instr: null };
      r.players.push(me);
      room = r;
    } else if (!room) {
      return;
    } else if (m.t === 'start' && room.players[0] === me && room.phase !== 'play' && room.players.length >= MIN_PLAYERS) {
      startGame(room);
    } else if (m.t === 'set') {
      setControl(room, me, m.id, m.value);
    }
    send(room);
  });

  ws.on('close', () => {
    if (!room) return;
    room.players = room.players.filter((p) => p !== me);
    if (!room.players.length) return rooms.delete(room.code);
    if (room.phase === 'play') room.phase = 'lobby'; // a crew member left: back to the lobby
    send(room);
  });
});

// Keep connections alive through Render's proxy.
setInterval(() => wss.clients.forEach((ws) => {
  if (!ws.isAlive) return ws.terminate();
  ws.isAlive = false;
  ws.ping();
}), 30000);

server.listen(process.env.PORT || 3000, () => console.log('Bridge Crew is listening'));
