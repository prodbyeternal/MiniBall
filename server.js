'use strict';

/* =====================================================================
 * MiniBall — authoritative multiplayer server
 *
 * The physics constants below are HaxBall's "Classic" defaults, kept in
 * HaxBall's own world units (player radius 15, ball radius 10, velocity
 * measured per tick at 60Hz).  Keeping the numbers 1:1 is what makes the
 * game *feel* like HaxBall instead of merely looking like it: a player
 * tops out at 2.4 units/tick and a full-power kick throws the ball about
 * 500 units, which is a bit over half of a Classic pitch.
 * ===================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const TICK_HZ = 60;
const DT = 1 / TICK_HZ;
const EMPTY_ROOM_TTL = 10 * 60 * 1000;
const MAX_CHAT_LEN = 120;
const MAX_NICK_LEN = 16;
// A player's ball image travels as a data URL inside every room message, so
// it is capped hard: enough for a 64x64 PNG or a small animated GIF.
const MAX_AVATAR_LEN = 40000;
const AVATAR_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

/* ------------------------------ physics ------------------------------ */

const PLAYER_PHYS = {
  radius: 15,
  invMass: 0.5,
  bCoef: 0.5,
  damping: 0.96,        // velocity multiplier per tick while running
  accel: 0.1,           // velocity added per tick while running
  kickingDamping: 0.96,
  kickingAccel: 0.07,   // holding the kick key slows you down, as in HaxBall
  kickStrength: 5,      // impulse added to the ball along the contact normal
  kickback: 0,          // HaxBall default: kicking does not push you back
};

const BALL_PHYS = {
  radius: 10,
  invMass: 1,
  bCoef: 0.5,
  damping: 0.99,
};

// Running equilibrium is accel*damping/(1-damping) = 2.4; the cap is a
// safety net, not the thing that limits speed in normal play.
const PLAYER_SPEED_CAP = 2.6;
const BALL_SPEED_CAP = 14;
const KICK_REACH = 4;   // extra reach beyond the two radii, as in HaxBall

/* ------------------------------ stadiums ----------------------------- */

/* The three built-in pitches stay a handful of numbers, the way they always
   were.  The client mirrors MAPS and draws these by hand — grass, stripes,
   boxes, nets — so the numbers are also what the picture is made of. */
const MAPS = {
  small: {
    label: 'Small', halfW: 300, halfH: 170,
    goalHalfH: 45, goalDepth: 34,
    centreCircle: 60, boxDepth: 78, boxHalfH: 108,
    spawnX: 92,
  },
  medium: {
    label: 'Medium', halfW: 420, halfH: 200,
    goalHalfH: 64, goalDepth: 50,
    centreCircle: 78, boxDepth: 105, boxHalfH: 132,
    spawnX: 118,
  },
  big: {
    label: 'Big', halfW: 620, halfH: 270,
    goalHalfH: 86, goalDepth: 62,
    centreCircle: 100, boxDepth: 140, boxHalfH: 176,
    spawnX: 158,
  },
};

const CUSTOM_MAP = 'custom';

/* Whatever the pitch is — one of the three above or a HaxBall .hbs file the
   host loaded — the physics only ever sees the same bag of static geometry:

     segs    walls, straight or curved, each with its own bounce and mask
     posts   free standing discs (goal posts, corner dots)
     planes  half spaces that bound the world
     goals   the lines the ball has to cross

   World units and the y-down orientation are HaxBall's own, so a map file is
   read in without a conversion pass and the numbers behind the built-ins
   keep meaning exactly what they meant before. */

const HBS_LIMITS = { vertexes: 2000, segments: 2000, discs: 200, planes: 100, goals: 8 };
const MAX_MAP_NAME = 60;

/* HaxBall's collision masks: a list of the categories a wall collides with.
   "all" is everybody, "ball" is the ball, "red"/"blue" are the players of
   that side, and an empty list (the decorative `line` trait) is nothing. */
function maskInfo(mask) {
  const list = Array.isArray(mask) ? mask.map(String) : ['all'];
  if (list.indexOf('all') >= 0) return { hitsBall: true, hitsPlayer: 'all' };
  const red = list.indexOf('red') >= 0;
  const blue = list.indexOf('blue') >= 0;
  return {
    hitsBall: list.indexOf('ball') >= 0,
    hitsPlayer: red && blue ? 'all' : red ? 'red' : blue ? 'blue' : 'none',
  };
}

function hitsTeam(mask, team) {
  return mask === 'all' || mask === team;
}

/* HaxBall's curved walls: the arc of a circle through both ends, bulging to
   the left of v0 -> v1 when the curve is positive — left in a y-down world
   being (dy, -dx) — with `curve` the whole swept angle in degrees.  The kick
   off circles and the goal nets of the shipped maps are all built from
   these, so the sign convention is not a detail: get it backwards and the
   barrier ends up guarding the wrong half of the pitch. */
function makeArc(s) {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = Math.hypot(dx, dy);
  if (!(len > 0.001)) return null;

  const half = (Math.abs(s.curve) * Math.PI) / 360;
  const sin = Math.sin(half);
  if (!(Math.abs(sin) > 1e-4)) return null;

  const r = len / (2 * sin);
  const h = r * Math.cos(half);
  const ux = dy / len;
  const uy = -dx / len;
  const sign = s.curve > 0 ? 1 : -1;
  const cx = (s.x1 + s.x2) / 2 - ux * h * sign;
  const cy = (s.y1 + s.y2) / 2 - uy * h * sign;

  const a0 = Math.atan2(s.y1 - cy, s.x1 - cx);
  const a1 = Math.atan2(s.y2 - cy, s.x2 - cx);
  const TAU = Math.PI * 2;
  let span = a1 - a0;
  if (s.curve > 0) { while (span < 0) span += TAU; } else { while (span > 0) span -= TAU; }

  return { cx, cy, r, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, a0, span, up: s.curve > 0 };
}

// Is the direction `angle` (seen from the arc's centre) inside its sweep?
function arcCovers(arc, angle) {
  const TAU = Math.PI * 2;
  let rel = angle - arc.a0;
  if (arc.up) { while (rel < 0) rel += TAU; } else { while (rel > 0) rel -= TAU; }
  return arc.up ? rel <= arc.span + 1e-9 : rel >= arc.span - 1e-9;
}

/* A wall of a built-in pitch.  bCoef 0.5 is what every built-in surface has
   always bounced with; a loaded map brings its own numbers. */
function wallSeg(x1, y1, x2, y2, extra) {
  const seg = {
    x1, y1, x2, y2, curve: 0, bCoef: 0.5,
    hitsBall: true, hitsPlayer: 'all',
    ko: null, vis: false, color: '#ffffff', thickness: 2.5,
  };
  if (extra) Object.assign(seg, extra);
  return seg;
}

/* Precompute what the collision code and the renderer both want: goal
   normals, the circle behind every curved wall, and a bounding box per wall
   so a disc only ever pays for the walls that are anywhere near it. */
