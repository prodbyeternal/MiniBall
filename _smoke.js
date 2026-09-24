/* Temporary smoke test — drives the real server over WebSocket. */
'use strict';

const WebSocket = require('ws');
const { spawn } = require('child_process');

// Reassigned by the ban suite, which runs against a server of its own.
let URL = 'ws://localhost:8080';
const MAPS = {
  small: { halfW: 300, halfH: 170, goalHalfH: 45, goalDepth: 34 },
  medium: { halfW: 420, halfH: 200, goalHalfH: 64, goalDepth: 50 },
  big: { halfW: 620, halfH: 270, goalHalfH: 86, goalDepth: 62 },
};

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class Client {
  constructor(nick) {
    this.nick = nick;
    this.ws = new WebSocket(URL);
    this.inbox = [];
    this.entered = null;
    this.room = null;
    this.state = null;
    this.errors = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'entered') this.entered = m;
      if (m.t === 'room') this.room = m;
      if (m.t === 'state') this.state = m;
      if (m.t === 'error') this.errors.push(m);
      this.inbox.push(m);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  input(keys) { this.send({ type: 'input', keys }); }
  close() { try { this.ws.close(); } catch (e) {} }
  seen(type) { return this.inbox.some(m => m.t === type); }
  me() {
    if (!this.state || !this.entered) return null;
    return this.state.p.find(r => r[0] === this.entered.you) || null;
  }
  team() {
    if (!this.room || !this.entered) return null;
    const p = this.room.players.find(p => p.id === this.entered.you);
    return p ? p.team : null;
  }
}