function finishStadium(st) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  st.goals = st.goals.filter((g) => Math.hypot(g.x2 - g.x1, g.y2 - g.y1) > 1);
  for (const g of st.goals) {
    const dx = g.x2 - g.x1;
    const dy = g.y2 - g.y1;
    const len = Math.hypot(dx, dy);
    g.len = len;
    g.tx = dx / len;
    g.ty = dy / len;
    // The net is always on the far side, so the outward normal is the
    // tangent turned away from the middle of the pitch.
    let nx = g.ty;
    let ny = -g.tx;
    if (nx * ((g.x1 + g.x2) / 2) + ny * ((g.y1 + g.y2) / 2) < 0) { nx = -nx; ny = -ny; }
    g.nx = nx;
    g.ny = ny;
    g.scoredBy = g.team === 'red' ? 1 : 0;
    grow(g.x1, g.y1);
    grow(g.x2, g.y2);
  }

  for (const s of st.segs) {
    s.arc = s.curve ? makeArc(s) : null;
    if (s.arc) {
      // The arc's own extent: its ends, plus any of the four extreme points
      // of its circle the arc actually sweeps through.  Taking the whole
      // circle instead would drag the bounds — and with them the camera —
      // far past a shallowly curved wall.
      s.minX = Math.min(s.x1, s.x2);
      s.maxX = Math.max(s.x1, s.x2);
      s.minY = Math.min(s.y1, s.y2);
      s.maxY = Math.max(s.y1, s.y2);
      for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        if (!arcCovers(s.arc, angle)) continue;
        const px = s.arc.cx + Math.cos(angle) * s.arc.r;
        const py = s.arc.cy + Math.sin(angle) * s.arc.r;
        s.minX = Math.min(s.minX, px);
        s.maxX = Math.max(s.maxX, px);
        s.minY = Math.min(s.minY, py);
        s.maxY = Math.max(s.maxY, py);
      }
    } else {
      s.minX = Math.min(s.x1, s.x2);
      s.maxX = Math.max(s.x1, s.x2);
      s.minY = Math.min(s.y1, s.y2);
      s.maxY = Math.max(s.y1, s.y2);
    }
    grow(s.minX, s.minY);
    grow(s.maxX, s.maxY);
  }

  for (const p of st.posts) {
    grow(p.x - p.radius, p.y - p.radius);
    grow(p.x + p.radius, p.y + p.radius);
  }

  st.bounds = {
    minX: (isFinite(minX) ? minX : -400) - 20,
    maxX: (isFinite(maxX) ? maxX : 400) + 20,
    minY: (isFinite(minY) ? minY : -200) - 20,
    maxY: (isFinite(maxY) ? maxY : 200) + 20,
  };

  // The pitch proper: the ball area of a loaded map when it states one, and
  // otherwise whatever the geometry reaches out to.
  const halfW = st.pitch && st.pitch.halfW ? st.pitch.halfW : Math.min(st.bounds.maxX, -st.bounds.minX);
  const halfH = st.pitch && st.pitch.halfH ? st.pitch.halfH : Math.min(st.bounds.maxY, -st.bounds.minY);
  st.pitch = Object.assign({ circle: 80 }, st.pitch, { halfW, halfH });
  return st;
}

/* The kick off barrier: the halfway line either side of the centre circle,
   plus the half of that circle which belongs to the team being held back.

   `ko` says when a wall is solid.  undefined is "always", 'both' is "while a
   kick off is being taken", and a team name is "while that team is taking it"
   — the halfway line stands for both sides, the half circle only for the one
   that is not kicking off.  A loaded map tags the same walls with its
   kickOffBarrier trait and redKO / blueKO collision groups. */
function barrierSegs(halfH, circle) {
  return [
    wallSeg(0, -halfH, 0, -circle, { hitsBall: false, ko: 'both' }),
    wallSeg(0, circle, 0, halfH, { hitsBall: false, ko: 'both' }),
    // The left hand arc guards the left half for a blue kick off, and the
    // right hand one the right half for a red kick off.
    wallSeg(0, circle, 0, -circle, { curve: 180, ko: 'blue', hitsBall: false }),
    wallSeg(0, circle, 0, -circle, { curve: -180, ko: 'red', hitsBall: false }),
  ];
}

const stadiumCache = new Map();

function builtInStadium(key) {
  if (stadiumCache.has(key)) return stadiumCache.get(key);

  const m = MAPS[key];
  const segs = [];
  const posts = [];

  for (const sy of [-1, 1]) segs.push(wallSeg(-m.halfW, sy * m.halfH, m.halfW, sy * m.halfH));

  for (const s of [-1, 1]) {
    const line = s * m.halfW;
    const back = s * (m.halfW + m.goalDepth);
    // The touchline only exists outside the goal mouth; the net closes the
    // gap behind it.
    segs.push(wallSeg(line, -m.halfH, line, -m.goalHalfH));
    segs.push(wallSeg(line, m.goalHalfH, line, m.halfH));
    segs.push(wallSeg(back, -m.goalHalfH, back, m.goalHalfH));
    segs.push(wallSeg(line, -m.goalHalfH, back, -m.goalHalfH));
    segs.push(wallSeg(line, m.goalHalfH, back, m.goalHalfH));
    for (const sy of [-1, 1]) posts.push({ x: line, y: sy * m.goalHalfH, radius: 0, bCoef: 0.5 });
  }

  segs.push(...barrierSegs(m.halfH, m.centreCircle));

  const st = finishStadium({
    key,
    label: m.label,
    custom: false,
    segs,
    posts,
    planes: [],
    goals: [
      { team: 'red', x1: -m.halfW, y1: -m.goalHalfH, x2: -m.halfW, y2: m.goalHalfH },
      { team: 'blue', x1: m.halfW, y1: -m.goalHalfH, x2: m.halfW, y2: m.goalHalfH },
    ],
    spawn: { x: m.spawnX, spreadX: 40, spreadY: 46 },
    pitch: { halfW: m.halfW, halfH: m.halfH, circle: m.centreCircle },
    ball: { radius: BALL_PHYS.radius, color: '#ffffff' },
    player: {
      accel: PLAYER_PHYS.accel,
      kickingAccel: PLAYER_PHYS.kickingAccel,
      kickStrength: PLAYER_PHYS.kickStrength,
    },
  });

  st.bounds = {
    minX: -(m.halfW + m.goalDepth),
    maxX: m.halfW + m.goalDepth,
    minY: -m.halfH,
    maxY: m.halfH,
  };

  stadiumCache.set(key, st);
  return st;
}

/* --------------------------- HaxBall .hbs maps ------------------------ */