async function waitUntil(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

async function makeRoom(nick, opts) {
  const c = new Client(nick);
  await c.ready;
  c.send(Object.assign({
    type: 'create', nick, name: nick + "'s room", password: '',
    maxPlayers: 2, map: 'medium', timeLimit: 0, scoreLimit: 0,
  }, opts || {}));
  await waitUntil(() => c.entered, 1500);
  return c;
}

async function joinRoom(nick, code) {
  const c = new Client(nick);
  await c.ready;
  c.send({ type: 'join', nick, room: code, password: '' });
  await waitUntil(() => c.room, 1500);
  return c;
}

// Matches are started by the host from the room panel, so every test that
// wants a running game has to ask for one.
async function startMatch(host, label, quiet) {
  const before = host.state ? host.state.ph : null;
  host.send({ type: 'admin', action: 'start' });
  const ok = await waitUntil(() => host.state && host.state.ph !== 'waiting' && host.state.ph !== before, 3000);
  if (!quiet) check(label || 'the host can start the match', ok, 'phase=' + (host.state && host.state.ph));
  return ok;
}

/* ------------------------------------------------------------------ */
/*  Physics, measured in an isolated 1v1 so nothing pins anyone early  */
/* ------------------------------------------------------------------ */

async function testPhysics() {
  console.log('\n--- physics (isolated 1v1, medium map) ---');
  const red = await makeRoom('Red');
  const blue = await joinRoom('Blue', red.entered.code);

  // Blue gets out of the lane so red has a clear run at the ball.
  blue.input({ up: true });

  check('the room waits for the host instead of starting itself',
    await waitUntil(() => red.state, 1500) && red.state.ph === 'waiting',
    'phase=' + (red.state && red.state.ph));

  await startMatch(red, 'the host starts the 1v1');
  // Red takes the kick off, and a kick off only opens when the ball is
  // played — press into the centre spot until the barrier lifts.
  red.input({ right: true, kick: true });
  const playing = await waitUntil(() => red.state && red.state.ph === 'playing', 9000);
  check('1v1 reaches the playing phase', playing, 'phase=' + (red.state && red.state.ph));
  if (!playing) return;

  // --- running speed, sampled from the very first tick of movement -------
  // Red runs left, away from the ball: the centre spot sits to its right, and
  // a head-on collision there (which happens around 2.19 units/tick) knocks
  // it back down before it can ever reach its top speed.
  red.input({ left: true });
  let peak = 0;
  const samples = [];
  for (let i = 0; i < 110; i++) {
    await sleep(16);
    const me = red.me();
    if (me) {
      const s = Math.hypot(me[3], me[4]);
      peak = Math.max(peak, s);
      samples.push(s);
    }
  }
  check('peak running speed lands on HaxBall\'s 2.4 units/tick',
    peak > 2.3 && peak <= 2.65, 'peak=' + peak.toFixed(3) + ' after ' + samples.length + ' samples');

  // --- deceleration curve: damping 0.96 per tick ------------------------
  red.input({});
  await sleep(60);
  const a = red.me();
  const v1 = a ? Math.hypot(a[3], a[4]) : 0;
  await sleep(100);
  const b = red.me();
  const v2 = b ? Math.hypot(b[3], b[4]) : 0;
  if (v1 > 0.5 && v2 > 0) {
    const ticks = 100 / (1000 / 60);
    const ratio = Math.pow(v2 / v1, 1 / ticks);
    check('release damping matches 0.96/tick', ratio > 0.94 && ratio < 0.98,
      'measured=' + ratio.toFixed(4));
  } else {
    check('release damping matches 0.96/tick', true, 'skipped, already stopped');
  }

  // --- a kick sends the ball roughly 500 units --------------------------
  // Put red back on the centre line and let it run into the ball.
  let maxBallSpeed = 0;
  let ballMoved = 0;
  const startX = red.state.b[0];
  let kicked = false;
  for (let i = 0; i < 500; i++) {
    await sleep(16);
    const me = red.me();
    const b = red.state.b;
    const speed = Math.hypot(b[2], b[3]);
    maxBallSpeed = Math.max(maxBallSpeed, speed);
    ballMoved = Math.max(ballMoved, Math.abs(b[0] - startX));
    if (me && speed > 3) kicked = true;
    // Chase the ball; hold kick whenever we are close to it.
    const near = me && Math.hypot(b[0] - me[1], b[1] - me[2]) < 34;
    red.input({ right: b[0] > (me ? me[1] : 0), left: b[0] < (me ? me[1] : 0), kick: !!near });
    if (red.state.sc[0] > 0) break;
  }
  red.input({});
  check('a kick fires the ball well above running speed', kicked && maxBallSpeed > 4,
    'peak ball speed=' + maxBallSpeed.toFixed(2) + ' units/tick');
  check('the ball travels a long way when struck', ballMoved > 300,
    'travelled=' + ballMoved.toFixed(0) + ' units');

  // --- goal + reset -----------------------------------------------------
  const scored = await waitUntil(() => red.state.sc[0] + red.state.sc[1] > 0, 30000);
  check('a goal is detected', scored, 'score=' + JSON.stringify(red.state.sc));
  check('the goal message goes out', await waitUntil(() => red.seen('goal'), 800));

  // Whoever last touched the ball is named on the goal, and the own-goal flag
  // always agrees with that player's side.
  const goalMsg = red.inbox.filter(m => m.t === 'goal').pop();
  const by = goalMsg && goalMsg.by;
  const scoringTeam = goalMsg && goalMsg.team === 0 ? 'red' : 'blue';
  check('the goal names the player who last touched the ball',
    !!by && typeof by.nick === 'string' && typeof by.own === 'boolean',
    JSON.stringify(by));
  check('the own-goal flag agrees with the scorer\'s team',
    !!by && by.own === (by.team !== scoringTeam),
    by ? by.team + ' scored for ' + scoringTeam + ' own=' + by.own : 'no author');

  const recentred = await waitUntil(() => {
    const b = red.state.b;
    return Math.abs(b[0]) < 6 && Math.abs(b[1]) < 6;
  }, 6000);
  check('the ball is returned to the centre spot after the celebration', recentred,
    'ball=' + JSON.stringify(red.state.b.slice(0, 2)));

  // Play resumes through a kick off: the team that conceded restarts, the
  // team that scored is held back, and the ball is live once it is touched.
  const backPlaying = await waitUntil(() => red.state.ph === 'kickoff' || red.state.ph === 'playing', 6000);
  check('play resumes after the goal', backPlaying, 'phase=' + red.state.ph);
  if (red.state.ph === 'kickoff') {
    const conceded = scoringTeam === 'red' ? 'blue' : 'red';
    check('the restart is a kick off for the team that conceded',
      red.state.ko === conceded, 'ko=' + red.state.ko + ' conceded=' + conceded);
  }

  // --- ball containment under sustained abuse ---------------------------
  const dims = MAPS.medium;
  let escapes = 0;
  red.input({ right: true, down: true, kick: true });
  blue.input({ left: true, up: true, kick: true });
  for (let i = 0; i < 200; i++) {
    await sleep(16);
    const b = red.state.b;
    const inMouth = Math.abs(b[1]) < dims.goalHalfH;
    const xLimit = inMouth ? dims.halfW + dims.goalDepth - 10 : dims.halfW - 10;
    if (Math.abs(b[0]) > xLimit + 2) escapes++;
    if (Math.abs(b[1]) > dims.halfH - 10 + 2) escapes++;
  }
  red.input({});
  blue.input({});
  check('the ball never escapes the pitch or the nets', escapes === 0, 'escapes=' + escapes);

  red.close();
  blue.close();
  await sleep(150);
}

/* ------------------------------------------------------------------ */
/*  Lobby, room browser, team balancing, admin                         */
/* ------------------------------------------------------------------ */

async function testLobby() {
  console.log('\n--- lobby, room browser, multiplayer ---');
  const host = new Client('Host');
  await host.ready;
  host.send({ type: 'list' });
  check('lobby receives a room list', await waitUntil(() => host.seen('rooms'), 1500));

  host.send({
    type: 'create', nick: 'Host', name: 'Smoke Room', password: 'secret',
    maxPlayers: 4, map: 'medium', timeLimit: 5, scoreLimit: 5,
  });
  check('host creates a room', await waitUntil(() => host.entered, 1500));
  const code = host.entered.code;

  host.send({ type: 'list' });
  await waitUntil(() => host.inbox.filter(m => m.t === 'rooms').length > 1, 1500);
  const listing = host.inbox.filter(m => m.t === 'rooms').pop().rooms.find(r => r.code === code);
  check('room browser lists the room with map, occupancy and password flag',
    listing && listing.max === 4 && listing.map === 'Medium' && listing.locked === true,
    JSON.stringify(listing));

  const wrongPass = new Client('Nope');
  await wrongPass.ready;
  wrongPass.send({ type: 'join', nick: 'Nope', room: code, password: 'wrong' });
  check('a wrong password is rejected',
    await waitUntil(() => wrongPass.errors.some(e => e.code === 'badpass'), 1500));
  wrongPass.close();

  const guests = [];
  for (const nick of ['Bob', 'Cara', 'Dan']) {
    const c = new Client(nick);
    await c.ready;
    c.send({ type: 'join', nick, room: code, password: 'secret' });
    guests.push(c);
    await waitUntil(() => c.room, 1500);
  }
  check('three more clients join', guests.every(g => g.entered), 'code=' + code);

  const all = [host, ...guests];
  await waitUntil(() => all.every(c => c.room && c.room.players.length === 4), 1500);

  const teams = { red: 0, blue: 0 };
  host.room.players.forEach(p => { teams[p.team]++; });
  check('4 players are auto-balanced across two teams',
    teams.red === 2 && teams.blue === 2, JSON.stringify(teams));

  check('the room reports 4 max players', host.room.maxPlayers === 4);
  check('the creator is the host', host.room.players.find(p => p.id === host.entered.you).admin === true);
  check('guests are not hosts', guests.every(g =>
    g.room.players.find(p => p.id === g.entered.you).admin === false));

  check('the room sits in the waiting phase until the host starts it',
    await waitUntil(() => host.state, 1500) && host.state.ph === 'waiting',
    'phase=' + (host.state && host.state.ph));

  // A guest must not be able to start the match from the room panel.
  guests[0].send({ type: 'admin', action: 'start' });
  await sleep(400);
  check('a guest cannot start the match', host.state.ph === 'waiting', 'phase=' + host.state.ph);

  await startMatch(host, 'the host starts a 4 player match');

  // Everyone visible in every client's snapshot.
  check('all four players appear in the snapshot',
    await waitUntil(() => host.state.p.length === 4, 1500),
    'snapshot size=' + host.state.p.length);

  guests[0].send({ type: 'chat', text: 'gg' });
  check('chat reaches every client in the room',
    await waitUntil(() => all.every(c => c.inbox.some(m => m.t === 'chat' && m.text === 'gg')), 1500));

  guests[2].send({ type: 'team', team: 'spec' });
  check('a player can drop to spectating',
    await waitUntil(() => host.room.players.find(p => p.nick === 'Dan' && p.team === 'spec'), 1500));
  check('spectators leave the pitch',
    await waitUntil(() => host.state.p.length === 3, 1500),
    'snapshot size=' + host.state.p.length);

  guests[2].send({ type: 'team', team: 'blue' });
  check('a spectator can rejoin a team',
    await waitUntil(() => host.state.p.length === 4, 1500));

  guests[1].send({ type: 'admin', action: 'map', map: 'big' });
  await sleep(200);
  check('a non-host cannot change the map', host.room.map === 'medium');

  host.send({ type: 'admin', action: 'map', map: 'big' });
  check('the host can switch to the big map',
    await waitUntil(() => host.room.map === 'big', 1500));
  check('the map change is announced',
    await waitUntil(() => all.every(c => c.room.map === 'big'), 1500));

  // Roster change propagates.
  const extra = new Client('Extra');
  await extra.ready;
  extra.send({ type: 'join', nick: 'Extra', room: code, password: 'secret' });
  check('joining a full room is refused',
    await waitUntil(() => extra.errors.some(e => /full/i.test(e.message)), 1500));
  extra.close();

  // Kicking.
  const victim = guests[1];
  host.send({ type: 'admin', action: 'kick', id: victim.entered.you });
  check('the host can kick a player',
    await waitUntil(() => host.room.players.length === 3, 1500),
    'players=' + host.room.players.length);
  victim.close();

  // Leaving cleans up and hands the pitch back.
  guests[0].close();
  await sleep(300);
  check('leaving removes the player from the room',
    await waitUntil(() => host.room.players.length === 2, 1500),
    'players=' + host.room.players.length);

  host.close();
  guests.forEach(g => g.close());
  await sleep(200);
}

/* ------------------------------------------------------------------ */
/*  Room panel: ping, team moves, Auto / Rand / Lock                   */
/* ------------------------------------------------------------------ */

async function testRoomPanel() {
  console.log('\n--- room panel ---');
  const host = await makeRoom('Panel', { maxPlayers: 6 });
  const code = host.entered.code;
  const guests = [];
  for (const nick of ['Ann', 'Ben', 'Cara']) {
    const c = await joinRoom(nick, code);
    guests.push(c);
    await waitUntil(() => c.room && c.room.players.length === guests.length + 1, 1500);
  }
  const [ann, ben, cara] = guests;

  host.send({ type: 'ping', i: 7 });
  check('the server echoes pings for the latency counter',
    await waitUntil(() => host.inbox.some(m => m.t === 'pong' && m.i === 7), 1500));

  check('the room publishes its team-lock flag', host.room.teamsLocked === false);

  const teamOf = (c) => {
    if (!c.room || !c.entered) return 'gone';
    const p = c.room.players.find(p => p.id === c.entered.you);
    return p ? p.team : 'gone';
  };
  const counts = () => {
    const c = { red: 0, blue: 0, spec: 0 };
    host.room.players.forEach(p => { c[p.team]++; });
    return c;
  };

  check('four players are spread two and two', JSON.stringify(counts()) === '{"red":2,"blue":2,"spec":0}',
    JSON.stringify(counts()));

  host.send({ type: 'admin', action: 'move', id: ben.entered.you, team: 'spec' });
  check('the host can move another player\'s column',
    await waitUntil(() => teamOf(ben) === 'spec', 1500), 'team=' + teamOf(ben));

  host.send({ type: 'admin', action: 'auto' });
  await sleep(300);
  check('Auto pulls spectators back in and levels the sides',
    JSON.stringify(counts()) === '{"red":2,"blue":2,"spec":0}', JSON.stringify(counts()));

  host.send({ type: 'admin', action: 'rand' });
  await sleep(300);
  check('Rand shuffles everyone but keeps the sides even',
    JSON.stringify(counts()) === '{"red":2,"blue":2,"spec":0}', JSON.stringify(counts()));

  const caraBefore = teamOf(cara);
  ann.send({ type: 'admin', action: 'move', id: cara.entered.you, team: 'spec' });
  await sleep(300);
  check('a guest cannot move other players', teamOf(cara) === caraBefore, 'team=' + teamOf(cara));

  host.send({ type: 'admin', action: 'lock' });
  check('the host can lock the teams',
    await waitUntil(() => host.room.teamsLocked === true, 1500));

  const annBefore = teamOf(ann);
  ann.send({ type: 'team', team: annBefore === 'red' ? 'blue' : 'red' });
  await sleep(300);
  check('a locked room refuses team changes', teamOf(ann) === annBefore, 'team=' + teamOf(ann));

  const late = await joinRoom('Late', code);
  check('newcomers join a locked room as spectators', teamOf(late) === 'spec', 'team=' + teamOf(late));
  late.close();

  host.send({ type: 'admin', action: 'lock', locked: false });
  check('the lock can be turned back off',
    await waitUntil(() => host.room.teamsLocked === false, 1500));

  host.close();
  guests.forEach(g => g.close());
  await sleep(200);
}

/* ------------------------------------------------------------------ */
/*  Every map keeps everyone contained                                 */
/* ------------------------------------------------------------------ */

async function testMaps() {
  console.log('\n--- map sizes ---');
  for (const key of Object.keys(MAPS)) {
    const dims = MAPS[key];
    const red = await makeRoom('R-' + key, { map: key, maxPlayers: 2 });
    const blue = await joinRoom('B-' + key, red.entered.code);
    await startMatch(red, null, true);
    // A kick off only ever opens when the ball is played, so the kicker has
    // to go and play it: the barrier would otherwise hold everyone for good.
    red.input({ right: true, kick: true });
    const ok = await waitUntil(() => red.state && red.state.ph === 'playing', 9000);
    if (!ok) { check('map "' + key + '" starts', false); red.close(); blue.close(); continue; }

    red.input({ right: true, down: true, kick: true });
    blue.input({ left: true, up: true, kick: true });

    let bad = 0;
    let minSeparation = Infinity;
    for (let i = 0; i < 180; i++) {
      await sleep(16);
      if (!red.state) continue;
      const rows = red.state.p;
      rows.forEach(row => {
        if (Math.abs(row[2]) > dims.halfH - 14.5) bad++;
        if (Math.abs(row[1]) > dims.halfW + dims.goalDepth - 14.5) bad++;
      });
      const b = red.state.b;
      const inMouth = Math.abs(b[1]) < dims.goalHalfH;
      const xLimit = inMouth ? dims.halfW + dims.goalDepth - 9.5 : dims.halfW - 9.5;
      if (Math.abs(b[0]) > xLimit) bad++;
      if (Math.abs(b[1]) > dims.halfH - 9.5) bad++;
      for (let a = 0; a < rows.length; a++) {
        for (let c = a + 1; c < rows.length; c++) {
          minSeparation = Math.min(minSeparation,
            Math.hypot(rows[a][1] - rows[c][1], rows[a][2] - rows[c][2]));
        }
      }
    }
    check('map "' + key + '" keeps the ball and players inside the pitch',
      bad === 0, 'violations=' + bad);
    check('map "' + key + '" keeps players from overlapping',
      minSeparation > 28, 'closest pair=' + minSeparation.toFixed(1) + ' (radii sum 30)');

    red.close();
    blue.close();
    await sleep(150);
  }
}

/* ------------------------------------------------------------------ */
/*  Own goals, goal attribution and the non-stopping celebration        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  A stadium in HaxBall's own map format                               */
/* ------------------------------------------------------------------ */

/* Deliberately tiny, with a wide mouth: on a 400x240 pitch with a ±80 goal,
   a kick off is a straight run into a goal, so a test can *ask* for a goal
   instead of hoping a scripted dribble lands one.  It is written the way a
   real .hbs file is — traits, cMask, cGroup, goalNet, planes — so loading it
   exercises the same path as a map off the internet. */
function testBoxMap() {
  // The mouth is as wide as the pitch is tall, so any ball that reaches a
  // touchline is a goal: a test shoving the ball at its own net cannot wedge
  // it in a corner and hang there.
  const W = 200, H = 120, M = 110, D = 45, CIRCLE = 55;
  const v = [
    [-W, -H], [W, -H], [W, H], [-W, H],                 // 0-3  corners
    [-W, -M], [-W, M], [W, -M], [W, M],                 // 4-7  mouth
    [-W - D, -M], [-W - D, M], [W + D, -M], [W + D, M], // 8-11 net backs
    [0, -CIRCLE], [0, CIRCLE],                          // 12-13 kick off line
    [0, -H], [0, H],                                    // 14-15 halfway line ends
  ];
  const seg = (v0, v1, trait, extra) =>
    Object.assign({ v0, v1, trait }, extra || {});

  return {
    name: 'Test Box',
    width: W,
    height: H,
    spawnDistance: 90,
    // A ground of its own, named outright, on top of a corner radius: the
    // built-in green must not be forced onto a map that asks for something
    // else.  Real files write the colour as a bare hex string.
    bg: {
      type: 'grass', width: W, height: H, kickOffRadius: CIRCLE,
      cornerRadius: 24, color: '8a3b2a',
    },
    vertexes: v.map(p => ({ x: p[0], y: p[1] })),
    segments: [
      // The ball's rectangle: the mouth is left open on both sides.
      seg(0, 1, 'ballArea'), seg(2, 3, 'ballArea'),
      seg(0, 4, 'ballArea'), seg(5, 3, 'ballArea'),
      seg(1, 6, 'ballArea'), seg(7, 2, 'ballArea'),
      // Nets: the ball only, the way goalNet works everywhere.
      seg(8, 9, 'goalNet'), seg(10, 11, 'goalNet'),
      seg(4, 8, 'goalNet'), seg(5, 9, 'goalNet'),
      seg(6, 10, 'goalNet'), seg(7, 11, 'goalNet'),
      // The kick off barrier, tagged exactly like a real map tags it: the
      // halfway line stands for both teams, and each half circle guards the
      // half of the team that is *not* taking the kick off.  A curve of -180
      // from +y to -y bulges into +x, so redKO holds blue back and blueKO
      // holds red back — the same way round as a real HaxMaps file.
      seg(14, 12, 'kickOffBarrier'),
      seg(13, 15, 'kickOffBarrier'),
      seg(13, 12, 'kickOffBarrier', { curve: -180, cGroup: ['redKO'] }),
      seg(13, 12, 'kickOffBarrier', { curve: 180, cGroup: ['blueKO'] }),
    ],
    goals: [
      { p0: [-W, -M], p1: [-W, M], team: 'red' },
      { p0: [W, M], p1: [W, -M], team: 'blue' },
    ],
    discs: [
      { pos: [-W, M], trait: 'goalPost', radius: 5, color: 'ffffff' },
      { pos: [-W, -M], trait: 'goalPost', radius: 5, color: 'ffffff' },
      { pos: [W, M], trait: 'goalPost', radius: 5, color: 'ffffff' },
      { pos: [W, -M], trait: 'goalPost', radius: 5, color: 'ffffff' },
    ],
    // Players are held in by planes, the ball by the ballArea segments above
    // — the same split real maps use.
    planes: [
      { normal: [0, 1], dist: -H - 30, bCoef: 0.2, cMask: ['all'] },
      { normal: [0, -1], dist: -H - 30, bCoef: 0.2, cMask: ['all'] },
      { normal: [1, 0], dist: -W - 30, bCoef: 0.2, cMask: ['all'] },
      { normal: [-1, 0], dist: -W - 30, bCoef: 0.2, cMask: ['all'] },
    ],
    traits: {
      ballArea: { vis: true, bCoef: 0.5, cMask: ['ball'] },
      goalNet: { vis: true, bCoef: 0.1, cMask: ['ball'] },
      goalPost: { radius: 5, invMass: 0, bCoef: 0.5 },
      kickOffBarrier: { vis: false, bCoef: 0, cMask: ['red', 'blue'] },
      line: { vis: true, bCoef: 0, cMask: [''] },
    },
    ballPhysics: { radius: 12, color: 'ff9900' },
  };
}

async function testCustomMap() {
  console.log('\n--- custom .hbs maps ---');
  const host = await makeRoom('Cartographer', { maxPlayers: 2 });
  const guest = await joinRoom('Visitor', host.entered.code);

  const stadiumMsg = () => host.inbox.filter(m => m.t === 'stadium').pop();

  host.send({ type: 'admin', action: 'map', map: 'custom', hbs: testBoxMap() });
  check('the host can load a HaxBall map',
    await waitUntil(() => stadiumMsg() && stadiumMsg().stadium, 1500));
  check('the room reports it as a custom map',
    host.room && host.room.map === 'custom' && host.room.mapLabel === 'Test Box',
    'map=' + (host.room && host.room.map) + ' label=' + (host.room && host.room.mapLabel));
  check('everyone in the room gets the geometry',
    await waitUntil(() => guest.inbox.some(m => m.t === 'stadium' && m.stadium), 1500));

  const st = stadiumMsg().stadium;
  check('the walls, nets and barrier all arrive',
    st.segs.length === 16, 'segs=' + st.segs.length);
  check('walls and nets are drawn, barrier segments are not',
    st.segs.filter(s => s.vis).length === 12
      && st.segs.filter(s => !s.vis).length === 4,
    'visible=' + st.segs.filter(s => s.vis).length);
  check('the kick off barrier is tagged for both teams and for each side',
    st.segs.filter(s => s.ko === 'both').length === 2
      && st.segs.filter(s => s.ko === 'red').length === 1
      && st.segs.filter(s => s.ko === 'blue').length === 1,
    'ko=' + JSON.stringify(st.segs.filter(s => s.ko).map(s => s.ko)));
  check('goal posts arrive as discs', st.posts.length === 4, 'posts=' + st.posts.length);
  check('the goals arrive with the team that defends each one',
    st.goals.length === 2 && st.goals.some(g => g.team === 'red')
      && st.goals.some(g => g.team === 'blue'));
  check('the map\'s own ball size and colour are used',
    st.ball.radius === 12 && st.ball.color === '#ff9900', JSON.stringify(st.ball));
  check('the bounds come from the map, not the built-in sizes',
    st.bounds && st.bounds.maxX > 200 && st.bounds.maxX < 300, JSON.stringify(st.bounds));
  check('the pitch is drawn on the ground the map names, not the built-in green',
    st.pitch.color === '#8a3b2a' && st.pitch.type === 'grass' && st.pitch.corner === 24,
    JSON.stringify(st.pitch));

  // A converter that hands the colour over as a number gets the same thing.
  const numeric = testBoxMap();
  numeric.bg.color = 0x1b6ea8;
  host.send({ type: 'admin', action: 'map', map: 'custom', hbs: numeric });
  check('a ground colour written as a number is read too',
    await waitUntil(() => (stadiumMsg().stadium || {}).pitch.color === '#1b6ea8', 1500),
    JSON.stringify((stadiumMsg().stadium || {}).pitch));
  host.send({ type: 'admin', action: 'map', map: 'custom', hbs: testBoxMap() });
  await waitUntil(() => (stadiumMsg().stadium || {}).pitch.color === '#8a3b2a', 1500);

  // The loaded pitch has to be playable, not just deliverable.
  await startMatch(host, 'a match starts on a loaded map');
  const playing = await waitUntil(() => host.state && host.state.ph !== 'waiting', 3000);
  host.input({ right: true, down: true, kick: true });
  guest.input({ left: true, up: true, kick: true });
  let outside = 0;
  for (let i = 0; i < 150 && playing; i++) {
    await sleep(16);
    if (!host.state) continue;
    host.state.p.forEach(row => {
      if (Math.abs(row[2]) > 152 || Math.abs(row[1]) > 232) outside++;
    });
  }
  check('players stay inside a loaded map', outside === 0, 'violations=' + outside);

  // Refusals: a broken map must not take the room down with it.
  const before = host.room.map;
  host.send({ type: 'admin', action: 'map', map: 'custom', hbs: { hello: 'world' } });
  check('a file that is not a map is refused',
    await waitUntil(() => host.errors.some(e => /vertexes or segments/.test(e.message || '')), 1500),
    JSON.stringify(host.errors.map(e => e.message)));

  const noGoals = testBoxMap();
  noGoals.goals = [];
  host.send({ type: 'admin', action: 'map', map: 'custom', hbs: noGoals });
  check('a map with nowhere to score is refused',
    await waitUntil(() => host.errors.some(e => /goals/.test(e.message || '')), 1500));

  const huge = testBoxMap();
  huge.vertexes = new Array(5000).fill({ x: 0, y: 0 });
  host.send({ type: 'admin', action: 'map', map: 'custom', hbs: huge });
  check('an absurdly large map is refused',
    await waitUntil(() => host.errors.some(e => /too many vertexes/.test(e.message || '')), 1500));
  check('none of that changed the room', host.room.map === before, 'map=' + host.room.map);
  check('and none of it dropped the connection', host.ws.readyState === WebSocket.OPEN);

  // A payload past the frame ceiling gets that one connection dropped, and
  // nothing else: the room and everyone else in it carry on.
  const flood = new Client('Flooder');
  await flood.ready;
  flood.send({ type: 'create', nick: 'Flooder', name: 'flood', password: '', maxPlayers: 2,
    map: 'medium', timeLimit: 0, scoreLimit: 0 });
  await waitUntil(() => flood.entered, 1500);
  flood.send({ type: 'admin', action: 'map', map: 'custom', hbs: { pad: 'x'.repeat(600 * 1024) } });
  await sleep(500);
  check('an oversized map message drops only the sender',
    flood.ws.readyState === WebSocket.CLOSED || flood.ws.readyState === WebSocket.CLOSING,
    'readyState=' + flood.ws.readyState);
  const latecomer = new Client('Latecomer');
  await latecomer.ready;
  latecomer.send({ type: 'list' });
  check('the server is still serving after it',
    await waitUntil(() => latecomer.seen('rooms'), 1500));
  check('and the room that was playing is untouched',
    host.ws.readyState === WebSocket.OPEN && host.room.map === 'custom',
    'map=' + host.room.map);
  flood.close();
  latecomer.close();

  // Back to a built-in pitch: the loaded geometry goes away again.
  host.send({ type: 'admin', action: 'map', map: 'medium' });
  check('the host can go back to a built-in pitch',
    await waitUntil(() => host.room.map === 'medium' && stadiumMsg().stadium === null, 1500),
    'map=' + host.room.map + ' stadium=' + JSON.stringify(stadiumMsg().stadium));
  check('and everyone is told to forget the loaded map',
    await waitUntil(() => guest.inbox.filter(m => m.t === 'stadium').pop().stadium === null, 1500));

  // The map the user actually has, when it is on this machine.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const sample = path.join(os.homedir(), 'Downloads', 'haxmaps_144522153775.hbs');
  if (fs.existsSync(sample)) {
    host.send({ type: 'admin', action: 'map', map: 'custom', hbs: JSON.parse(fs.readFileSync(sample, 'utf8')) });
    const ok = await waitUntil(() => host.room.map === 'custom' && stadiumMsg().stadium, 2000);
    check('a real HaxMaps futsal map loads', ok,
      'label=' + (host.room && host.room.mapLabel) + ' segs=' + ((stadiumMsg().stadium || {}).segs || []).length);
    const real = stadiumMsg().stadium;
    check('it plays on the pitch the map states, inside tighter bounds',
      real && real.pitch.halfW === 665 && real.pitch.halfH === 290
        && real.bounds.maxX > 690 && real.bounds.maxX < 740,
      'pitch=' + JSON.stringify(real && real.pitch) + ' bounds=' + JSON.stringify(real && real.bounds));
    check('and keeps that map\'s own ball',
      real && real.ball.radius === 6.4
        && String(real.ball.color).toLowerCase() === '#eaff00',
      JSON.stringify(real && real.ball));
    check('a map that asks for a hockey rink is not pushed onto grass either',
      real && real.pitch.type === 'hockey' && real.pitch.color === '',
      JSON.stringify(real && real.pitch));
    check('its barrier is tagged from the map, not from a built-in',
      real && real.segs.filter(s => s.ko === 'both').length === 2
        && real.segs.filter(s => s.ko === 'red').length === 1
        && real.segs.filter(s => s.ko === 'blue').length === 1,
      'ko=' + JSON.stringify((real || { segs: [] }).segs.filter(s => s.ko).map(s => s.ko)));
  } else {
    console.log('  skip  the sample .hbs file is not in ~/Downloads');
  }

  host.close();
  guest.close();
  await sleep(150);
}

/* ------------------------------------------------------------------ */
/*  Goals, own goals, the kick off barrier and the celebration          */
/* ------------------------------------------------------------------ */

/* Clear of the ball, round to its far side, then shove it back into your own
   net.  Walking straight at the ball only ever dribbles it towards the other
   goal, hence the detour. */
function ownGoalInput(me, b) {
  let tx, ty, kick;
  if (me[1] < b[0] - 30 && Math.abs(me[2] - b[1]) < 44) {
    tx = me[1]; ty = b[1] - 50; kick = false;              // climb clear
  } else if (me[1] < b[0] + 30) {
    tx = b[0] + 36; ty = b[1] - 36; kick = false;          // swing round it
  } else {
    tx = b[0] + 26; ty = b[1]; kick = true;                // drop in and shove
  }
  return {
    right: tx > me[1] + 3, left: tx < me[1] - 3,
    down: ty > me[2] + 3, up: ty < me[2] - 3,
    kick: kick && Math.hypot(b[0] - me[1], b[1] - me[2]) < 60,
  };
}

async function testGoals() {
  console.log('\n--- goals, own goals and the kick off barrier ---');
  const red = await makeRoom('Red', { maxPlayers: 2 });
  const blue = await joinRoom('Blue', red.entered.code);
  red.send({ type: 'admin', action: 'map', map: 'custom', hbs: testBoxMap() });
  await waitUntil(() => red.room && red.room.map === 'custom', 1500);

  await startMatch(red, 'the host starts the match on a loaded map');
  const ko = await waitUntil(() => red.state && red.state.ph === 'kickoff', 3000);
  check('a match opens with a kick off, not with play', ko, 'phase=' + (red.state && red.state.ph));
  check('red takes the first kick off', red.state && red.state.ko === 'red',
    'ko=' + (red.state && red.state.ko));

  // The team that is not kicking off cannot cross into the other half, and
  // cannot reach the ball: that is the wall the user asked for.  The wall is
  // the half circle, so the closest it may get is its own radius plus the
  // kick off circle.
  red.input({});
  blue.input({ left: true, kick: true });
  let closest = Infinity;
  let nearestX = Infinity;
  for (let i = 0; i < 70; i++) {
    await sleep(16);
    const me = blue.me();
    if (!me || red.state.ph !== 'kickoff') break;
    nearestX = Math.min(nearestX, me[1]);
    closest = Math.min(closest, Math.hypot(me[1] - red.state.b[0], me[2] - red.state.b[1]));
  }
  check('the team waiting for the kick off is held outside the centre circle',
    nearestX >= 68, 'closest x=' + nearestX.toFixed(1) + ' (wall at 70)');
  check('and it cannot reach the ball', closest > 24, 'closest=' + closest.toFixed(1));
  check('the wall is still up while nobody has played the ball',
    red.state.ph === 'kickoff', 'phase=' + red.state.ph);

  // Nobody touches the ball, and the wall has to stay exactly where it is.
  // There is no timer on it any more: wall that quietly disappeared after a
  // few seconds is the bug the user reported, so this waits well past the
  // eight seconds the old stall guard allowed before it looks.
  const heldFrom = Date.now();
  let stillOut = Infinity;
  while (Date.now() - heldFrom < 10000 && red.state.ph === 'kickoff') {
    const me = blue.me();
    if (me) stillOut = Math.min(stillOut, me[1]);
    await sleep(50);
  }
  check('the wall never comes down on its own',
    red.state.ph === 'kickoff',
    'phase=' + red.state.ph + ' after ' + ((Date.now() - heldFrom) / 1000).toFixed(1) + 's');
  check('and it still holds the waiting team out of the half',
    stillOut >= 68, 'closest x=' + stillOut.toFixed(1));
  red.input({});

  // Red shoves the ball into its own net: an own goal for blue.
  let goalMsg = null;
  let freeze = null;
  for (let i = 0; i < 900 && !goalMsg; i++) {
    const me = red.me();
    // Blue keeps to its own corner; the own goal is red's business.
    blue.input({ right: true, up: true });
    if (me) red.input(ownGoalInput(me, red.state.b));
    if (red.state.sc[1] > 0) {
      goalMsg = red.inbox.filter(m => m.t === 'goal').pop();
      // The celebration must not stop the match: hold a key and watch the
      // snapshot keep evolving while the phase is still 'goal'.
      const before = red.me();
      red.input({ left: true });
      await sleep(200);
      const after = red.me();
      freeze = {
        phase: red.state.ph,
        before: before && [before[1], before[3]],
        after: after && [after[1], after[3]],
      };
    }
    await sleep(16);
  }

  check('a ball put into your own net counts for the other side',
    red.state.sc[1] === 1 && red.state.sc[0] === 0, 'score=' + JSON.stringify(red.state.sc));
  check('it is reported as an own goal by the player who last touched it',
    !!goalMsg && goalMsg.by && goalMsg.by.own === true && goalMsg.by.nick === 'Red'
      && goalMsg.by.team === 'red',
    JSON.stringify(goalMsg && goalMsg.by));
  check('the goal is credited to the other team', !!goalMsg && goalMsg.team === 1,
    'team=' + (goalMsg && goalMsg.team));
  check('the barrier came down when the ball was played',
    !!goalMsg || red.state.ph !== 'kickoff', 'phase=' + red.state.ph);

  const moved = freeze && freeze.before && freeze.after
    && (freeze.before[0] !== freeze.after[0] || freeze.before[1] !== freeze.after[1]);
  check('the match keeps running through the goal celebration',
    freeze && freeze.phase === 'goal' && moved,
    freeze ? 'phase=' + freeze.phase + ' x ' + freeze.before[0].toFixed(1) + '→' + freeze.after[0].toFixed(1)
      + ' vx ' + freeze.before[1].toFixed(2) + '→' + freeze.after[1].toFixed(2) : 'no goal seen');

  // The side that conceded takes the next kick off, and the side that scored
  // is the one that is now walled in.
  const backKickoff = await waitUntil(() => red.state.ph === 'kickoff' && red.state.ko === 'red', 4000);
  check('the team that conceded takes the next kick off', backKickoff,
    'phase=' + red.state.ph + ' ko=' + red.state.ko);

  blue.input({ left: true, kick: true });
  let blueX = Infinity;
  for (let i = 0; i < 70; i++) {
    await sleep(16);
    const me = blue.me();
    if (!me || red.state.ph !== 'kickoff') break;
    blueX = Math.min(blueX, me[1]);
  }
  check('the team that scored is walled out of the next kick off',
    blueX >= 68, 'closest x=' + blueX.toFixed(1) + ' (wall at 70)');

  // Until the kicker plays the ball: then the wall goes and everyone is free.
  red.input({ right: true, kick: true });
  const opened = await waitUntil(() => red.state.ph === 'playing', 2000);
  check('playing the ball ends the kick off', opened, 'phase=' + red.state.ph);

  // Blue walks around the ball rather than through it, and crosses the
  // halfway line: only a barrier that has been lifted lets it.
  blue.input({ left: true, up: true, kick: true });
  const through = await waitUntil(() => {
    const me = blue.me();
    return me && me[1] < -20;
  }, 3000);
  check('the wall is gone once the kick off is taken', through,
    'blue x=' + (blue.me() ? blue.me()[1].toFixed(1) : 'n/a'));

  // The ball is live rather than wedged in a corner or a net: with both
  // sides still shoving it, it has to keep travelling.
  const from = red.state.b.slice(0, 2);
  let travelled = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(25);
    const b = red.state.b;
    travelled = Math.max(travelled, Math.hypot(b[0] - from[0], b[1] - from[1]));
  }
  check('the ball is loose in play, not wedged', travelled > 25,
    'travelled=' + travelled.toFixed(1) + ' from ' + JSON.stringify(from)
      + ' phase=' + red.state.ph + ' score=' + JSON.stringify(red.state.sc));

  red.close();
  blue.close();
  await sleep(150);
}

/* ------------------------------------------------------------------ */
/*  Ball images                                                         */
/* ------------------------------------------------------------------ */

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function testAvatars() {
  console.log('\n--- ball images ---');
  const host = await makeRoom('Painter', { avatar: TINY_PNG });

  const avatarOf = (c, nick) => {
    if (!c.room) return 'no room';
    const p = c.room.players.find(p => p.nick === nick);
    return p ? p.avatar : 'gone';
  };

  check('a ball image set at create time is stored',
    avatarOf(host, 'Painter') === TINY_PNG);

  const guest = await joinRoom('Guest', host.entered.code);
  check('everyone in the room receives it',
    avatarOf(guest, 'Painter') === TINY_PNG);
  check('players without one are simply empty', avatarOf(host, 'Guest') === '');

  guest.send({ type: 'avatar', data: TINY_PNG });
  check('a player can add one mid-game',
    await waitUntil(() => avatarOf(host, 'Guest') === TINY_PNG, 1500));

  guest.send({ type: 'avatar', data: 'data:text/html;base64,PHNjcmlwdD4=' });
  await sleep(300);
  check('anything that is not a raster image is refused',
    avatarOf(host, 'Guest') === TINY_PNG, 'avatar=' + String(avatarOf(host, 'Guest')).slice(0, 24));

  // The frame ceiling has to sit above the image budget: a client that sends
  // its biggest legal image must not have its socket torn down for it.
  guest.send({ type: 'avatar', data: 'data:image/png;base64,' + 'A'.repeat(50000) });
  await sleep(400);
  check('an oversized image is refused', avatarOf(host, 'Guest') === TINY_PNG);
  check('an oversized image does not kill the connection',
    guest.ws.readyState === WebSocket.OPEN, 'readyState=' + guest.ws.readyState);

  // A legal image right at the ceiling still fits through the transport.
  const big = 'data:image/png;base64,' + 'A'.repeat(39000);
  guest.send({ type: 'avatar', data: big });
  check('a large but legal image is accepted',
    await waitUntil(() => avatarOf(host, 'Guest') === big, 1500),
    'stored=' + String(avatarOf(host, 'Guest')).length + ' chars');

  guest.send({ type: 'avatar', data: '' });
  check('a player can clear it again',
    await waitUntil(() => avatarOf(host, 'Guest') === '', 1500));

  check('the room survives all of it',
    host.ws.readyState === WebSocket.OPEN && !!host.room.players.length);

  host.close();
  guest.close();
  await sleep(150);
}