const finite = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function cleanColour(v, fallback) {
  if (typeof v !== 'string' || !v.length || v.length > 32) return fallback;
  if (!/^[#0-9a-zA-Z(),.% -]+$/.test(v)) return fallback;
  return v[0] === '#' ? v : '#' + v;
}

/* HaxBall writes colours as a bare hex string ("718C5A"), but a map that has
   been through a converter can just as well hold a number.  Both are taken;
   anything else leaves the caller's default in place. */
function hbsColour(v, fallback) {
  if (typeof v === 'number' && isFinite(v)) {
    return '#' + (Math.abs(Math.round(v)) & 0xffffff).toString(16).padStart(6, '0');
  }
  return cleanColour(v, fallback);
}

/* The three grounds HaxBall's editor offers.  Anything else is treated as
   "the map did not say", which leaves the client on its own default. */
function cleanGroundType(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim().toLowerCase();
  return t === 'grass' || t === 'hockey' || t === 'none' ? t : '';
}

function cleanCoord(v) {
  const n = finite(v);
  return n === null || Math.abs(n) > 20000 ? null : n;
}

/* Turn a HaxBall stadium — the object a .hbs file holds — into our geometry.
   The client parses the file and hands the object over, so none of it is
   trusted: every number is checked, every list is capped, and a map that
   cannot be played is refused with a message the host can read. */
function normalizeHbs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('That is not a HaxBall map file.');
  }
  const vertsIn = raw.vertexes;
  const segsIn = raw.segments;
  if (!Array.isArray(vertsIn) || !Array.isArray(segsIn)) {
    throw new Error('That map has no vertexes or segments.');
  }
  if (vertsIn.length > HBS_LIMITS.vertexes) throw new Error('That map has too many vertexes.');
  if (segsIn.length > HBS_LIMITS.segments) throw new Error('That map has too many segments.');

  const traits = raw.traits && typeof raw.traits === 'object' && !Array.isArray(raw.traits) ? raw.traits : {};

  const point = (v) => {
    if (!v || typeof v !== 'object') return null;
    const x = cleanCoord(v.x);
    const y = cleanCoord(v.y);
    return x === null || y === null ? null : { x, y };
  };

  const verts = vertsIn.map(point);

  // Segment fields win over vertex fields, which win over the trait's.
  function traitName(seg, vert) {
    return (seg && typeof seg.trait === 'string' && seg.trait)
      || (vert && typeof vert.trait === 'string' && vert.trait) || '';
  }
  function pick(key, seg, vert) {
    if (seg && seg[key] !== undefined) return seg[key];
    if (vert && vert[key] !== undefined) return vert[key];
    const name = traitName(seg, vert);
    const trait = name && traits[name] && typeof traits[name] === 'object' ? traits[name] : null;
    return trait && trait[key] !== undefined ? trait[key] : undefined;
  }

  const segs = [];
  for (const s of segsIn) {
    if (!s || typeof s !== 'object') continue;
    const v0 = Number.isInteger(s.v0) && s.v0 >= 0 && s.v0 < verts.length ? verts[s.v0] : null;
    const v1 = Number.isInteger(s.v1) && s.v1 >= 0 && s.v1 < verts.length ? verts[s.v1] : null;
    if (!v0 || !v1) continue;

    const mask = maskInfo(pick('cMask', s, v0) !== undefined ? pick('cMask', s, v0) : ['all']);
    const groups = pick('cGroup', s, v0);
    // A kickOffBarrier segment is one of the walls that hold a team back while
    // a kick off is being taken.  redKO / blueKO name the side it belongs to;
    // without one it is the halfway line and stands for both.
    let ko = null;
    if (traitName(s, v0) === 'kickOffBarrier') ko = 'both';
    if (Array.isArray(groups)) {
      const red = groups.indexOf('redKO') >= 0;
      const blue = groups.indexOf('blueKO') >= 0;
      if (red !== blue) ko = red ? 'red' : 'blue';
    }

    let curve = finite(s.curve);
    if (curve === null) curve = 0;
    curve = clamp(curve, -359, 359);

    const bCoef = finite(pick('bCoef', s, v0));
    segs.push({
      x1: v0.x, y1: v0.y, x2: v1.x, y2: v1.y,
      curve,
      bCoef: bCoef === null ? 0.5 : clamp(bCoef, 0, 3),
      hitsBall: mask.hitsBall,
      hitsPlayer: mask.hitsPlayer,
      ko,
      vis: pick('vis', s, v0) !== false,
      color: hbsColour(pick('color', s, v0), '#ffffff'),
      thickness: clamp(finite(pick('radius', s, v0)) || 2.5, 0.6, 20),
    });
  }

  const goals = [];
  if (raw.goals !== undefined && !Array.isArray(raw.goals)) throw new Error('That map has a broken goal list.');
  const goalsIn = Array.isArray(raw.goals) ? raw.goals : [];
  if (goalsIn.length > HBS_LIMITS.goals) throw new Error('That map has too many goals.');
  for (const g of goalsIn) {
    if (!g || typeof g !== 'object') continue;
    const p0 = Array.isArray(g.p0) ? { x: cleanCoord(g.p0[0]), y: cleanCoord(g.p0[1]) } : null;
    const p1 = Array.isArray(g.p1) ? { x: cleanCoord(g.p1[0]), y: cleanCoord(g.p1[1]) } : null;
    const team = g.team === 'red' || g.team === 'blue' ? g.team : null;
    if (!team || !p0 || !p1 || p0.x === null || p0.y === null || p1.x === null || p1.y === null) continue;
    goals.push({ team, x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y });
  }
  if (!goals.some((g) => g.team === 'red') || !goals.some((g) => g.team === 'blue')) {
    throw new Error('That map has no goals to play into.');
  }

  const posts = [];
  const discsIn = Array.isArray(raw.discs) ? raw.discs : [];
  if (discsIn.length > HBS_LIMITS.discs) throw new Error('That map has too many discs.');
  for (const d of discsIn) {
    if (!d || typeof d !== 'object') continue;
    const pos = Array.isArray(d.pos) ? { x: cleanCoord(d.pos[0]), y: cleanCoord(d.pos[1]) } : null;
    if (!pos || pos.x === null || pos.y === null) continue;
    const radius = finite(pick('radius', d, null));
    const bCoef = finite(pick('bCoef', d, null));
    posts.push({
      x: pos.x,
      y: pos.y,
      radius: clamp(radius === null ? 0 : radius, 0, 60),
      bCoef: bCoef === null ? 0.5 : clamp(bCoef, 0, 3),
      color: hbsColour(pick('color', d, null), '#ffffff'),
      vis: pick('vis', d, null) !== false,
    });
  }

  const planes = [];
  const planesIn = Array.isArray(raw.planes) ? raw.planes : [];
  if (planesIn.length > HBS_LIMITS.planes) throw new Error('That map has too many planes.');
  for (const p of planesIn) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.normal)) continue;
    const nx = finite(p.normal[0]);
    const ny = finite(p.normal[1]);
    const dist = finite(p.dist);
    if (nx === null || ny === null || dist === null) continue;
    const len = Math.hypot(nx, ny);
    if (!(len > 0.001)) continue;
    const mask = maskInfo(pick('cMask', p, null) !== undefined ? pick('cMask', p, null) : ['all']);
    planes.push({
      nx: nx / len,
      ny: ny / len,
      dist: clamp(dist / len, -20000, 20000),
      bCoef: clamp(finite(pick('bCoef', p, null)) || 0.5, 0, 3),
      hitsBall: mask.hitsBall,
      hitsPlayer: mask.hitsPlayer,
    });
  }

  const bg = raw.bg && typeof raw.bg === 'object' ? raw.bg : {};
  const bgHalfW = finite(bg.width);
  const bgHalfH = finite(bg.height);
  const circle = clamp(finite(bg.kickOffRadius) || 80, 10, 600);

  const ballPhysics = raw.ballPhysics && typeof raw.ballPhysics === 'object' ? raw.ballPhysics : {};
  const playerPhysics = raw.playerPhysics && typeof raw.playerPhysics === 'object' ? raw.playerPhysics : {};

  const st = finishStadium({
    key: CUSTOM_MAP,
    label: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_MAP_NAME) : 'Custom map',
    custom: true,
    segs,
    posts,
    planes,
    goals,
    pitch: {
      halfW: clamp(bgHalfW === null ? 0 : bgHalfW, 0, 20000) || null,
      halfH: clamp(bgHalfH === null ? 0 : bgHalfH, 0, 20000) || null,
      circle,
      // What the map wants drawn under its lines.  `type` is HaxBall's own
      // grass / hockey / none, which the client turns into a ground colour of
      // its own; `color` overrides that outright, for maps that name one.
      // Without either the pitch keeps the green the built-in ones wear.
      type: cleanGroundType(bg.type),
      color: hbsColour(bg.color, '') ||
        hbsColour(bg.groundColor, '') ||
        hbsColour(bg.grassColor, '') ||
        hbsColour(bg.bgColor, ''),
      corner: clamp(finite(bg.cornerRadius) || 0, 0, 400),
    },
    ball: {
      radius: clamp(finite(ballPhysics.radius) === null ? BALL_PHYS.radius : ballPhysics.radius, 4, 24),
      color: cleanColour(ballPhysics.color, '#ffffff'),
    },
    player: {
      accel: clamp(finite(playerPhysics.acceleration) === null ? PLAYER_PHYS.accel : playerPhysics.acceleration, 0.02, 0.4),
      kickingAccel: clamp(finite(playerPhysics.kickingAcceleration) === null ? PLAYER_PHYS.kickingAccel : playerPhysics.kickingAcceleration, 0.02, 0.4),
      kickStrength: clamp(finite(playerPhysics.kickStrength) === null ? PLAYER_PHYS.kickStrength : playerPhysics.kickStrength, 0, 20),
    },
  });

  // Spawns sit behind the kick off line, in the team's own half.  A map
  // states the distance; anything silly is pulled back to something sane.
  const halfPitch = st.pitch.halfW;
  const stated = finite(raw.spawnDistance);
  st.spawn = {
    x: clamp(stated === null || stated <= 0 ? halfPitch * 0.28 : stated, halfPitch * 0.12, halfPitch * 0.5),
    spreadX: 40,
    spreadY: 46,
  };
  return st;
}

function stadiumFor(room) {
  if (room.map === CUSTOM_MAP && room.stadium) return room.stadium;
  return builtInStadium(MAPS[room.map] ? room.map : 'medium');
}

/* What the client needs to draw a loaded map.  Built-in pitches are drawn
   from MAPS, so this only ever travels for a custom one. */
function publicStadium(st) {
  return {
    key: st.key,
    label: st.label,
    segs: st.segs.map((s) => ({
      x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, curve: s.curve,
      vis: s.vis, color: s.color, thickness: s.thickness, ko: s.ko,
    })),
    posts: st.posts.map((p) => ({ x: p.x, y: p.y, radius: p.radius, color: p.color, vis: p.vis })),
    goals: st.goals.map((g) => ({ x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, team: g.team })),
    bounds: st.bounds,
    pitch: st.pitch,
    ball: st.ball,
  };
}

/* ------------------------------ phases ------------------------------- */

const WAITING = 'waiting';   // not enough players on both teams
const KICKOFF = 'kickoff';   // barrier up, kicker plays the ball away
const PLAYING = 'playing';
const GOAL = 'goal';         // celebration, play carries on
const ENDED = 'ended';

// The kick off barrier stays up until the ball is touched and not a tick
// longer.  There is no timeout on purpose: the barrier is what stops the
// other team from closing the kicker down, so it must never drop on its own
// and hand them the ball.  The client shows whose kick off it is, so the
// room can always see why play has not started.
// How long the ball is left in the net before the restart.  The players are
// never frozen — only the goal mouth is off limits — so this is short.
const GOAL_DELAY = 0.9;

// Matches are started by the host from the room panel, the way HaxBall does
// it, so there is no ready-timer: the room simply sits in WAITING until an
// admin asks for kick off.

/* The team taking the kick off, or '' while the barrier is down. */
function barrierTeam(room) {
  return room.phase === KICKOFF && room.koTeam ? room.koTeam : '';
}

/* ===================================================================== *
 *  Math helpers
 * ===================================================================== */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function round3(v) { return Math.round(v * 1000) / 1000; }

// A disc is anything with x, y, vx, vy, radius and invMass.
function disc(x, y, radius, invMass, vx, vy) {
  return { x, y, vx: vx || 0, vy: vy || 0, radius, invMass, lastTouch: 0 };
}

/* ===================================================================== *
 *  Collision response
 *
 *  Two discs, solved the way Box2D solves them: push apart along the
 *  normal by an amount weighted by inverse mass, then apply a single
 *  normal impulse with restitution.
 * ===================================================================== */

function resolveDiscs(a, b, restitution) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  const minDist = a.radius + b.radius;
  if (d >= minDist) return false;

  if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6; }
  const nx = dx / d;
  const ny = dy / d;

  const invSum = a.invMass + b.invMass;
  if (invSum <= 0) return false;

  const penetration = minDist - d;
  const correction = (penetration / invSum) * 0.9;
  a.x -= nx * correction * a.invMass;
  a.y -= ny * correction * a.invMass;
  b.x += nx * correction * b.invMass;
  b.y += ny * correction * b.invMass;

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;
  if (vn > 0) return true;                     // already separating

  const j = (-(1 + restitution) * vn) / invSum;
  a.vx -= nx * j * a.invMass;
  a.vy -= ny * j * a.invMass;
  b.vx += nx * j * b.invMass;
  b.vy += ny * j * b.invMass;
  return true;
}

/* ===================================================================== *
 *  Stadium collision
 *
 *  Every wall is a line, or an arc, with no thickness: a disc is inside it
 *  when its centre is nearer than its own radius.  That is only safe while
 *  no disc is ever moved further than half its radius between two calls —
 *  stepBall slices for exactly that reason, and a player never travels more
 *  than a couple of units a tick — so the push direction is always the side
 *  the disc came from and nothing can be shoved through a wall.
 * ===================================================================== */

// Nearest point of a wall to (x, y): on the line, on the arc, or an end.
function closestOnSeg(s, x, y) {
  if (s.arc) {
    const a = s.arc;
    const dx = x - a.cx;
    const dy = y - a.cy;
    const dist = Math.hypot(dx, dy);
    if (dist > 1e-9 && arcCovers(a, Math.atan2(dy, dx))) {
      return { x: a.cx + (dx / dist) * a.r, y: a.cy + (dy / dist) * a.r };
    }
    const d0 = Math.hypot(x - a.x1, y - a.y1);
    const d1 = Math.hypot(x - a.x2, y - a.y2);
    return d0 <= d1 ? { x: a.x1, y: a.y1 } : { x: a.x2, y: a.y2 };
  }

  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((x - s.x1) * dx + (y - s.y1) * dy) / len2, 0, 1) : 0;
  return { x: s.x1 + dx * t, y: s.y1 + dy * t };
}

/* Move a disc to a full radius away from a surface and bounce it off.
   `surfaceRadius` lets the same code place the goal posts, which are discs
   rather than walls. */
function pushOutOf(d, cx, cy, restitution, surfaceRadius) {
  const minDist = d.radius + (surfaceRadius || 0);
  let nx = d.x - cx;
  let ny = d.y - cy;
  const dist = Math.hypot(nx, ny);
  if (dist >= minDist) return false;

  if (dist < 1e-9) {
    // Dead centre on the surface: nudge it inwards, which is where play is.
    const len = Math.hypot(d.x, d.y) || 1;
    nx = -d.x / len;
    ny = -d.y / len;
  } else {
    nx /= dist;
    ny /= dist;
  }

  d.x = cx + nx * minDist;
  d.y = cy + ny * minDist;

  const vn = d.vx * nx + d.vy * ny;
  if (vn < 0) {
    d.vx -= (1 + restitution) * vn * nx;
    d.vy -= (1 + restitution) * vn * ny;
  }
  return true;
}

/* One disc against the whole stadium.  `barrier` is the team taking the kick
   off — '' or null when the barrier is down — and only the walls tagged for
   that team's kick off are solid. */
function collideStadium(d, st, restitution, team, isBall, barrier) {
  for (const p of st.planes) {
    if (isBall ? !p.hitsBall : !hitsTeam(p.hitsPlayer, team)) continue;
    const dot = d.x * p.nx + d.y * p.ny;
    if (dot - d.radius >= p.dist) continue;
    const push = p.dist + d.radius - dot;
    d.x += p.nx * push;
    d.y += p.ny * push;
    const vn = d.vx * p.nx + d.vy * p.ny;
    if (vn < 0) {
      d.vx -= (1 + p.bCoef) * vn * p.nx;
      d.vy -= (1 + p.bCoef) * vn * p.ny;
    }
  }

  for (const s of st.segs) {
    // A kick off wall is only solid while the kick off it belongs to is being
    // taken: 'both' stands for the halfway line, a team name for the half
    // circle that holds that team's opponents back.
    if (s.ko === 'both' ? !barrier : (s.ko && s.ko !== barrier)) continue;
    if (isBall ? !s.hitsBall : !hitsTeam(s.hitsPlayer, team)) continue;
    if (d.x + d.radius < s.minX || d.x - d.radius > s.maxX
      || d.y + d.radius < s.minY || d.y - d.radius > s.maxY) continue;
    const c = closestOnSeg(s, d.x, d.y);
    pushOutOf(d, c.x, c.y, s.bCoef === undefined ? restitution : s.bCoef);
  }

  for (const post of st.posts) {
    pushOutOf(d, post.x, post.y, post.bCoef === undefined ? restitution : post.bCoef, post.radius);
  }
}

/* A goal counts once the whole ball is past the line and inside the mouth.
   The team that scores is the one the goal is not defended by. */
function ballInGoal(st, ball) {
  for (const g of st.goals) {
    const dx = ball.x - g.x1;
    const dy = ball.y - g.y1;
    const along = dx * g.tx + dy * g.ty;
    if (along < 0 || along > g.len) continue;
    if (dx * g.nx + dy * g.ny > ball.radius) return g.scoredBy;
  }
  return -1;
}

/* ===================================================================== *
 *  Simulation
 * ===================================================================== */

function stepPlayer(p, phys) {
  const input = p.input || {};
  let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  p.kicking = !!input.kick;

  if (dx !== 0 || dy !== 0) {
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;

    const accel = p.kicking ? phys.kickingAccel : phys.accel;
    const speed = Math.hypot(p.vx, p.vy);
    // HaxBall only pushes you forward while you are under the cap, or while
    // you are already travelling against the direction you are asking for.
    if (speed < PLAYER_SPEED_CAP || (p.vx * dx + p.vy * dy) < 0) {
      p.vx += dx * accel;
      p.vy += dy * accel;
    }
  }

  const damping = p.kicking ? PLAYER_PHYS.kickingDamping : PLAYER_PHYS.damping;
  p.vx *= damping;
  p.vy *= damping;

  const speed = Math.hypot(p.vx, p.vy);
  if (speed > PLAYER_SPEED_CAP) {
    p.vx = (p.vx / speed) * PLAYER_SPEED_CAP;
    p.vy = (p.vy / speed) * PLAYER_SPEED_CAP;
  }

  p.x += p.vx;
  p.y += p.vy;
}