/* ------------------------------------------------------------------ */
/*  Admin rights: promote, demote, move, kick, and who may not at all   */
/* ------------------------------------------------------------------ */

async function testAdmins() {
  console.log('\n--- admins ---');
  const host = await makeRoom('Boss', { maxPlayers: 8 });
  const guest = await joinRoom('Guest', host.entered.code);
  const third = await joinRoom('Third', host.entered.code);

  const idOf = (c, nick) => {
    const p = c.room.players.find(p => p.nick === nick);
    return p ? p.id : 0;
  };
  const adminOf = (c, nick) => {
    const p = c.room.players.find(p => p.nick === nick);
    return p ? p.admin : null;
  };
  const teamOf = (c, nick) => {
    const p = c.room.players.find(p => p.nick === nick);
    return p ? p.team : 'gone';
  };

  const hostId = idOf(host, 'Boss');
  const guestId = idOf(host, 'Guest');
  const thirdId = idOf(host, 'Third');

  check('the player who opened the room is its host and an admin',
    host.room.hostId === hostId && adminOf(host, 'Boss') === true,
    'hostId=' + host.room.hostId);
  check('everyone else arrives a plain player',
    adminOf(host, 'Guest') === false && adminOf(host, 'Third') === false);

  // A player with no rights can ask for anything they like; nothing happens.
  // They are asked to move to a column they are not in, so an ignored request
  // and a granted one look different.
  const before = teamOf(host, 'Third');
  const elsewhere = before === 'red' ? 'blue' : 'red';
  guest.send({ type: 'admin', action: 'move', id: thirdId, team: elsewhere });
  guest.send({ type: 'admin', action: 'admin', id: thirdId, admin: true });
  guest.send({ type: 'admin', action: 'kick', id: hostId });
  await sleep(400);
  check('a player without admin rights can move nobody',
    teamOf(host, 'Third') === before,
    'Third is ' + teamOf(host, 'Third') + ', asked for ' + elsewhere);
  check('a player without admin rights cannot promote anyone', adminOf(host, 'Third') === false);
  check('a player without admin rights cannot kick the host',
    host.room.players.length === 3 && host.ws.readyState === WebSocket.OPEN);

  // An admin can move anyone between the three columns.
  host.send({ type: 'admin', action: 'move', id: thirdId, team: 'red' });
  check('an admin can move another player to a team',
    await waitUntil(() => teamOf(host, 'Third') === 'red', 1000), 'Third is ' + teamOf(host, 'Third'));

  host.send({ type: 'admin', action: 'move', id: thirdId, team: 'spec' });
  check('an admin can move another player to the spectators',
    await waitUntil(() => teamOf(host, 'Third') === 'spec', 1000), 'Third is ' + teamOf(host, 'Third'));

  // Promotion, and the promoted player having the same rights.
  host.send({ type: 'admin', action: 'admin', id: guestId, admin: true });
  check('an admin can make another player an admin',
    await waitUntil(() => adminOf(host, 'Guest') === true, 1000));
  check('the room can hold more than one admin',
    adminOf(host, 'Boss') === true && adminOf(host, 'Guest') === true);

  guest.send({ type: 'admin', action: 'move', id: hostId, team: 'blue' });
  check('a promoted player can act with their new rights',
    await waitUntil(() => teamOf(host, 'Boss') === 'blue', 1000), 'Boss is ' + teamOf(host, 'Boss'));

  // The host's own admin is not a role anyone can take back.
  guest.send({ type: 'admin', action: 'admin', id: hostId, admin: false });
  await sleep(400);
  check('the host cannot be demoted by another admin',
    adminOf(host, 'Boss') === true,
    'error=' + (guest.errors.map(e => e.message).pop() || 'none'));

  host.send({ type: 'admin', action: 'admin', id: guestId, admin: false });
  check('any other admin can be demoted again',
    await waitUntil(() => adminOf(host, 'Guest') === false, 1000));

  // Kick: out of the room, and told why.
  host.send({ type: 'admin', action: 'kick', id: thirdId });
  check('an admin can kick a player',
    await waitUntil(() => !host.room.players.some(p => p.nick === 'Third'), 1000),
    'players=' + host.room.players.map(p => p.nick).join(','));
  check('the kicked player is told', third.seen('kicked'), 'messages=' + third.inbox.map(m => m.t).join(','));
  check('the kicker stays', host.room.players.length === 2);

  // The host walking out hands the role on rather than leaving a room nobody
  // can administer.
  host.close();
  check('the room hands the host role to whoever is left',
    await waitUntil(() => guest.room && guest.room.hostId === guestId, 1500),
    'hostId=' + (guest.room && guest.room.hostId));
  check('and that player is an admin', adminOf(guest, 'Guest') === true);

  guest.close();
  await sleep(150);
}