function stepBall(room, st) {
  const ball = room.ball;
  ball.vx *= BALL_PHYS.damping;
  ball.vy *= BALL_PHYS.damping;

  const speed = Math.hypot(ball.vx, ball.vy);
  // Move in slices no larger than three quarters of the ball's radius.  That
  // is what lets the walls be lines with no thickness — a disc that starts a
  // slice on a wall and is pushed back onto it never ends that slice past the
  // wall's middle — and what stops a fast ball tunnelling through a goal post
  // or a net.
  const slices = Math.max(1, Math.ceil(speed / (ball.radius * 0.75)));
  const inv = 1 / slices;
  for (let i = 0; i < slices; i++) {
    ball.x += ball.vx * inv;
    ball.y += ball.vy * inv;
    collideStadium(ball, st, BALL_PHYS.bCoef, '', true, barrierTeam(room));
  }
}

/* A kicked ball remembers who kicked it: that is how an own goal is told
   apart from a normal one.  Returns true when the ball was actually hit. */
function applyKicks(room, phys) {
  const ball = room.ball;
  let kicked = false;
  for (const p of room.players.values()) {
    if (!p.onPitch || !p.kicking) continue;

    const dx = ball.x - p.x;
    const dy = ball.y - p.y;
    const dist = Math.hypot(dx, dy) || 1e-6;
    if (dist > p.radius + ball.radius + KICK_REACH) continue;

    const nx = dx / dist;
    const ny = dy / dist;

    // Don't keep injecting energy into a ball that is already leaving faster
    // than this kick could send it.
    const rvx = ball.vx - p.vx;
    const rvy = ball.vy - p.vy;
    if (rvx * nx + rvy * ny > phys.kickStrength) continue;

    ball.vx += nx * phys.kickStrength;
    ball.vy += ny * phys.kickStrength;
    ball.lastTouch = p.id;
    kicked = true;

    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > BALL_SPEED_CAP) {
      ball.vx = (ball.vx / speed) * BALL_SPEED_CAP;
      ball.vy = (ball.vy / speed) * BALL_SPEED_CAP;
    }
  }
  return kicked;
}

function simulate(room, st, allowGoals) {
  const ball = room.ball;
  const phys = st.player;
  const barrier = barrierTeam(room);
  const active = [];
  for (const p of room.players.values()) {
    if (p.onPitch) active.push(p);
  }

  for (const p of active) stepPlayer(p, phys);
  stepBall(room, st);

  let touched = false;

  // Three relaxation passes settles the pile-ups you get at kickoff.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        resolveDiscs(active[i], active[j], PLAYER_PHYS.bCoef);
      }
    }
    for (let i = 0; i < active.length; i++) {
      if (resolveDiscs(active[i], ball, PLAYER_PHYS.bCoef)) {
        ball.lastTouch = active[i].id;
        touched = true;
      }
    }
  }

  for (const p of active) collideStadium(p, st, PLAYER_PHYS.bCoef, p.team, false, barrier);
  collideStadium(ball, st, BALL_PHYS.bCoef, '', true, barrier);

  if (applyKicks(room, phys)) touched = true;

  // The barrier comes down the moment the ball is played, so the team that
  // conceded gets its kick off away before anyone can close it down.
  if (barrier && touched) room.kickoffTouched = true;

  if (ball.vx || ball.vy) {
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > BALL_SPEED_CAP) {
      ball.vx = (ball.vx / speed) * BALL_SPEED_CAP;
      ball.vy = (ball.vy / speed) * BALL_SPEED_CAP;
    }
  }

  return allowGoals ? ballInGoal(st, ball) : -1;
}

/* ===================================================================== *
 *  Rooms
 * ===================================================================== */

const rooms = new Map();
const bannedAddresses = new Set();
let nextPlayerId = 1;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
    }
  } while (rooms.has(code));
  return code;
}

function cleanNick(nick) {
  const cleaned = String(nick == null ? '' : nick)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, MAX_NICK_LEN);
  return cleaned || 'Player';
}

/* A player's ball image, or '' when it is missing, oversized or not an image
   data URL.  Only the four raster formats are accepted — nothing that could
   be used to smuggle markup into the page. */
function cleanAvatar(data) {
  if (typeof data !== 'string') return '';
  if (!data || data.length > MAX_AVATAR_LEN) return '';
  return AVATAR_RE.test(data) ? data : '';
}

function createRoom(options) {
  const mapKey = MAPS[options.map] ? options.map : 'medium';
  const code = makeRoomCode();
  const room = {
    code,
    name: String(options.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 28) || ('Room ' + code),
    password: String(options.password || '').slice(0, 24),
    maxPlayers: clamp(parseInt(options.maxPlayers, 10) || 8, 2, 24),
    map: mapKey,
    stadium: null,        // set when the host loads a .hbs map
    timeLimit: clamp(parseInt(options.timeLimit, 10) || 0, 0, 60),   // minutes, 0 = no limit
    scoreLimit: clamp(parseInt(options.scoreLimit, 10) || 0, 0, 50), // 0 = no limit
    phase: WAITING,
    teamsLocked: false,   // "Lock" in the room panel: nobody may switch teams
    hostId: 0,            // whoever opened the room: an admin nobody can demote
    players: new Map(),
    ball: disc(0, 0, BALL_PHYS.radius, BALL_PHYS.invMass),
    score: [0, 0],
    timeLeft: 0,
    elapsed: 0,
    phaseTimer: 0,
    koTeam: '',           // who is taking the kick off
    kickoffTouched: false,
    conceded: 'red',      // whoever let the last goal in takes the kick off
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  room.ball.radius = stadiumFor(room).ball.radius;
  rooms.set(code, room);
  return room;
}

function playersOn(room, team) {
  const out = [];
  for (const p of room.players.values()) if (p.team === team) out.push(p);
  return out;
}

function teamCounts(room) {
  let red = 0, blue = 0;
  for (const p of room.players.values()) {
    if (p.team === 'red') red++;
    else if (p.team === 'blue') blue++;
  }
  return { red, blue };
}

function onPitchCount(room) { const c = teamCounts(room); return c.red + c.blue; }

function autoTeam(room) {
  // A locked room only ever takes spectators, so the teams stay as they are.
  if (room.teamsLocked) return 'spec';
  const { red, blue } = teamCounts(room);
  return red <= blue ? 'red' : 'blue';
}

function refreshPitchFlags(room) {
  for (const p of room.players.values()) {
    p.onPitch = p.team === 'red' || p.team === 'blue';
  }
}

/* Move one player to another team.  Returns false when the move is refused,
   which happens when the target team is already at its share of the room. */
function movePlayer(room, player, team) {
  if (!player || team === player.team) return false;
  const counts = teamCounts(room);
  if (team === 'red' || team === 'blue') {
    if (counts[team] >= Math.ceil(room.maxPlayers / 2) + 1) return false;
  }

  setTeam(player, team);
  refreshPitchFlags(room);
  placeTeams(room);
  broadcastInfo(room);
  broadcastChat(room, '', player.nick + ' is now ' + (team === 'spec' ? 'a spectator' : team.toUpperCase()), '', true);
  return true;
}

function setTeam(player, team) {
  player.team = team;
  player.vx = 0;
  player.vy = 0;
  player.input = {};
  player.kicking = false;
}

/* Re-spawn, re-flag and re-publish after a batch of setTeam() calls. */
function applyRoster(room, note) {
  refreshPitchFlags(room);
  placeTeams(room);
  broadcastInfo(room);
  if (note) broadcastChat(room, '', note, '', true);
}

/* "Auto": bring spectators in until the sides are level, then hand any
   remaining surplus from the bigger side over to the smaller one. */
function autoBalance(room) {
  const red = playersOn(room, 'red');
  const blue = playersOn(room, 'blue');
  const spec = playersOn(room, 'spec');

  while (spec.length && red.length !== blue.length) {
    const p = spec.shift();
    if (red.length < blue.length) { red.push(p); setTeam(p, 'red'); }
    else { blue.push(p); setTeam(p, 'blue'); }
  }
  while (red.length - blue.length > 1) {
    const p = red.pop();
    blue.push(p);
    setTeam(p, 'blue');
  }
  while (blue.length - red.length > 1) {
    const p = blue.pop();
    red.push(p);
    setTeam(p, 'red');
  }
}

/* "Rand": shuffle everyone who is on the pitch between the two sides. */
function shuffleTeams(room) {
  const pool = playersOn(room, 'red').concat(playersOn(room, 'blue'));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const swap = pool[i];
    pool[i] = pool[j];
    pool[j] = swap;
  }
  pool.forEach((p, i) => setTeam(p, i % 2 === 0 ? 'red' : 'blue'));
}

function placeTeams(room) {
  const st = stadiumFor(room);
  const spawn = st.spawn;
  for (const side of ['red', 'blue']) {
    const list = playersOn(room, side);
    const dir = side === 'red' ? -1 : 1;
    const rows = Math.ceil(list.length / 2);
    list.forEach((p, i) => {
      const column = i % 2;
      const row = Math.floor(i / 2);
      p.x = dir * (spawn.x + column * spawn.spreadX);
      p.y = rows <= 1 ? 0 : (-(rows - 1) / 2 + row) * spawn.spreadY;
      p.vx = 0;
      p.vy = 0;
      p.input = {};
    });
  }
  room.ball.x = 0;
  room.ball.y = 0;
  room.ball.vx = 0;
  room.ball.vy = 0;
  room.ball.lastTouch = 0;
}

/* Kick off.  `kicker` is the team that gets the ball: the halfway line and
   the half of the centre circle that belongs to the *other* team turn solid
   until the ball is touched, so nobody can close the kicker down from
   behind the barrier. */
function beginKickoff(room, kicker) {
  placeTeams(room);
  room.phase = KICKOFF;
  room.phaseTimer = 0;
  room.koTeam = kicker === 'blue' ? 'blue' : 'red';
  room.kickoffTouched = false;
}

function startMatch(room) {
  room.score = [0, 0];
  room.timeLeft = room.timeLimit > 0 ? room.timeLimit * 60 : -1;
  room.elapsed = 0;
  beginKickoff(room, 'red');
  broadcast(room, { t: 'started', sc: room.score, ko: room.koTeam });
}

function endMatch(room) {
  room.phase = ENDED;
  room.phaseTimer = 0;
  room.koTeam = '';
  broadcast(room, { t: 'ended', sc: room.score });
}

function backToWaiting(room) {
  room.phase = WAITING;
  room.phaseTimer = 0;
  room.koTeam = '';
  room.score = [0, 0];
  room.timeLeft = 0;
  room.elapsed = 0;
  placeTeams(room);
}

/* ===================================================================== *
 *  Per-tick room update
 * ===================================================================== */

function tickRoom(room) {
  room.lastActivity = Date.now();
  const st = stadiumFor(room);
  const counts = teamCounts(room);

  if (room.phase !== WAITING && (counts.red === 0 || counts.blue === 0)) {
    backToWaiting(room);
    broadcast(room, { t: 'waiting' });
    return;
  }

  switch (room.phase) {
    case WAITING: {
      // The match has not started, so nothing here counts — but the balls
      // still roll so the room feels alive while people pick teams.
      simulate(room, st, false);
      break;
    }

    case KICKOFF: {
      // Nobody is frozen: the kicker can walk the ball up the pitch while
      // the barrier holds the other side back.  The barrier goes as soon as
      // the ball is touched, and the phase with it — never on a timer.
      simulate(room, st, false);
      if (!room.kickoffTouched) break;

      room.phase = PLAYING;
      room.koTeam = '';
      broadcast(room, { t: 'resumed' });
      break;
    }

    case GOAL: {
      // The celebration is not a freeze: the ball keeps rolling and everyone
      // keeps playing while the client animates "Red Scored!".  Goals are
      // switched off here so the same shot cannot be counted twice.
      simulate(room, st, false);
      room.phaseTimer -= DT;
      if (room.phaseTimer > 0) break;

      if (matchIsOver(room)) { endMatch(room); break; }

      // Whoever conceded takes the kick off.
      beginKickoff(room, room.conceded);
      broadcast(room, { t: 'resumed', ko: room.koTeam });
      break;
    }

    case PLAYING: {
      const scorer = simulate(room, st, true);
      if (scorer >= 0) {
        room.score[scorer]++;
        room.conceded = scorer === 0 ? 'blue' : 'red';
        room.phase = GOAL;
        room.phaseTimer = GOAL_DELAY;
        broadcast(room, { t: 'goal', team: scorer, sc: room.score, by: goalAuthor(room, scorer) });
        break;
      }
      if (room.timeLeft > 0) {
        room.timeLeft -= DT;
        if (room.timeLeft <= 0) {
          room.timeLeft = 0;
          endMatch(room);
        }
      }
      room.elapsed += DT;
      break;
    }

    default:
      break;
  }
}

function matchIsOver(room) {
  if (room.scoreLimit > 0 && (room.score[0] >= room.scoreLimit || room.score[1] >= room.scoreLimit)) return true;
  if (room.timeLimit > 0 && room.timeLeft <= 0) return true;
  return false;
}

/* Who gets the credit (or the blame) for a goal.  `scorer` is the team that
   the goal counts for, so a last touch by the other side means the ball went
   into their own net.  Returns null when nobody touched it. */
function goalAuthor(room, scorer) {
  const id = room.ball.lastTouch;
  if (!id) return null;
  const player = room.players.get(id);
  if (!player || !player.onPitch) return null;

  const scoringTeam = scorer === 0 ? 'red' : 'blue';
  return {
    id: player.id,
    nick: player.nick,
    team: player.team,
    own: player.team !== scoringTeam,
  };
}

/* ===================================================================== *
 *  Snapshots
 * ===================================================================== */

function roomInfo(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({ id: p.id, nick: p.nick, team: p.team, admin: !!p.admin, avatar: p.avatar || '' });
  }
  return {
    t: 'room',
    code: room.code,
    name: room.name,
    map: room.map,
    mapLabel: stadiumFor(room).label,
    maxPlayers: room.maxPlayers,
    timeLimit: room.timeLimit,
    scoreLimit: room.scoreLimit,
    locked: !!room.password,
    teamsLocked: !!room.teamsLocked,
    hostId: room.hostId,
    phase: room.phase,
    players,
  };
}

function stateMessage(room) {
  const players = [];
  for (const p of room.players.values()) {
    if (!p.onPitch) continue;
    players.push([
      p.id,
      round3(p.x), round3(p.y),
      round3(p.vx), round3(p.vy),
      p.kicking ? 1 : 0,
    ]);
  }
  const msg = {
    t: 'state',
    ph: room.phase,
    sc: room.score,
    tl: round3(room.timeLeft),
    el: round3(room.elapsed),
    pt: round3(room.phaseTimer),
    b: [round3(room.ball.x), round3(room.ball.y), round3(room.ball.vx), round3(room.ball.vy)],
    p: players,
  };
  // Only a kick off has a barrier, and the client has to know whose it is:
  // the wall across the halfway line is invisible, so whose kick off it is
  // is the only thing telling the room why play has stopped.
  if (room.phase === KICKOFF) msg.ko = room.koTeam;
  return msg;
}

function sendTo(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload) {
  const raw = JSON.stringify(payload);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
  }
}

function broadcastState(room) {
  const raw = JSON.stringify(stateMessage(room));
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
  }
}

function broadcastInfo(room) { broadcast(room, roomInfo(room)); }

/* Which pitch the room plays on.  The built-in ones are drawn from the
   client's own copy of MAPS, so only a loaded map has to travel. */
function sendStadium(ws, room) {
  const st = stadiumFor(room);
  sendTo(ws, { t: 'stadium', stadium: st.custom ? publicStadium(st) : null });
}

function broadcastStadium(room) {
  const st = stadiumFor(room);
  broadcast(room, { t: 'stadium', stadium: st.custom ? publicStadium(st) : null });
}

function broadcastChat(room, nick, text, team, system) {
  broadcast(room, { t: 'chat', nick, text, team: team || '', sys: !!system });
}

function roomList() {
  const list = [];
  for (const room of rooms.values()) {
    const counts = teamCounts(room);
    list.push({
      code: room.code,
      name: room.name,
      players: room.players.size,
      max: room.maxPlayers,
      onPitch: counts.red + counts.blue,
      red: counts.red,
      blue: counts.blue,
      map: stadiumFor(room).label,
      locked: !!room.password,
      phase: room.phase,
      age: Math.floor((Date.now() - room.createdAt) / 1000),
      score: room.score,
    });
  }
  list.sort((a, b) => b.players - a.players || a.age - b.age);
  return list;
}