/* ------------------------------------------------------------------ */
/*  Bans                                                                */
/* ------------------------------------------------------------------ */

/* A ban is remembered against the client's address, and every client in this
   suite shares one address, so this runs against a server of its own — it
   would otherwise lock the rest of the tests out. */
async function testBan() {
  console.log('\n--- bans ---');
  const port = 8099;
  const previous = URL;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const listening = new Promise(resolve => {
    child.stdout.on('data', chunk => {
      output += chunk;
      if (/listening/i.test(output)) resolve(true);
    });
    child.stderr.on('data', chunk => { output += chunk; });
    setTimeout(() => resolve(false), 4000);
  });

  try {
    if (!await listening) {
      check('a server of its own for the ban', false, output.trim().split('\n').pop() || 'no output');
      return;
    }
    check('a server of its own for the ban', true, 'port ' + port);

    URL = 'ws://localhost:' + port;
    const host = await makeRoom('Warden');
    const guest = await joinRoom('Outlaw', host.entered.code);
    const guestId = host.room.players.find(p => p.nick === 'Outlaw').id;

    host.send({ type: 'admin', action: 'kick', id: guestId });
    check('a kicked player can walk straight back in',
      await waitUntil(() => !host.room.players.some(p => p.nick === 'Outlaw'), 1000));
    const back = await joinRoom('Outlaw', host.entered.code);
    check('and they do', !!back.room && host.room.players.some(p => p.nick === 'Outlaw'));
    const backId = host.room.players.find(p => p.nick === 'Outlaw').id;

    host.send({ type: 'admin', action: 'ban', id: backId });
    check('an admin can ban that player',
      await waitUntil(() => !host.room.players.some(p => p.nick === 'Outlaw'), 1000));
    check('the banned player is told', back.seen('kicked'));

    // The address is what is remembered, so a brand new socket is refused
    // just the same.
    const retry = new Client('Outlaw');
    await retry.ready;
    retry.send({ type: 'join', nick: 'Outlaw', room: host.entered.code, password: '' });
    check('a banned player cannot rejoin on a new connection',
      await waitUntil(() => retry.errors.length > 0, 1500),
      'error=' + (retry.errors[0] && retry.errors[0].message));
    check('the refusal is fatal, not a quiet drop',
      !!(retry.errors[0] && retry.errors[0].fatal));
    check('a banned player cannot open a room either', !retry.room);

    // The ban is against one address, not the whole server.
    check('the room is still there for everyone else',
      host.room.players.length === 1 && host.ws.readyState === WebSocket.OPEN);

    host.close();
    retry.close();
    await sleep(150);
  } finally {
    URL = previous;
    child.kill();
    await sleep(100);
  }
}

async function main() {
  // `node _smoke.js goals` runs one suite while working on it.
  const only = (process.argv[2] || '').toLowerCase();
  const suites = [
    ['physics', testPhysics],
    ['lobby', testLobby],
    ['room', testRoomPanel],
    ['goals', testGoals],
    ['maps', testMaps],
    ['custom', testCustomMap],
    ['avatars', testAvatars],
    ['admins', testAdmins],
    // Last on purpose: a ban is kept against the client address, and every
    // test client here shares one address.
    ['ban', testBan],
  ];

  for (const [name, run] of suites) {
    if (only && only !== name) continue;
    await run();
  }

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test crashed:', err);
  process.exit(2);
});