/* ===================================================================== *
 *  Socket handling
 * ===================================================================== */

/* Who is behind a connection.  A ban is kept against this rather than against
   the socket, which is gone the moment they are removed. */
function clientAddress(ws) {
  const socket = ws && ws._socket;
  return socket && socket.remoteAddress ? socket.remoteAddress : '';
}

/* Take someone out of a room: a kick, a ban and a dropped connection all end
   up here.  `why` is the line the rest of the room reads, and `team` colours
   it.  The socket is closed on the way out, so its own close handler finds
   nothing left to remove. */
function removePlayer(room, target, why, team) {
  if (target.ws) {
    target.ws.room = null;
    target.ws.playerId = 0;
    try { target.ws.close(); } catch (e) { /* ignore */ }
  }
  room.players.delete(target.id);

  // A room whose host has walked out still needs somebody who cannot be
  // locked out of it, so the role passes to the longest-serving player left.
  if (room.hostId === target.id) {
    let next = null;
    for (const p of room.players.values()) if (!next || p.id < next.id) next = p;
    if (next) {
      room.hostId = next.id;
      next.admin = true;
      broadcastChat(room, '', next.nick + ' is the host now', '', true);
    }
  }

  refreshPitchFlags(room);
  broadcast(room, { t: 'left', id: target.id, nick: target.nick });
  broadcastChat(room, '', target.nick + ' ' + why, team || '', true);
  broadcastInfo(room);
  placeTeams(room);
  if (room.players.size === 0) rooms.delete(room.code);
}

function detach(ws) {
  const room = ws.room;
  if (!room) return;
  const player = room.players.get(ws.playerId);
  if (!player || player.ws !== ws) return;

  removePlayer(room, player, 'left the room', player.team);
}

function handleCreate(ws, msg) {
  if (ws.room) detach(ws);

  if (bannedAddresses.has(clientAddress(ws))) {
    return sendTo(ws, { t: 'error', fatal: true, message: 'You have been banned from this server.' });
  }

  const room = createRoom({
    name: msg.name,
    password: msg.password,
    maxPlayers: msg.maxPlayers,
    map: msg.map,
    timeLimit: msg.timeLimit,
    scoreLimit: msg.scoreLimit,
  });

  const player = {
    id: nextPlayerId++,
    nick: cleanNick(msg.nick),
    ws,
    team: autoTeam(room),
    admin: true,
    x: 0, y: 0, vx: 0, vy: 0,
    radius: PLAYER_PHYS.radius,
    invMass: PLAYER_PHYS.invMass,
    input: {},
    kicking: false,
    onPitch: true,
    avatar: cleanAvatar(msg.avatar),
  };
  room.players.set(player.id, player);
  ws.room = room;
  ws.playerId = player.id;
  // The room belongs to whoever opened it: they stay an admin for as long as
  // they are in it, whatever any other admin would like.
  room.hostId = player.id;

  refreshPitchFlags(room);
  placeTeams(room);

  sendTo(ws, { t: 'entered', you: player.id, code: room.code });
  sendStadium(ws, room);
  broadcastInfo(room);
  broadcastChat(room, '', player.nick + ' created the room', '', true);
}

function handleJoin(ws, msg) {
  if (ws.room) detach(ws);

  if (bannedAddresses.has(clientAddress(ws))) {
    return sendTo(ws, { t: 'error', fatal: true, message: 'You have been banned from this server.' });
  }

  const code = String(msg.room || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendTo(ws, { t: 'error', fatal: true, message: 'This room no longer exists.' });
  if (room.password && room.password !== String(msg.password || '')) {
    return sendTo(ws, { t: 'error', code: 'badpass', message: 'Wrong password.' });
  }
  if (room.players.size >= room.maxPlayers) {
    return sendTo(ws, { t: 'error', fatal: true, message: 'This room is full.' });
  }

  const player = {
    id: nextPlayerId++,
    nick: cleanNick(msg.nick),
    ws,
    team: autoTeam(room),
    admin: false,
    x: 0, y: 0, vx: 0, vy: 0,
    radius: PLAYER_PHYS.radius,
    invMass: PLAYER_PHYS.invMass,
    input: {},
    kicking: false,
    onPitch: true,
    avatar: cleanAvatar(msg.avatar),
  };
  room.players.set(player.id, player);
  ws.room = room;
  ws.playerId = player.id;

  refreshPitchFlags(room);
  placeTeams(room);

  sendTo(ws, { t: 'entered', you: player.id, code: room.code });
  sendStadium(ws, room);
  broadcastInfo(room);
  broadcastChat(room, '', player.nick + ' joined', player.team, true);
}

function handleTeam(ws, msg) {
  const room = ws.room;
  if (!room) return;
  const player = room.players.get(ws.playerId);
  if (!player) return;

  const team = msg.team === 'red' || msg.team === 'blue' || msg.team === 'spec' ? msg.team : null;
  if (!team) return;
  if (room.teamsLocked && !player.admin) return;

  movePlayer(room, player, team);
}

function handleAdmin(ws, msg) {
  const room = ws.room;
  if (!room) return;
  const player = room.players.get(ws.playerId);
  if (!player || !player.admin) return;

  switch (msg.action) {
    case 'start': {
      const counts = teamCounts(room);
      if (counts.red > 0 && counts.blue > 0) startMatch(room);
      else sendTo(ws, { t: 'error', message: 'Both teams need at least one player before you can start.' });
      break;
    }
    case 'stop':
      backToWaiting(room);
      broadcast(room, { t: 'waiting' });
      break;
    case 'reset':
      // In the room panel this only clears the scoreboard; during a match it
      // is a full restart.
      if (room.phase === WAITING) {
        room.score = [0, 0];
        placeTeams(room);
      } else {
        room.score = [0, 0];
        room.timeLeft = room.timeLimit > 0 ? room.timeLimit * 60 : -1;
        beginKickoff(room, 'red');
        broadcast(room, { t: 'started', sc: room.score, ko: room.koTeam });
      }
      break;
    case 'move': {
      const target = room.players.get(Number(msg.id));
      const team = msg.team === 'red' || msg.team === 'blue' || msg.team === 'spec' ? msg.team : null;
      if (target && team) movePlayer(room, target, team);
      break;
    }
    case 'auto':
      autoBalance(room);
      applyRoster(room, 'Teams were balanced by the host');
      break;
    case 'rand':
      shuffleTeams(room);
      applyRoster(room, 'Teams were shuffled by the host');
      break;
    case 'lock':
      room.teamsLocked = msg.locked == null ? !room.teamsLocked : !!msg.locked;
      broadcastInfo(room);
      broadcastChat(room, '', 'Teams ' + (room.teamsLocked ? 'locked' : 'unlocked'), '', true);
      break;
    case 'map': {
      // Either one of the built-in pitches or a HaxBall map the host just
      // loaded.  Anything else — including a loaded map that does not make
      // sense — is refused with a message rather than a broken room.
      let next = null;
      try {
        if (msg.map === CUSTOM_MAP) next = normalizeHbs(msg.hbs);
        else if (MAPS[msg.map]) next = builtInStadium(msg.map);
        else break;
      } catch (err) {
        sendTo(ws, { t: 'error', message: err && err.message ? err.message : 'That map could not be loaded.' });
        break;
      }

      // Moving the goalposts mid-match would be nonsense, so a change during
      // play puts everyone back in the room first.
      if (room.phase !== WAITING) {
        backToWaiting(room);
        broadcast(room, { t: 'waiting' });
      }

      room.map = next.custom ? CUSTOM_MAP : next.key;
      room.stadium = next.custom ? next : null;
      room.ball.radius = next.ball.radius;
      refreshPitchFlags(room);
      placeTeams(room);
      broadcastInfo(room);
      broadcastStadium(room);
      broadcastChat(room, '', 'Map changed to ' + next.label, '', true);
      break;
    }
    case 'settings': {
      if (msg.name != null) {
        const name = String(msg.name).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 28);
        if (name) room.name = name;
      }
      if (msg.maxPlayers != null) {
        const max = clamp(parseInt(msg.maxPlayers, 10) || room.maxPlayers, 2, 24);
        if (max >= room.players.size) room.maxPlayers = max;
      }
      if (msg.timeLimit != null) room.timeLimit = clamp(parseInt(msg.timeLimit, 10) || 0, 0, 60);
      if (msg.scoreLimit != null) room.scoreLimit = clamp(parseInt(msg.scoreLimit, 10) || 0, 0, 50);
      if (msg.password != null) room.password = String(msg.password).slice(0, 24);
      broadcastInfo(room);
      break;
    }
    case 'kick': {
      const target = room.players.get(Number(msg.id));
      if (!target || target === player) break;
      sendTo(target.ws, { t: 'kicked', message: 'You were kicked by an admin.' });
      removePlayer(room, target, 'was kicked');
      break;
    }
    case 'ban': {
      // A ban is a kick the server remembers: the address stays on the list
      // for as long as it is running, so the connection cannot walk back in.
      const target = room.players.get(Number(msg.id));
      if (!target || target === player) break;
      const address = clientAddress(target.ws);
      if (!address) break;
      // Two players on one machine, or behind one router, share an address —
      // and so does the admin doing the banning.  That is worth saying out
      // loud, but it is the admin's call, not the server's: refusing here
      // would make the ban useless to anyone playing on a home network.
      if (address === clientAddress(ws)) {
        sendTo(ws, { t: 'error', message: 'Everyone on your connection is banned too, yourself included.' });
      }
      bannedAddresses.add(address);
      sendTo(target.ws, { t: 'kicked', message: 'You were banned by an admin.' });
      removePlayer(room, target, 'was banned');
      break;
    }

    case 'admin': {
      // Admins are a role, not a throne: any admin can hand the role on, and
      // a room can have as many as it likes. The one admin who cannot be
      // demoted is the host, whose role came with opening the room.
      const target = room.players.get(Number(msg.id));
      if (!target) break;
      const want = msg.admin == null ? !target.admin : !!msg.admin;
      if (want === target.admin) break;
      if (!want && target.id === room.hostId) {
        sendTo(ws, { t: 'error', message: 'The host of the room stays an admin.' });
        break;
      }
      target.admin = want;
      broadcastInfo(room);
      broadcastChat(room, '', target.nick + (want ? ' is now an admin' : ' is no longer an admin'), '', true);
      break;
    }
    default:
      break;
  }
}

function handleChat(ws, msg) {
  const room = ws.room;
  if (!room) return;
  const player = room.players.get(ws.playerId);
  if (!player) return;

  const text = String(msg.text == null ? '' : msg.text)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_CHAT_LEN);
  if (!text) return;

  broadcastChat(room, player.nick, text, player.team);
}

/* ===================================================================== *
 *  HTTP + WebSocket wiring
 * ===================================================================== */

/* The site and the game are served from one port.  A host like Railway hands
   an application a single public port, so a page that fetched its socket from
   a second one would have nothing to talk to; here the page, its assets and
   the WebSocket all arrive on the same origin.

   XAMPP can still serve index.php through Apache on port 80 instead — the
   page works out which of the two it is (see index.php) — but nothing about
   the game needs it. */
const WEB_ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.php': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// The server's own source, its test harness and its modules are nobody's
// business over HTTP.
const PRIVATE = new Set(['server.js', '_smoke.js', 'package.json', 'package-lock.json', 'node_modules', '.git']);

/* This project has exactly two lines of PHP, and they only decide what a new
   visitor is called.  Rather than drag a PHP runtime into the image, any line
   carrying PHP is dropped whole — the page stays valid HTML and valid
   JavaScript, and the client names itself instead (see getNick, which has to
   cope with window.PLAYER_NICK never being set).  Everything else is served
   as it sits on disk. */
function renderPhp(source) {
  return source.split('\n').filter(line => !/<\?(?:php|=)/.test(line)).join('\n');
}

function serveFile(req, res, pathname) {
  const wanted = pathname === '/' ? '/index.php' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(wanted); } catch (e) { decoded = ''; }

  const relative = decoded.replace(/^\/+/, '');
  const parts = relative.split('/');
  if (!relative || parts.some(p => p === '' || p === '..' || p.startsWith('.'))) {
    return notFound(res);
  }
  if (PRIVATE.has(parts[0])) return notFound(res);

  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  if (!MIME[ext]) return notFound(res);

  const file = path.join(WEB_ROOT, ...parts);
  // Belt and braces: whatever the path looked like, it has to land inside the
  // project folder.
  if (!file.startsWith(WEB_ROOT + path.sep)) return notFound(res);

  fs.readFile(file, (err, buffer) => {
    if (err) return notFound(res);
    const body = ext === '.php' ? Buffer.from(renderPhp(buffer.toString('utf8')), 'utf8') : buffer;
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': body.length,
      // The page and its assets change whenever the project is deployed, and
      // a stale game.js against a new server is a miserable thing to debug.
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { pathname = '/'; }
  serveFile(req, res, pathname);
});

// A join or create message carries the player's ball image, so the frame
// ceiling has to clear MAX_AVATAR_LEN plus the surrounding JSON with room to
// spare — anything a real client sends must fit, or the sender's socket is
// torn down by the transport instead of being refused politely.
// A loaded .hbs map arrives as JSON in one message, so the frame ceiling has
// to clear the biggest map the caps above will let through.
const wss = new WebSocket.Server({ server, maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  ws.room = null;
  ws.playerId = 0;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'list':
        sendTo(ws, { t: 'rooms', rooms: roomList() });
        break;
      case 'ping':
        // Application-level echo so the client can measure its own round trip.
        sendTo(ws, { t: 'pong', i: msg.i });
        break;
      case 'create':
        handleCreate(ws, msg);
        break;
      case 'join':
        handleJoin(ws, msg);
        break;
      case 'leave':
        detach(ws);
        sendTo(ws, { t: 'left_room' });
        break;
      case 'team':
        handleTeam(ws, msg);
        break;
      case 'admin':
        handleAdmin(ws, msg);
        break;
      case 'chat':
        handleChat(ws, msg);
        break;
      case 'avatar': {
        const room = ws.room;
        if (!room) break;
        const player = room.players.get(ws.playerId);
        if (!player) break;

        // An empty string clears the image.  Anything else has to be a small
        // raster image; junk is refused rather than silently treated as a
        // clear, so a client bug can never wipe someone's picture.
        const data = String(msg.data || '');
        const avatar = data === '' ? '' : cleanAvatar(data);
        if (avatar === '' && data !== '') {
          sendTo(ws, { t: 'error', message: 'That ball image was refused — use a PNG, GIF, JPEG or WebP under 30 KB.' });
          break;
        }
        if (avatar === player.avatar) break;
        player.avatar = avatar;
        broadcastInfo(room);
        break;
      }
      case 'input': {
        const room = ws.room;
        if (!room) break;
        const player = room.players.get(ws.playerId);
        if (!player) break;
        const keys = msg.keys || {};
        player.input = {
          up: !!keys.up, down: !!keys.down,
          left: !!keys.left, right: !!keys.right,
          kick: !!keys.kick,
        };
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    detach(ws);
  });

  ws.on('error', () => {
    detach(ws);
  });
});

// Drop sockets that stopped answering so half-open connections don't hold
// player slots forever.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) { /* ignore */ } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 30000);

/* ------------------------------ game loop ---------------------------- */

let accumulator = 0;
let lastTime = Date.now();

setInterval(() => {
  const now = Date.now();
  let elapsed = (now - lastTime) / 1000;
  lastTime = now;
  if (elapsed > 0.25) elapsed = 0.25;      // survive a stall without spiralling
  accumulator += elapsed;

  let steps = 0;
  while (accumulator >= DT && steps < 8) {
    accumulator -= DT;
    steps++;
    for (const room of rooms.values()) {
      tickRoom(room);
      broadcastState(room);
    }
  }
  if (steps >= 8) accumulator = 0;

  // Reap rooms nobody is sitting in.
  const cutoff = Date.now() - EMPTY_ROOM_TTL;
  for (const room of rooms.values()) {
    if (room.players.size === 0 && room.lastActivity < cutoff) rooms.delete(room.code);
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log('MiniBall server listening on ws://localhost:' + PORT);
});
