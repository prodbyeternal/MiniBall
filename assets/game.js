/* =====================================================================
 * MiniBall — client
 *
 * The server is authoritative.  This file sends key states and draws the
 * snapshots it gets back, extrapolating each body forward by its own
 * velocity so 60Hz snapshots look smooth on any refresh rate.
 *
 * There are two views inside a room:
 *
 *   waiting   the room panel from HaxBall's own room dialog, sat on the
 *             room backdrop, where teams, stadium and limits are set and
 *             the host starts the match
 *   in-game   the pitch fills the window and every control floats on top
 *             of it (reference: the score pill, floating chat, Menu, and
 *             the ping / fps counters in the corner)
 * ===================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* --- stadium geometry, mirrored from server.js --- */
  var MAPS = {
    small:  { label: 'Small',  halfW: 300, halfH: 170, goalHalfH: 45, goalDepth: 34, centreCircle: 60,  boxDepth: 78,  boxHalfH: 108 },
    medium: { label: 'Medium', halfW: 420, halfH: 200, goalHalfH: 64, goalDepth: 50, centreCircle: 78,  boxDepth: 105, boxHalfH: 132 },
    big:    { label: 'Big',    halfW: 620, halfH: 270, goalHalfH: 86, goalDepth: 62, centreCircle: 100, boxDepth: 140, boxHalfH: 176 }
  };

  var STADIUMS = [
    { key: 'small',  desc: 'Tight and quick' },
    { key: 'medium', desc: 'The balanced default' },
    { key: 'big',    desc: 'Wide open, long shots' }
  ];

  /* --- HaxBall's pitch and team colours --- */
  var COLOURS = {
    surround: '#3a3a3a',
    grass: '#4b8a39',
    grassAlt: '#529542',
    asphalt: '#4f5257',                        // HaxBall's hockey ground is a slab
    stripeWash: 'rgba(255, 255, 255, 0.055)',   // stripes over a map's own ground
    line: '#ffffff',
    net: 'rgba(18, 24, 16, 0.55)',
    netLine: 'rgba(255, 255, 255, 0.30)',
    red: '#e56e56',
    blue: '#5689e5',
    ink: '#1b1f1b'
  };

  var TAU = Math.PI * 2;
  var PLAYER_RADIUS = 15;   // mirrors the server's PLAYER_PHYS.radius

  /* --------------------------------------------------------------- *
   *  State
   * --------------------------------------------------------------- */

  var ws = null;
  var connected = false;
  var reconnectTimer = null;
  var youId = 0;
  var info = null;          // last 'room' message
  var customStadium = null; // geometry of a loaded .hbs map, or null
  var snapshot = null;      // last 'state' message
  var snapshotAt = 0;       // performance.now() when it arrived
  var roomsCache = [];
  var keys = {};
  var lastSent = '';
  var lastSentAt = 0;
  var ballAngle = 0;
  var prevBall = null;
  var selectedId = 0;       // player highlighted in the room panel
  var dragId = 0;           // player currently being dragged between columns
  var lastPhase = '';

  var canvas = $('pitch');
  var ctx = canvas.getContext('2d');
  var cw = 0, ch = 0, dpr = 1;
  var view = { s: 1, ox: 0, oy: 0 };

  /* Tab pulls the camera in on your own disc and puts an arrow on it pointing
     at the ball: the whole pitch is always on screen otherwise, and at speed
     it is easy to lose track of where the ball actually is.  It is a toggle,
     and it starts switched on wherever the window is too small to show the
     pitch at a useful size.  The pull-in is deliberate rather than dramatic —
     enough to see the players around you, not so much that the ball leaves
     the screen entirely. */
  var LOOK_ZOOM = 1.75;      // how much closer the camera sits
  var LOOK_EASE = 0.3;       // per frame: the camera trails you a little
  var LOOK_SMALL = 0.9;      // view scale below which the window is "small"
  var lookPref = null;       // null = follow the window size, else Tab's choice
  var lookCam = { x: 0, y: 0, on: false };
  var lastBall = null;        // where the ball was drawn this frame

  // Whether the camera is pulled in right now.  A window small enough to
  // shrink the pitch is looked at up close unless Tab says otherwise.
  function lookActive() {
    return lookPref === null ? view.s < LOOK_SMALL : lookPref;
  }

  var chatBox = $('chatBox');

  /* --------------------------------------------------------------- *
   *  Settings (localStorage)
   * --------------------------------------------------------------- */

  var SETTINGS_KEY = 'miniball.settings';

  // A ball image travels to everyone in the room as a data URL, so it is
  // kept small; the server enforces the same ceiling.
  var MAX_AVATAR_CHARS = 40000;
  var MAX_AVATAR_FILE = 256 * 1024;

  // A .hbs map is read in the browser and sent to the server as JSON.  The
  // server checks everything in it; this is only so a huge file is refused
  // before it is read into memory.
  var MAX_HBS_FILE = 256 * 1024;

  var DEFAULT_SETTINGS = {
    specOnJoin: false,      // general: enter rooms as a spectator
    autoRefresh: true,      // general: poll the room list on a timer
    chatLines: 120,         // general: how many lines the log keeps
    avatar: '',             // general: your ball image (data URL) or ''
    showFps: true,          // visual
    showPing: true,         // visual
    showNames: true,        // visual
    numbers: true,          // visual: number the players
    inGameChat: true,       // visual
    stripes: true,          // visual: mown grass
    bgTheme: 'wash',        // visual: the backdrop behind the room panel
    highlightSelf: true     // visual: ring around your own disc
  };

  /* The three backdrops the room can wear.  'wash' is the drifting blue haze
     the game has had all along, 'stripes' is the grey of the room browser
     carrying dim blue stripes that drift towards the bottom-right corner, and
     'classic' is the dark striped backdrop the room started life with. */
  var BG_THEMES = {
    wash: 'Blue haze',
    stripes: 'Grey with blue stripes',
    classic: 'Classic dark stripes'
  };

  var settings = loadSettings();

  function loadSettings() {
    var out = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (key) { out[key] = DEFAULT_SETTINGS[key]; });

    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { stored = null; }
    if (stored && typeof stored === 'object') {
      Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
        if (typeof stored[key] !== typeof DEFAULT_SETTINGS[key]) return;
        if (key === 'chatLines') out.chatLines = clamp(Math.round(stored.chatLines), 20, 500);
        else if (key === 'avatar') out.avatar = isAvatarUrl(stored.avatar) ? stored.avatar : '';
        else if (key === 'bgTheme') out.bgTheme = BG_THEMES[stored.bgTheme] ? stored.bgTheme : 'wash';
        else out[key] = stored[key];
      });
    }
    return out;
  }

  function isAvatarUrl(data) {
    return typeof data === 'string'
      && data.length > 0 && data.length <= MAX_AVATAR_CHARS
      && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(data);
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  function applySettings() {
    $('statFps').classList.toggle('hidden', !settings.showFps);
    $('statPing').classList.toggle('hidden', !settings.showPing);
    document.body.classList.toggle('no-game-chat', !settings.inGameChat);
    Object.keys(BG_THEMES).forEach(function (key) {
      document.body.classList.toggle('bg-' + key, key === settings.bgTheme);
    });
    updateStats();
  }

  /* --------------------------------------------------------------- *
   *  Small helpers
   * --------------------------------------------------------------- */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function show(id) {
    ['lobby', 'room'].forEach(function (x) { $(x).classList.toggle('hidden', x !== id); });
    document.body.classList.toggle('in-room', id === 'room');
  }

  function toast(text, bad) {
    var el = $('toast');
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.add('hidden'); }, 3200);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatClock(seconds) {
    if (seconds < 0) return '--:--';
    var s = Math.max(0, Math.ceil(seconds));
    return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
  }

  function formatAge(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    return Math.floor(seconds / 3600) + 'h';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function isTypingTarget(node) {
    if (!node || !node.tagName) return false;
    return node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA';
  }

  function copyText(text, message) {
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      toast(ok ? message : text);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(message); }, fallback);
    } else {
      fallback();
    }
  }

  /* --------------------------------------------------------------- *
   *  Nickname (kept in localStorage; the PHP session only seeds it)
   * --------------------------------------------------------------- */

  var NICK_KEY = 'miniball.nick';

  function getNick() {
    var stored = '';
    try { stored = localStorage.getItem(NICK_KEY) || ''; } catch (e) { stored = ''; }
    return (stored || window.PLAYER_NICK || 'Player').slice(0, 16);
  }

  function setNick(value) {
    var clean = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16) || 'Player';
    try { localStorage.setItem(NICK_KEY, clean); } catch (e) { /* ignore */ }
    $('nick').value = clean;
    $('sNick').value = clean;
    return clean;
  }

  /* --------------------------------------------------------------- *
   *  Socket
   * --------------------------------------------------------------- */

  function connect() {
    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(window.GAME_SERVER);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      connected = true;
      $('conn').classList.add('online');
      $('connText').textContent = 'connected';
      if (!info) requestRooms();
    };

    ws.onclose = function () {
      connected = false;
      $('conn').classList.remove('online');
      $('connText').textContent = 'disconnected';
      if (info) leaveRoom(true);
      scheduleReconnect();
    };

    ws.onerror = function () { /* onclose always follows */ };

    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      handle(msg);
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2500);
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function requestRooms() { send({ type: 'list' }); }

  /* --------------------------------------------------------------- *
   *  Latency
   * --------------------------------------------------------------- */

  var pingSeq = 0;
  var pingOut = {};
  var pingSamples = [];

  function tickPing() {
    if (!connected) return;
    var seq = ++pingSeq;
    pingOut[seq] = performance.now();
    send({ type: 'ping', i: seq });
  }

  function notePong(seq) {
    if (!(seq in pingOut)) return;
    var rtt = performance.now() - pingOut[seq];
    delete pingOut[seq];
    if (rtt < 0 || rtt > 5000) return;
    pingSamples.push(rtt);
    if (pingSamples.length > 24) pingSamples.shift();
  }

  function updateStats() {
    if (settings.showPing) {
      var label = 'Ping: --';
      if (pingSamples.length) {
        var lo = Math.round(Math.min.apply(null, pingSamples));
        var hi = Math.round(Math.max.apply(null, pingSamples));
        label = 'Ping: ' + (lo === hi ? String(lo) : lo + ' - ' + hi);
      }
      $('statPing').textContent = label;
    }
    // fps stays null until the first measurement window closes.
    if (settings.showFps) $('statFps').textContent = 'Fps: ' + (fps === null ? '--' : fps);
  }

  /* --------------------------------------------------------------- *
   *  Message handling
   * --------------------------------------------------------------- */

  function handle(msg) {
    switch (msg.t) {
      case 'rooms':
        roomsCache = msg.rooms || [];
        renderRooms();
        break;

      case 'entered':
        youId = msg.you;
        selectedId = msg.you;
        $('roomCode').textContent = msg.code;
        show('room');
        placeChat();
        resizeCanvas();
        // Players who would rather watch than play land in the spectator
        // column; the room panel is right there to put them on a team.  The
        // host stays on a team — they have a match to start.
        if (settings.specOnJoin && !creating) send({ type: 'team', team: 'spec' });
        creating = false;
        break;

      case 'room':
        info = msg;
        renderRoomInfo();
        break;

      // A loaded map's geometry, from the server.  Built-in pitches arrive as
      // null: the client already knows how to draw those.
      case 'stadium':
        customStadium = msg.stadium || null;
        if (info) resizeCanvas();
        break;

      case 'state':
        snapshot = msg;
        snapshotAt = performance.now();
        setView();
        break;

      case 'chat':
        appendChat(msg);
        break;

      case 'left':
        appendChat({ sys: true, text: msg.nick + ' left' });
        break;

      case 'goal':
        showGoal(msg);
        break;

      // Kick offs are not announced over the pitch: the small badge beside
      // the clock says whose it is, and the wall coming down is the signal
      // that play has started.  Nothing covers the ground while it happens.
      case 'started':
      case 'resumed':
        break;

      case 'waiting':
        appendChat({ sys: true, text: 'Waiting for players on both teams…' });
        break;

      case 'ended': {
        var score = snapshot ? snapshot.sc : [0, 0];
        hideGoalFlash();
        appendChat({ sys: true, text: 'Full time — Red ' + score[0] + ' – ' + score[1] + ' Blue' });
        flashOverlay('FULL TIME   ' + score[0] + ' – ' + score[1], 2400);
        break;
      }

      case 'pong':
        notePong(msg.i);
        break;

      case 'kicked':
        leaveRoom(false);
        toast(msg.message || 'You were kicked.', true);
        break;

      case 'left_room':
        if (info) leaveRoom(false);
        break;

      case 'error':
        if (msg.code === 'badpass') {
          openJoinDialog(currentJoinCode, 'Wrong password, try again.');
        } else {
          toast(msg.message || 'Server error.', true);
          if (msg.fatal) leaveRoom(false);
        }
        break;

      default:
        break;
    }
  }

  /* --------------------------------------------------------------- *
   *  Lobby
   * --------------------------------------------------------------- */

  function renderRooms() {
    var body = $('roomRows');
    body.innerHTML = '';
    $('lobbyEmpty').classList.toggle('hidden', roomsCache.length > 0);

    roomsCache.forEach(function (room) {
      var tr = el('tr');
      tr.dataset.code = room.code;

      var nameCell = el('td', 'c-name');
      nameCell.appendChild(el('span', 'room-name', room.name));
      if (room.locked) nameCell.appendChild(el('span', 'lock', '■'));
      tr.appendChild(nameCell);

      tr.appendChild(el('td', 'c-players', room.players + '/' + room.max));

      tr.appendChild(el('td', 'c-map', room.map));

      var passCell = el('td', 'c-pass', room.locked ? 'Yes' : 'No');
      tr.appendChild(passCell);

      tr.appendChild(el('td', 'c-time', formatAge(room.age)));

      var status = room.phase === 'playing' ? 'Playing'
        : room.phase === 'waiting' ? 'Waiting'
        : room.phase === 'ended' ? 'Finished' : 'In progress';
      var statusCell = el('td', 'c-status');
      statusCell.appendChild(el('span', 'badge ' + room.phase, status));
      statusCell.appendChild(el('span', 'score-mini', room.score[0] + '–' + room.score[1]));
      tr.appendChild(statusCell);

      tr.addEventListener('click', function () { openJoinDialog(room.code, ''); });
      body.appendChild(tr);
    });
  }

  var currentJoinCode = '';
  var creating = false;   // set while the create dialog is submitting

  function openJoinDialog(code, errorText) {
    currentJoinCode = code || '';
    $('joinCode').value = currentJoinCode;
    $('joinError').textContent = errorText || '';
    $('joinError').classList.toggle('hidden', !errorText);
    $('joinPassword').value = '';
    openModal('joinDialog');
    if (currentJoinCode) $('joinPassword').focus(); else $('joinCode').focus();
  }

  function openModal(id) {
    document.querySelectorAll('.modal').forEach(function (m) { m.classList.add('hidden'); });
    $(id).classList.remove('hidden');
  }

  function closeModals() {
    document.querySelectorAll('.modal').forEach(function (m) { m.classList.add('hidden'); });
  }

  /* --------------------------------------------------------------- *
   *  Which view are we in?
   * --------------------------------------------------------------- */

  function currentPhase() {
    if (snapshot && snapshot.ph) return snapshot.ph;
    if (info && info.phase) return info.phase;
    return 'waiting';
  }

  // Waiting for a match (the room panel) versus a match in progress (the
  // pitch).  Full time counts as waiting: the panel comes back so the host
  // can start the next one.
  function inGame() {
    var phase = currentPhase();
    return phase !== 'waiting' && phase !== 'ended';
  }

  function setView() {
    var phase = currentPhase();
    if (phase === lastPhase) return;
    lastPhase = phase;

    document.body.classList.toggle('in-game', inGame());
    placeChat();
    if (inGame()) return;

    closeChat();
    // Back on the panel: refresh the buttons that depend on the phase.
    if (info) renderRoomInfo();
  }

  function placeChat() {
    var host = document.body.classList.contains('in-game') ? $('gameUi') : $('waitingUi');
    if (chatBox.parentElement !== host) host.appendChild(chatBox);
  }

  function openChat() {
    if (!info) return;
    document.body.classList.add('chat-open');
    $('chatInput').focus();
  }

  function closeChat() {
    document.body.classList.remove('chat-open');
    $('chatInput').blur();
    $('chatInput').value = '';
  }

  /* --------------------------------------------------------------- *
   *  Room panel
   * --------------------------------------------------------------- */

  function findPlayer(id) {
    if (!info) return null;
    for (var i = 0; i < info.players.length; i++) {
      if (info.players[i].id === id) return info.players[i];
    }
    return null;
  }

  function isAdmin() {
    var me = findPlayer(youId);
    return !!(me && me.admin);
  }

  function setNumberValue(input, value) {
    input.value = String(value);
  }

  function renderRoomInfo() {
    var map = MAPS[info.map] || MAPS.medium;
    var admin = isAdmin();

    if (!findPlayer(selectedId)) selectedId = youId;

    $('roomName').textContent = info.name;
    $('roomCode').textContent = info.code;
    $('pStadium').textContent = info.mapLabel || map.label;

    var fullTime = currentPhase() === 'ended' && snapshot;
    $('rpScore').classList.toggle('hidden', !fullTime);
    if (fullTime) $('rpScore').textContent = 'Full time  ' + snapshot.sc[0] + ' – ' + snapshot.sc[1];

    // Plain number boxes: type a value or click the arrows.
    if (document.activeElement !== $('pTime')) setNumberValue($('pTime'), info.timeLimit);
    if (document.activeElement !== $('pScore')) setNumberValue($('pScore'), info.scoreLimit);
    if (document.activeElement !== $('pMax')) setNumberValue($('pMax'), info.maxPlayers);

    $('pTime').disabled = !admin;
    $('pScore').disabled = !admin;
    $('pMax').disabled = !admin;
    $('pickBtn').disabled = !admin;

    ['autoBtn', 'randBtn', 'lockBtn', 'resetBtn'].forEach(function (id) {
      $(id).disabled = !admin;
    });
    $('lockBtn').classList.toggle('on', !!info.teamsLocked);

    var started = inGame();
    $('startBtn').disabled = !admin || started || !teamsReady();

    renderColumns();
    resizeCanvas();
  }

  function teamsReady() {
    if (!info) return false;
    var red = 0, blue = 0;
    info.players.forEach(function (p) {
      if (p.team === 'red') red++;
      else if (p.team === 'blue') blue++;
    });
    return red > 0 && blue > 0;
  }

  // The three team columns, in the order the arrows walk them.
  var COLUMN_ORDER = ['red', 'spec', 'blue'];

  function renderColumns() {
    var lists = { red: $('redList'), spec: $('specList'), blue: $('blueList') };
    Object.keys(lists).forEach(function (key) { lists[key].innerHTML = ''; });

    var admin = isAdmin();
    var columns = { red: [], spec: [], blue: [] };

    info.players.forEach(function (p, index) {
      var mine = p.id === youId;
      // You may always move yourself; the host may move anybody.
      var movable = admin || mine;

      var chip = el('div', 'rp-player'
        + (mine ? ' me' : '')
        + (p.admin ? ' admin' : '')
        + (p.id === selectedId ? ' sel' : '')
        + (movable ? ' movable' : ''));

      chip.appendChild(el('span', 'rp-idx', String(index)));
      chip.appendChild(el('span', 'rp-nick', p.nick));
      chip.title = (info.hostId === p.id ? 'Host of the room — ' : '')
        + (admin ? 'Drag this player into another column'
          : mine ? 'Drag yourself into another column'
            : 'Only the host can move other players');
      chip.addEventListener('click', function () { selectPlayer(p.id); });
      // An admin gets their management menu on anyone but themselves.
      if (admin && !mine) {
        chip.addEventListener('contextmenu', function (event) {
          selectPlayer(p.id);
          openPlayerMenu(event, p);
        });
      }

      if (movable) {
        chip.draggable = true;
        chip.addEventListener('dragstart', function (event) {
          dragId = p.id;
          event.dataTransfer.effectAllowed = 'move';
          // Firefox refuses to start a drag without payload.
          try { event.dataTransfer.setData('text/plain', String(p.id)); } catch (e) { /* ignore */ }
          chip.classList.add('dragging');
        });
        chip.addEventListener('dragend', function () {
          dragId = 0;
          chip.classList.remove('dragging');
          clearDropTargets();
        });
      }

      (columns[p.team] || columns.spec).push(chip);
    });

    Object.keys(columns).forEach(function (team) {
      var list = lists[team];
      if (!columns[team].length) {
        list.appendChild(el('div', 'rp-empty', 'nobody yet'));
        return;
      }
      columns[team].forEach(function (chip) { list.appendChild(chip); });
    });

    updateArrows();
  }

  // Each column is a drop target for the chip being dragged.  Wired once, at
  // boot: the lists themselves outlive every renderColumns().
  function wireDropTargets() {
    [['redList', 'red'], ['specList', 'spec'], ['blueList', 'blue']].forEach(function (pair) {
      var list = $(pair[0]);
      var team = pair[1];

      list.addEventListener('dragover', function (event) {
        if (!canDrop(team)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        clearDropTargets();
        list.classList.add('can-drop');
      });

      list.addEventListener('drop', function (event) {
        event.preventDefault();
        list.classList.remove('can-drop');
        dropOn(team);
      });
    });
  }

  // Would dropping the chip currently in flight onto this column do anything?
  function canDrop(team) {
    var player = findPlayer(dragId);
    if (!player || !(isAdmin() || dragId === youId)) return false;
    if (COLUMN_ORDER.indexOf(team) < 0) return false;
    // A locked room refuses team changes from everyone but the host.
    if (info.teamsLocked && !isAdmin()) return false;
    return player.team !== team;
  }

  function clearDropTargets() {
    ['redList', 'specList', 'blueList'].forEach(function (id) { $(id).classList.remove('can-drop'); });
  }

  function dropOn(team) {
    if (!canDrop(team)) return;
    var id = dragId;
    dragId = 0;
    selectedId = id;
    if (isAdmin()) send({ type: 'admin', action: 'move', id: id, team: team });
    else send({ type: 'team', team: team });
    renderColumns();
  }

  function selectPlayer(id) {
    if (!isAdmin() && id !== youId) return;
    selectedId = id;
    renderColumns();
  }

  /* --------------------------------------------------------------- *
   *  The admin's menu on a player
   * --------------------------------------------------------------- */

  /* Right-clicking a player — on their chip in the panel or on their disc
     out on the pitch — offers the things an admin can do to them.  Only
     admins see it, and never on themselves: moving yourself is what the
     panel's own arrows are for. */
  var menuEl = null;

  function closePlayerMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
  }

  function openPlayerMenu(event, target) {
    closePlayerMenu();
    if (!target || !isAdmin() || target.id === youId) return;
    event.preventDefault();

    var menu = el('div', 'ctxmenu');
    menu.appendChild(el('div', 'ctx-head', target.nick));

    function move(team) { send({ type: 'admin', action: 'move', id: target.id, team: team }); }

    var actions = [
      { label: 'Kick', run: function () { send({ type: 'admin', action: 'kick', id: target.id }); } },
      { label: 'Ban', run: function () { send({ type: 'admin', action: 'ban', id: target.id }); } },
      null,
      { label: 'Move to Red', here: target.team === 'red', run: function () { move('red'); } },
      { label: 'Move to Spectators', here: target.team === 'spec', run: function () { move('spec'); } },
      { label: 'Move to Blue', here: target.team === 'blue', run: function () { move('blue'); } },
      null,
      // The host opened the room, so their admin is not a role anyone can
      // take back — the menu says so rather than offering it.
      target.id === (info && info.hostId)
        ? { label: 'Host — stays an admin', here: true, run: function () {} }
        : {
          label: target.admin ? 'Remove admin' : 'Make admin',
          run: function () { send({ type: 'admin', action: 'admin', id: target.id, admin: !target.admin }); }
        }
    ];

    actions.forEach(function (item) {
      if (!item) { menu.appendChild(el('div', 'ctx-sep')); return; }
      var button = el('button', 'ctx-item' + (item.here ? ' current' : ''), item.label);
      button.addEventListener('click', function () {
        closePlayerMenu();
        item.run();
      });
      menu.appendChild(button);
    });

    document.body.appendChild(menu);

    // Keep it on screen, then let go of the mouse: any click, a scroll, a
    // key or a resize puts it away again.
    var box = menu.getBoundingClientRect();
    var left = Math.min(event.clientX, window.innerWidth - box.width - 6);
    var top = Math.min(event.clientY, window.innerHeight - box.height - 6);
    menu.style.left = Math.max(6, left) + 'px';
    menu.style.top = Math.max(6, top) + 'px';
    menuEl = menu;
  }

  /* Who is under the mouse on the pitch, for the in-game right-click. */
  function playerAtScreen(sx, sy) {
    if (!snapshot || !info) return null;

    // Undo whichever transform the last frame used, so the mouse lands on the
    // same world point the player sees under the cursor.
    var wx, wy;
    if (lookActive() && lookCam.on) {
      var zs = view.s * LOOK_ZOOM;
      wx = lookCam.x + (sx - cw / 2) / zs;
      wy = lookCam.y + (sy - ch / 2) / zs;
    } else {
      wx = (sx - view.ox) / view.s;
      wy = (sy - view.oy) / view.s;
    }

    var hit = null;
    var best = PLAYER_RADIUS + 6;
    snapshot.p.forEach(function (row) {
      var meta = findPlayer(row[0]);
      if (!meta || (meta.team !== 'red' && meta.team !== 'blue')) return;
      var distance = Math.hypot(row[1] - wx, row[2] - wy);
      if (distance < best) { best = distance; hit = meta; }
    });
    return hit;
  }

  function updateArrows() {
    var player = findPlayer(isAdmin() ? (selectedId || youId) : youId);
    var index = player ? ['red', 'spec', 'blue'].indexOf(player.team) : 1;
    if (index < 0) index = 1;
    $('moveLeft').disabled = index === 0;
    $('moveRight').disabled = index === 2;
  }

  function moveSelected(direction) {
    if (!info) return;
    var id = isAdmin() ? (selectedId || youId) : youId;
    var player = findPlayer(id);
    if (!player) return;

    var order = ['red', 'spec', 'blue'];
    var index = order.indexOf(player.team);
    if (index < 0) index = 1;
    var next = index + direction;
    if (next < 0 || next > 2) return;

    var team = order[next];
    if (isAdmin()) send({ type: 'admin', action: 'move', id: id, team: team });
    else send({ type: 'team', team: team });
  }

  function inviteLink() {
    return location.origin + location.pathname + '?room=' + (info ? info.code : '');
  }

  /* Send one of the room panel's number boxes, after clamping it to the
     range the server accepts and writing the clamped value back. */
  function sendRoomSetting(inputId, field, lo, hi) {
    var input = $(inputId);
    var raw = Number(input.value);
    if (!isFinite(raw)) raw = lo;
    var value = clamp(Math.round(raw), lo, hi);
    input.value = String(value);

    var msg = { type: 'admin', action: 'settings' };
    msg[field] = value;
    send(msg);
  }

  /* --------------------------------------------------------------- *
   *  Chat
   * --------------------------------------------------------------- */

  function appendChat(msg) {
    var log = $('chatLog');
    var line = el('div', 'chat-line' + (msg.sys ? ' sys' : '') + (msg.team ? ' t-' + msg.team : ''));
    if (!msg.sys) line.appendChild(el('span', 'chat-nick', msg.nick + ':'));
    line.appendChild(el('span', 'chat-text', ' ' + msg.text));
    log.appendChild(line);
    while (log.childNodes.length > settings.chatLines) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    document.body.classList.remove('chat-empty');
  }

  /* --------------------------------------------------------------- *
   *  Overlay — short announcements over everything
   * --------------------------------------------------------------- */

  var overlayTimer = null;

  function flashOverlay(text, ms) {
    var overlay = $('overlay');
    $('overlayText').textContent = text;
    overlay.classList.remove('hidden');
    overlay.classList.remove('pop');
    void overlay.offsetWidth;
    overlay.classList.add('pop');

    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(function () { overlay.classList.add('hidden'); }, ms);
  }

  function hideOverlay() {
    clearTimeout(overlayTimer);
    $('overlay').classList.add('hidden');
  }

  /* --------------------------------------------------------------- *
   *  Goal celebration
   *
   *  "Blue Scored!" in the scorer's own colour, animated over live play —
   *  the match is never stopped for it.  When the last touch came from the
   *  side that conceded, the goal is called out as an own goal.
   * --------------------------------------------------------------- */

  var goalTimer = null;

  function showGoal(msg) {
    var team = msg.team === 0 ? 'red' : 'blue';
    var title = (team === 'red' ? 'Red' : 'Blue') + ' Scored!';
    var author = msg.by || null;

    var sub = '';
    if (author && author.own) sub = 'Own goal — ' + author.nick;
    else if (author) sub = author.nick;

    var flash = $('goalFlash');
    $('gfMain').textContent = title;
    $('gfSub').textContent = sub;
    flash.classList.remove('red', 'blue', 'pop', 'hidden');
    void flash.offsetWidth;                       // restart the animation
    flash.classList.add(team, 'pop');

    clearTimeout(goalTimer);
    goalTimer = setTimeout(function () {
      flash.classList.add('hidden');
      flash.classList.remove('pop');
    }, 2200);

    appendChat({
      sys: true,
      text: title + (author ? (author.own ? ' — own goal by ' + author.nick : ' — ' + author.nick) : '')
    });
  }

  function hideGoalFlash() {
    clearTimeout(goalTimer);
    var flash = $('goalFlash');
    flash.classList.add('hidden');
    flash.classList.remove('pop');
  }

  function leaveRoom(silent) {
    send({ type: 'leave' });
    info = null;
    snapshot = null;
    customStadium = null;
    prevBall = null;
    lastPhase = '';
    selectedId = 0;
    dragId = 0;
    hideOverlay();
    hideGoalFlash();
    closeChat();
    closeModals();
    document.body.classList.remove('in-game');
    $('chatLog').innerHTML = '';
    document.body.classList.add('chat-empty');
    show('lobby');
    if (!silent) requestRooms();
  }

  /* --------------------------------------------------------------- *
   *  Input
   * --------------------------------------------------------------- */

  function readKeys() {
    return {
      up: !!(keys['w'] || keys['arrowup']),
      down: !!(keys['s'] || keys['arrowdown']),
      left: !!(keys['a'] || keys['arrowleft']),
      right: !!(keys['d'] || keys['arrowright']),
      kick: !!(keys['x'] || keys[' '] || keys['shift'])
    };
  }

  function pumpInput() {
    if (!connected || !inGame()) return;
    if (document.activeElement === $('chatInput')) return;

    var snapshotKeys = readKeys();
    var encoded = JSON.stringify(snapshotKeys);
    var now = performance.now();
    if (encoded === lastSent && now - lastSentAt < 250) return;
    lastSent = encoded;
    lastSentAt = now;
    send({ type: 'input', keys: snapshotKeys });
  }

  window.addEventListener('keydown', function (event) {
    if (isTypingTarget(event.target)) return;

    var key = event.key.toLowerCase();

    // Enter pulls focus into the chat box rather than being swallowed.
    if (key === 'enter' && info) {
      event.preventDefault();
      openChat();
      return;
    }

    if (key === ' ' || key.indexOf('arrow') === 0) event.preventDefault();
    // Tab looks at your own player, on and off.  It is also the key the
    // browser uses to walk the focus around, so it has to be swallowed while
    // the pitch has the keyboard — in a text box or a dialog it is left
    // alone.  The auto-repeat is ignored or the toggle would flicker.
    if (key === 'tab') {
      event.preventDefault();
      if (!event.repeat) {
        lookPref = !lookActive();
        lookCam.on = false;
      }
      return;
    }
    if (keys[key]) return;
    keys[key] = true;
    pumpInput();
  });

  window.addEventListener('keyup', function (event) {
    keys[event.key.toLowerCase()] = false;
    pumpInput();
  });

  window.addEventListener('blur', function () {
    keys = {};
    pumpInput();
  });

  /* --------------------------------------------------------------- *
   *  Canvas geometry
   * --------------------------------------------------------------- */

  function currentMap() {
    return MAPS[info && info.map] || MAPS.medium;
  }

  // The loaded map, when the room is playing on one.  Everything about the
  // pitch — walls, nets, bounds, ball — then comes from the server instead of
  // the three built-in sizes above.
  function currentStadium() {
    return info && info.map === 'custom' && customStadium ? customStadium : null;
  }

  function stadiumBounds() {
    var st = currentStadium();
    if (st && st.bounds) return st.bounds;
    var map = currentMap();
    return {
      minX: -(map.halfW + map.goalDepth), maxX: map.halfW + map.goalDepth,
      minY: -map.halfH, maxY: map.halfH
    };
  }

  function ballLook() {
    var st = currentStadium();
    return {
      radius: st && st.ball ? st.ball.radius : 10,
      color: st && st.ball ? st.ball.color : '#ffffff'
    };
  }

  function resizeCanvas() {
    var stage = canvas.parentElement;
    var rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = rect.width;
    ch = rect.height;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';

    var b = stadiumBounds();
    var worldW = b.maxX - b.minX;
    var worldH = b.maxY - b.minY;
    // Fit the whole stadium in, so both goals are always on screen; the
    // surround fills whatever is left over.
    var pad = 8;
    var s = Math.min((cw - pad * 2) / worldW, (ch - pad * 2) / worldH);
    if (!isFinite(s) || s <= 0) s = 1;

    // A loaded map need not be centred on the origin, so the middle of its
    // bounds — not (0, 0) — is what goes to the middle of the canvas.
    view.s = s;
    view.ox = cw / 2 - ((b.minX + b.maxX) / 2) * s;
    view.oy = ch / 2 - ((b.minY + b.maxY) / 2) * s;
  }

  window.addEventListener('resize', function () {
    if (info) resizeCanvas();
  });

  /* --------------------------------------------------------------- *
   *  Rendering
   * --------------------------------------------------------------- */

  function render(now) {
    if (!info) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!inGame()) {
      // Waiting for a match: leave the canvas clear so the room backdrop
      // shows through.
      ctx.clearRect(0, 0, cw, ch);
      return;
    }

    ctx.fillStyle = COLOURS.surround;
    ctx.fillRect(0, 0, cw, ch);

    var map = currentMap();
    var st = currentStadium();
    var phase = snapshot ? snapshot.ph : 'waiting';
    var extrapolate = phase === 'playing' || phase === 'waiting';
    var age = extrapolate ? Math.min((now - snapshotAt) / 1000, 0.12) : 0;
    var ticks = age * 60;

    // The look camera only moves when there is somebody to look at: a
    // spectator watching from the panel keeps the whole pitch.
    var mine = lookActive() ? myDisc(ticks) : null;

    ctx.save();
    if (mine) {
      // Ease onto the player rather than cutting to them, then follow: the
      // camera drifts a little behind wherever you are running.
      if (!lookCam.on) { lookCam.x = mine.x; lookCam.y = mine.y; lookCam.on = true; }
      lookCam.x += (mine.x - lookCam.x) * LOOK_EASE;
      lookCam.y += (mine.y - lookCam.y) * LOOK_EASE;
      var zs = view.s * LOOK_ZOOM;
      ctx.translate(cw / 2 - lookCam.x * zs, ch / 2 - lookCam.y * zs);
      ctx.scale(zs, zs);
    } else {
      lookCam.on = false;
      ctx.translate(view.ox, view.oy);
      ctx.scale(view.s, view.s);
    }

    if (st) {
      drawStadium(ctx, st);
    } else {
      drawPitch(ctx, map, settings.stripes);
      drawGoals(ctx, map);
    }
    drawBodies(map, ticks);

    ctx.restore();

    if (mine) drawBallArrow(mine);
  }

  /* My own disc from the snapshot, carried forward by its velocity the same
     way drawBodies does it, or null when I am on the bench. */
  function myDisc(ticks) {
    if (!snapshot || !youId) return null;
    var row = null;
    snapshot.p.forEach(function (r) { if (r[0] === youId) row = r; });
    if (!row) return null;
    return { x: row[1] + row[3] * ticks, y: row[2] + row[4] * ticks };
  }

  /* The ball arrow, drawn in screen pixels just outside your own disc so it
     stays the same size however far the camera is in.  It fades out once the
     ball is close enough to see for yourself. */
  function drawBallArrow(mine) {
    if (!lastBall) return;

    var zs = view.s * LOOK_ZOOM;
    var px = cw / 2 + (mine.x - lookCam.x) * zs;
    var py = ch / 2 + (mine.y - lookCam.y) * zs;
    var bx = cw / 2 + (lastBall.x - lookCam.x) * zs;
    var by = ch / 2 + (lastBall.y - lookCam.y) * zs;

    var dx = bx - px;
    var dy = by - py;
    var dist = Math.hypot(dx, dy);
    // The arrow sits clear of your own disc, which itself grows with the
    // zoom, and it is dropped once the ball is close enough to see yourself.
    var disc = PLAYER_RADIUS * zs;
    var near = Math.max(70, disc + 40);
    if (dist < near) return;

    var angle = Math.atan2(dy, dx);
    var fade = Math.min(1, (dist - near) / 90);

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.globalAlpha = 0.35 + 0.6 * fade;

    var tip = disc + 9 + 18 * fade;
    ctx.beginPath();
    ctx.moveTo(tip, 0);
    ctx.lineTo(tip - 13, -8.5);
    ctx.lineTo(tip - 10, 0);
    ctx.lineTo(tip - 13, 8.5);
    ctx.closePath();

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  /* A loaded map draws itself: every wall arrives as a line, an arc or a
     disc, with its own colour.  Built-in pitches are drawn procedurally in
     drawPitch, which is why they keep their grass and nets. */
  function drawStadium(g, st) {
    var p = st.pitch || { halfW: 400, halfH: 200 };

    // The ground: the map's own colour when it names one, otherwise the kind
    // of ground it asked for — HaxBall's grass, its asphalt hockey slab or a
    // bare void — and the green of the built-in pitches when it says nothing.
    var own = typeof p.color === 'string' && p.color.length > 1;
    var asphalt = !own && p.type === 'hockey';
    var ground = own ? p.color
      : asphalt ? COLOURS.asphalt
        : p.type === 'none' ? COLOURS.surround
          : COLOURS.grass;
    var naked = !own && p.type === 'none';
    var radius = Math.min(p.corner || 0, Math.min(p.halfW, p.halfH));

    g.beginPath();
    if (radius > 0) roundRectPath(g, -p.halfW, -p.halfH, p.halfW * 2, p.halfH * 2, radius);
    else g.rect(-p.halfW, -p.halfH, p.halfW * 2, p.halfH * 2);
    g.fillStyle = asphalt ? asphaltGrain(g) : ground;
    g.fill();

    // Mown stripes are a wash over whatever ground that is, so a clay pitch
    // and a green one both keep them.  Grass stripes are the wrong idea on
    // asphalt, and a map with no ground at all gets none either.
    if (settings.stripes && !naked && !asphalt) {
      var count = Math.max(2, Math.round(p.halfW / 30));
      var stripeW = (p.halfW * 2) / count;
      g.save();
      g.clip();
      g.fillStyle = own ? COLOURS.stripeWash : COLOURS.grassAlt;
      for (var i = 0; i < count; i += 2) {
        g.fillRect(-p.halfW + i * stripeW, -p.halfH, stripeW, p.halfH * 2);
      }
      g.restore();
    }

    // Nets first, so walls and posts draw over them.
    st.goals.forEach(function (goal) {
      var left = Math.min(goal.x1, goal.x2);
      var top = Math.min(goal.y1, goal.y2);
      var w = Math.abs(goal.x2 - goal.x1);
      var h = Math.abs(goal.y2 - goal.y1);
      if (w < 1 || h < 1) return;
      g.fillStyle = COLOURS.net;
      g.fillRect(left, top, w, h);
    });

    g.lineCap = 'butt';
    st.segs.forEach(function (s) {
      if (!s.vis) return;
      g.strokeStyle = s.color || COLOURS.line;
      g.lineWidth = s.thickness || 2.5;
      g.beginPath();
      if (s.curve) arcPath(g, s);
      else { g.moveTo(s.x1, s.y1); g.lineTo(s.x2, s.y2); }
      g.stroke();
    });

    // The goal line itself: a loaded map states where a goal counts, and the
    // mouth is worth showing even when the map leaves it out of its walls.
    g.strokeStyle = COLOURS.line;
    g.lineWidth = 3;
    st.goals.forEach(function (goal) {
      g.beginPath();
      g.moveTo(goal.x1, goal.y1);
      g.lineTo(goal.x2, goal.y2);
      g.stroke();
    });

    st.posts.forEach(function (post) {
      if (!post.vis) return;
      g.beginPath();
      g.arc(post.x, post.y, Math.max(post.radius, 2), 0, TAU);
      g.fillStyle = post.color || COLOURS.line;
      g.fill();
    });
  }

  // A slab of asphalt, the way HaxBall's hockey ground looks: grey, with a
  // scatter of lighter and darker speckles through it.  The grain is painted
  // once into a small tile and then repeated, so a whole pitch costs one fill
  // instead of a few thousand dots every frame.  The scatter is fixed, so it
  // sits still on the pitch instead of crawling about.
  var grainTile = null;
  var grainPattern = null;
  var grainOn = null;

  function makeGrainTile() {
    var t = document.createElement('canvas');
    t.width = t.height = 128;
    var c = t.getContext('2d');
    c.fillStyle = COLOURS.asphalt;
    c.fillRect(0, 0, 128, 128);

    var seed = 7;
    var rnd = function () {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (var i = 0; i < 1100; i++) {
      var light = rnd() < 0.45;
      c.fillStyle = light
        ? 'rgba(255, 255, 255, ' + (0.04 + rnd() * 0.09).toFixed(3) + ')'
        : 'rgba(0, 0, 0, ' + (0.05 + rnd() * 0.13).toFixed(3) + ')';
      c.fillRect(rnd() * 128, rnd() * 128, 0.4 + rnd() * 1.4, 0.4 + rnd() * 1.4);
    }
    return t;
  }

  function asphaltGrain(g) {
    if (!grainTile) grainTile = makeGrainTile();
    // A pattern belongs to the context it was made from; the thumbnails in
    // the stadium picker draw with their own, so it is remade when they ask.
    if (grainOn !== g) {
      grainOn = g;
      grainPattern = g.createPattern(grainTile, 'repeat');
    }
    return grainPattern || COLOURS.asphalt;
  }

  // A rounded rectangle, for a map that gives its ground a corner radius.
  // The path is left open for the caller to fill or clip.
  function roundRectPath(g, x, y, w, h, r) {
    var radius = Math.max(0, Math.min(r, w / 2, h / 2));
    g.moveTo(x + radius, y);
    g.lineTo(x + w - radius, y);
    g.quadraticCurveTo(x + w, y, x + w, y + radius);
    g.lineTo(x + w, y + h - radius);
    g.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    g.lineTo(x + radius, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - radius);
    g.lineTo(x, y + radius);
    g.quadraticCurveTo(x, y, x + radius, y);
  }

  // Same curve convention as the server: the arc bulges to the left of
  // (x1, y1) -> (x2, y2) when curve is positive.
  function arcPath(g, s) {
    var dx = s.x2 - s.x1;
    var dy = s.y2 - s.y1;
    var len = Math.hypot(dx, dy);
    if (!(len > 0.001)) return;
    var half = (Math.abs(s.curve) * Math.PI) / 360;
    var sin = Math.sin(half);
    if (!(Math.abs(sin) > 1e-4)) { g.moveTo(s.x1, s.y1); g.lineTo(s.x2, s.y2); return; }

    var r = len / (2 * sin);
    var h = r * Math.cos(half);
    var sign = s.curve > 0 ? 1 : -1;
    var cx = (s.x1 + s.x2) / 2 - (dy / len) * h * sign;
    var cy = (s.y1 + s.y2) / 2 + (dx / len) * h * sign;
    var a0 = Math.atan2(s.y1 - cy, s.x1 - cx);
    var a1 = Math.atan2(s.y2 - cy, s.x2 - cx);

    var span = a1 - a0;
    if (s.curve > 0) { while (span < 0) span += TAU; } else { while (span > 0) span -= TAU; }
    g.arc(cx, cy, r, a0, a0 + span, span < 0);
  }

  function drawPitch(g, map, stripes) {
    var w = map.halfW * 2;
    var h = map.halfH * 2;

    g.fillStyle = COLOURS.grass;
    g.fillRect(-map.halfW, -map.halfH, w, h);

    if (stripes) {
      var count = 12;
      var stripeW = w / count;
      g.fillStyle = COLOURS.grassAlt;
      for (var i = 0; i < count; i += 2) {
        g.fillRect(-map.halfW + i * stripeW, -map.halfH, stripeW, h);
      }
    }

    g.strokeStyle = COLOURS.line;
    g.lineWidth = 2.5;
    g.lineCap = 'butt';

    g.strokeRect(-map.halfW, -map.halfH, w, h);

    g.beginPath();
    g.moveTo(0, -map.halfH);
    g.lineTo(0, map.halfH);
    g.stroke();

    g.beginPath();
    g.arc(0, 0, map.centreCircle, 0, TAU);
    g.stroke();

    g.beginPath();
    g.arc(0, 0, 3, 0, TAU);
    g.fillStyle = COLOURS.line;
    g.fill();

    // Penalty boxes.
    g.beginPath();
    g.rect(-map.halfW, -map.boxHalfH, map.boxDepth, map.boxHalfH * 2);
    g.rect(map.halfW - map.boxDepth, -map.boxHalfH, map.boxDepth, map.boxHalfH * 2);
    g.stroke();
  }

  function drawGoals(g, map) {
    for (var side = -1; side <= 1; side += 2) {
      var x0 = side * map.halfW;
      var x1 = side * (map.halfW + map.goalDepth);
      var left = Math.min(x0, x1);
      var width = Math.abs(x1 - x0);
      var top = -map.goalHalfH;
      var height = map.goalHalfH * 2;

      g.fillStyle = COLOURS.net;
      g.fillRect(left, top, width, height);

      g.save();
      g.beginPath();
      g.rect(left, top, width, height);
      g.clip();
      g.strokeStyle = COLOURS.netLine;
      g.lineWidth = 1;
      var step = 8;
      var span = height + width;
      for (var i = -span; i < span; i += step) {
        g.beginPath();
        g.moveTo(left + i, top);
        g.lineTo(left + i + height, top + height);
        g.stroke();
        g.beginPath();
        g.moveTo(left + i, top + height);
        g.lineTo(left + i + height, top);
        g.stroke();
      }
      g.restore();

      // Goal posts.
      g.fillStyle = COLOURS.line;
      g.fillRect(x0 - 2, top - 2, 4, 4);
      g.fillRect(x0 - 2, top + height - 2, 4, 4);
    }
  }

  // Ball images arrive as data URLs and are decoded once per URL.  An
  // animated GIF animates because the element is drawn fresh every frame.
  var avatarImages = {};

  function getAvatar(url) {
    var entry = avatarImages[url];
    if (!entry) {
      if (Object.keys(avatarImages).length > 64) avatarImages = {};
      entry = avatarImages[url] = { img: new Image(), ready: false };
      entry.img.onload = function () { entry.ready = true; };
      entry.img.onerror = function () { entry.ready = false; };
      entry.img.src = url;
    }
    return entry.ready ? entry.img : null;
  }

  function drawBodies(map, ticks) {
    if (!snapshot) return;

    var ball = snapshot.b;
    var ballX = ball[0] + ball[2] * ticks;
    var ballY = ball[1] + ball[3] * ticks;
    // Kept for the ball arrow, which is drawn after the camera is unwound.
    lastBall = { x: ballX, y: ballY };

    if (prevBall) {
      ballAngle += Math.hypot(ballX - prevBall[0], ballY - prevBall[1]) / 10;
    }
    prevBall = [ballX, ballY];

    var byId = {};
    var numbers = {};
    var counters = { red: 0, blue: 0 };
    if (info) info.players.forEach(function (p) {
      byId[p.id] = p;
      if (p.team === 'red' || p.team === 'blue') numbers[p.id] = ++counters[p.team];
    });

    var discs = [];
    snapshot.p.forEach(function (row) {
      var meta = byId[row[0]];
      if (!meta || (meta.team !== 'red' && meta.team !== 'blue')) return;
      discs.push({
        id: row[0],
        team: meta.team,
        nick: meta.nick,
        avatar: meta.avatar || '',
        number: numbers[row[0]] || 0,
        x: row[1] + row[3] * ticks,
        y: row[2] + row[4] * ticks,
        kick: row[5] === 1
      });
    });

    if (settings.showNames) {
      // Names sit under the discs, so draw them first to keep the discs crisp.
      ctx.font = '9px Verdana, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillStyle = '#ffffff';

      discs.forEach(function (d) {
        ctx.strokeText(d.nick, d.x, d.y + 18);
        ctx.fillText(d.nick, d.x, d.y + 18);
      });
    }

    drawBall(ballX, ballY);

    discs.forEach(function (d) {
      if (settings.highlightSelf && d.id === youId) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, 19, 0, TAU);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (d.kick) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, 20, 0, TAU);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(d.x, d.y, PLAYER_RADIUS, 0, TAU);
      ctx.fillStyle = d.team === 'red' ? COLOURS.red : COLOURS.blue;
      ctx.fill();

      // A player's own image covers the number; otherwise the shirt number
      // is drawn inside the disc, if numbering is switched on.
      var avatar = d.avatar ? getAvatar(d.avatar) : null;
      if (avatar) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(d.x, d.y, PLAYER_RADIUS, 0, TAU);
        ctx.clip();
        ctx.drawImage(avatar, d.x - PLAYER_RADIUS, d.y - PLAYER_RADIUS, PLAYER_RADIUS * 2, PLAYER_RADIUS * 2);
        ctx.restore();
      } else if (settings.numbers && d.number) {
        ctx.font = 'bold 14px Verdana, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, .55)';
        ctx.fillStyle = '#ffffff';
        ctx.strokeText(String(d.number), d.x, d.y + 1);
        ctx.fillText(String(d.number), d.x, d.y + 1);
      }

      ctx.beginPath();
      ctx.arc(d.x, d.y, PLAYER_RADIUS, 0, TAU);
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLOURS.ink;
      ctx.stroke();
    });
  }

  function drawBall(x, y) {
    var look = ballLook();
    var r = look.radius;
    var k = r / 10;   // the pattern is drawn for a radius of 10

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ballAngle);

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fillStyle = look.color;
    ctx.fill();
    ctx.lineWidth = 1.6 * k;
    ctx.strokeStyle = COLOURS.ink;
    ctx.stroke();

    ctx.fillStyle = COLOURS.ink;
    ctx.beginPath();
    for (var i = 0; i < 5; i++) {
      var a = -Math.PI / 2 + (i * TAU) / 5;
      var px = Math.cos(a) * 4.2 * k;
      var py = Math.sin(a) * 4.2 * k;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = COLOURS.ink;
    ctx.lineWidth = 1.3 * k;
    for (var j = 0; j < 5; j++) {
      var b = -Math.PI / 2 + (j * TAU) / 5 + Math.PI / 5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(b) * 4.2 * k, Math.sin(b) * 4.2 * k);
      ctx.lineTo(Math.cos(b) * 9.8 * k, Math.sin(b) * 9.8 * k);
      ctx.stroke();
    }

    ctx.restore();
  }

  function kickoffText(team) {
    return (team === 'blue' ? 'Blue' : 'Red') + ' kick off';
  }

  function updateHud() {
    if (!snapshot) return;

    var pill = $('redScore');
    if (pill.textContent !== String(snapshot.sc[0])) pill.textContent = snapshot.sc[0];
    pill = $('blueScore');
    if (pill.textContent !== String(snapshot.sc[1])) pill.textContent = snapshot.sc[1];

    var unlimited = info && info.timeLimit === 0;
    var text = unlimited ? formatClock(snapshot.el) : formatClock(snapshot.tl);
    if ($('clock').textContent !== text) $('clock').textContent = text;

    // The kick off wall is invisible, so this is what says the match is
    // waiting on a touch rather than stuck.  It clears itself when the ball
    // is played and the server drops the wall.
    var badge = $('koBadge');
    var ko = snapshot.ph === 'kickoff' && snapshot.ko ? snapshot.ko : '';
    var label = ko ? kickoffText(ko) : '';
    if (badge.textContent !== label) badge.textContent = label;
    var cls = 'kobadge' + (ko === 'blue' ? ' b-blue' : ' b-red') + (ko ? '' : ' hidden');
    if (badge.className !== cls) badge.className = cls;
  }

  /* --------------------------------------------------------------- *
   *  Frame loop
   * --------------------------------------------------------------- */

  var frames = 0;
  var fpsAt = 0;
  var fps = null;   // null until the first half-second window has closed

  function frame(now) {
    requestAnimationFrame(frame);

    frames++;
    if (now - fpsAt >= 500) {
      fps = Math.round((frames * 1000) / (now - fpsAt));
      frames = 0;
      fpsAt = now;
      updateStats();
    }

    if (!info) return;
    render(now);
    updateHud();
  }

  /* --------------------------------------------------------------- *
   *  Dialogs: settings, menu, stadium picker
   * --------------------------------------------------------------- */

  var SETTING_CHECKS = [
    ['sSpec', 'specOnJoin'],
    ['sAutoRefresh', 'autoRefresh'],
    ['sFps', 'showFps'],
    ['sPing', 'showPing'],
    ['sNames', 'showNames'],
    ['sNumbers', 'numbers'],
    ['sChat', 'inGameChat'],
    ['sStripes', 'stripes'],
    ['sSelf', 'highlightSelf']
  ];

  function fillSettingsForm() {
    SETTING_CHECKS.forEach(function (pair) { $(pair[0]).checked = !!settings[pair[1]]; });
    $('sChatLines').value = settings.chatLines;
    $('sNick').value = getNick();

    // The backdrops are listed from the table above, so a new one is one line
    // here and one rule in the stylesheet.
    var picker = $('sBgTheme');
    picker.innerHTML = '';
    Object.keys(BG_THEMES).forEach(function (key) {
      var option = document.createElement('option');
      option.value = key;
      option.textContent = BG_THEMES[key];
      picker.appendChild(option);
    });
    picker.value = settings.bgTheme;

    drawAvatarPreview();
  }

  /* --- your ball image -------------------------------------------- */

  function drawAvatarPreview() {
    var g = $('sAvatarPreview').getContext('2d');
    var w = $('sAvatarPreview').width;

    g.clearRect(0, 0, w, w);
    g.fillStyle = '#2c2c2c';
    g.fillRect(0, 0, w, w);

    if (!isAvatarUrl(settings.avatar)) return;

    var img = new Image();
    img.onload = function () {
      g.save();
      g.beginPath();
      g.arc(w / 2, w / 2, w / 2 - 1, 0, TAU);
      g.clip();
      g.drawImage(img, 0, 0, w, w);
      g.restore();
    };
    img.src = settings.avatar;
  }

  // Read the chosen file.  A GIF that already fits the budget is kept whole
  // so it keeps animating; anything else is squared off to a 64x64 PNG.
  function acceptAvatarFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      toast('Use a PNG, JPEG, GIF or WebP image.', true);
      return;
    }
    if (file.size > MAX_AVATAR_FILE) {
      toast('That image is too big — keep it under 256 KB.', true);
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      var data = String(reader.result || '');
      if (file.type === 'image/gif' && isAvatarUrl(data)) { setAvatar(data); return; }

      var img = new Image();
      img.onload = function () { setAvatar(squarePng(img)); };
      img.onerror = function () { toast('That image could not be read.', true); };
      img.src = data;
    };
    reader.onerror = function () { toast('That image could not be read.', true); };
    reader.readAsDataURL(file);
  }

  // Centre-crop to a square and shrink to 64x64, the size the discs are drawn at.
  function squarePng(img) {
    var size = 64;
    var side = Math.min(img.width, img.height) || size;
    var sx = (img.width - side) / 2;
    var sy = (img.height - side) / 2;

    var c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    var g = c.getContext('2d');
    g.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return c.toDataURL('image/png');
  }

  function setAvatar(data) {
    settings.avatar = isAvatarUrl(data) ? data : '';
    saveSettings();
    drawAvatarPreview();
    // Everyone else needs to see it too.
    if (info) send({ type: 'avatar', data: settings.avatar });
  }

  function openSettings() {
    fillSettingsForm();
    setSettingsTab('general');
    openModal('settingsDialog');
  }

  function setSettingsTab(name) {
    document.querySelectorAll('.tabs .tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.tab === name);
    });
    document.querySelectorAll('.tabpage').forEach(function (page) {
      page.classList.toggle('hidden', page.dataset.page !== name);
    });
  }

  function drawPreview(g, map, w, h) {
    var scale = Math.min(window.devicePixelRatio || 1, 2);
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = COLOURS.surround;
    g.fillRect(0, 0, w, h);

    var worldW = (map.halfW + map.goalDepth) * 2;
    var worldH = map.halfH * 2;
    var s = Math.min(w / worldW, h / worldH) * 0.9;

    g.save();
    g.translate(w / 2, h / 2);
    g.scale(s, s);
    g.lineWidth = 2.5 / s;
    drawPitch(g, map, false);
    drawGoals(g, map);
    g.restore();
  }

  // The thumbnail for a loaded map: its own walls, fitted the same way.
  function drawStadiumPreview(g, st, w, h) {
    var scale = Math.min(window.devicePixelRatio || 1, 2);
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = COLOURS.surround;
    g.fillRect(0, 0, w, h);

    var b = st.bounds || { minX: -400, maxX: 400, minY: -200, maxY: 200 };
    var s = Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY)) * 0.9;
    if (!isFinite(s) || s <= 0) return;

    g.save();
    g.translate(w / 2 - ((b.minX + b.maxX) / 2) * s, h / 2 - ((b.minY + b.maxY) / 2) * s);
    g.scale(s, s);
    drawStadium(g, st);
    g.restore();
  }

  function stadiumButton(key, label, desc, active, thumbCanvas, onPick) {
    var button = el('button', 'stadium' + (active ? ' active' : ''));
    button.appendChild(thumbCanvas);
    var text = el('div');
    text.appendChild(el('div', 'sname', label));
    text.appendChild(el('div', 'sdesc', desc));
    button.appendChild(text);
    button.addEventListener('click', onPick);
    return button;
  }

  function thumbnail(draw) {
    var w = 92, h = 38;
    var scale = Math.min(window.devicePixelRatio || 1, 2);
    var c = document.createElement('canvas');
    c.width = w * scale;
    c.height = h * scale;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    draw(c.getContext('2d'), w, h);
    return c;
  }

  function openStadiumDialog() {
    if (!info || !isAdmin()) return;
    var host = $('stadiumList');
    host.innerHTML = '';

    STADIUMS.forEach(function (stadium) {
      var map = MAPS[stadium.key];
      host.appendChild(stadiumButton(
        stadium.key, map.label, stadium.desc, info.map === stadium.key,
        thumbnail(function (g, w, h) { drawPreview(g, map, w, h); }),
        function () {
          send({ type: 'admin', action: 'map', map: stadium.key });
          closeModals();
        }
      ));
    });

    // A map the host loaded earlier stays pickable until another one replaces
    // it — or the room goes back to a built-in pitch.
    if (customStadium) {
      var st = customStadium;
      host.appendChild(stadiumButton(
        'custom', st.label || 'Custom map', 'Loaded from a .hbs file', info.map === 'custom',
        thumbnail(function (g, w, h) { drawStadiumPreview(g, st, w, h); }),
        function () {
          send({ type: 'admin', action: 'map', map: 'custom', hbs: loadedHbs });
          closeModals();
        }
      ));
    }

    $('hbsHint').textContent = 'A HaxBall map file (.hbs) up to 256 KB. Everyone in the room plays on it.';
    $('hbsFile').value = '';
    openModal('stadiumDialog');
  }

  /* --- loading a .hbs map ----------------------------------------- */

  // Kept so the loaded map can be picked again after a switch to a built-in
  // pitch, which is the only way the server forgets it.
  var loadedHbs = null;

  function loadHbsFile(file) {
    if (!file) return;
    if (file.size > MAX_HBS_FILE) {
      toast('That map file is too big (the limit is 256 KB).', true);
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      var raw;
      try {
        raw = JSON.parse(String(reader.result));
      } catch (e) {
        toast('That file is not a HaxBall map — it is not valid JSON.', true);
        return;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        toast('That file is not a HaxBall map.', true);
        return;
      }
      loadedHbs = raw;
      send({ type: 'admin', action: 'map', map: 'custom', hbs: raw });
      closeModals();
    };
    reader.onerror = function () { toast('That map file could not be read.', true); };
    reader.readAsText(file);
  }

  /* --------------------------------------------------------------- *
   *  Wiring
   * --------------------------------------------------------------- */

  function boot() {
    setNick(getNick());
    applySettings();
    document.body.classList.add('chat-empty');

    $('nick').addEventListener('change', function () { setNick($('nick').value); });

    $('refreshBtn').addEventListener('click', requestRooms);

    $('createBtn').addEventListener('click', function () {
      setNick($('nick').value);
      openModal('createDialog');
      $('cName').focus();
    });

    $('joinBtn').addEventListener('click', function () {
      setNick($('nick').value);
      openJoinDialog('', '');
    });

    $('cSubmit').addEventListener('click', function () {
      creating = true;
      send({
        type: 'create',
        nick: setNick($('nick').value),
        name: $('cName').value,
        password: $('cPass').value,
        maxPlayers: $('cMax').value,
        map: $('cMap').value,
        timeLimit: $('cTime').value,
        scoreLimit: $('cScore').value,
        avatar: settings.avatar
      });
      closeModals();
    });

    $('jSubmit').addEventListener('click', function () {
      var code = ($('joinCode').value || '').trim().toUpperCase();
      if (code.length !== 6) { $('joinError').textContent = 'Room codes are 6 characters.'; $('joinError').classList.remove('hidden'); return; }
      creating = false;
      send({ type: 'join', room: code, password: $('joinPassword').value, nick: setNick($('nick').value), avatar: settings.avatar });
      closeModals();
    });

    $('joinCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('jSubmit').click(); });
    $('joinPassword').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('jSubmit').click(); });

    document.querySelectorAll('[data-close]').forEach(function (button) {
      button.addEventListener('click', closeModals);
    });

    /* --- room panel ------------------------------------------------ */

    $('leaveBtn').addEventListener('click', function () { leaveRoom(false); });

    $('linkBtn').addEventListener('click', function () {
      if (!info) return;
      copyText(inviteLink(), 'Invite link copied.');
    });

    $('moveLeft').addEventListener('click', function () { moveSelected(-1); });
    $('moveRight').addEventListener('click', function () { moveSelected(1); });
    wireDropTargets();

    $('startBtn').addEventListener('click', function () { send({ type: 'admin', action: 'start' }); });
    $('autoBtn').addEventListener('click', function () { send({ type: 'admin', action: 'auto' }); });
    $('randBtn').addEventListener('click', function () { send({ type: 'admin', action: 'rand' }); });
    $('resetBtn').addEventListener('click', function () { send({ type: 'admin', action: 'reset' }); });
    $('lockBtn').addEventListener('click', function () {
      send({ type: 'admin', action: 'lock', locked: !(info && info.teamsLocked) });
    });
    $('pickBtn').addEventListener('click', openStadiumDialog);

    // Only the host sees the picker, so this is host-only by construction.
    // Clearing the value lets the same file be chosen twice in a row.
    $('hbsFile').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = '';
      loadHbsFile(file);
    });

    $('pTime').addEventListener('change', function () { sendRoomSetting('pTime', 'timeLimit', 0, 60); });
    $('pScore').addEventListener('change', function () { sendRoomSetting('pScore', 'scoreLimit', 0, 50); });
    $('pMax').addEventListener('change', function () { sendRoomSetting('pMax', 'maxPlayers', 2, 24); });

    /* --- menu ------------------------------------------------------ */

    $('menuBtn').addEventListener('click', function () {
      $('mStop').classList.toggle('hidden', !isAdmin() || currentPhase() === 'waiting');
      openModal('menuDialog');
    });
    $('settingsBtn').addEventListener('click', openSettings);
    $('mResume').addEventListener('click', closeModals);
    $('mSettings').addEventListener('click', openSettings);
    $('mStop').addEventListener('click', function () {
      send({ type: 'admin', action: 'stop' });
      closeModals();
    });
    $('mLeave').addEventListener('click', function () { leaveRoom(false); });

    /* --- settings -------------------------------------------------- */

    document.querySelectorAll('.tabs .tab').forEach(function (tab) {
      tab.addEventListener('click', function () { setSettingsTab(tab.dataset.tab); });
    });

    SETTING_CHECKS.forEach(function (pair) {
      $(pair[0]).addEventListener('change', function () {
        settings[pair[1]] = $(pair[0]).checked;
        saveSettings();
        applySettings();
      });
    });

    $('sNick').addEventListener('change', function () { setNick($('sNick').value); });

    $('sChatLines').addEventListener('change', function () {
      settings.chatLines = clamp(Math.round(Number($('sChatLines').value) || 120), 20, 500);
      $('sChatLines').value = settings.chatLines;
      saveSettings();
    });

    $('sBgTheme').addEventListener('change', function () {
      var picked = $('sBgTheme').value;
      settings.bgTheme = BG_THEMES[picked] ? picked : 'wash';
      saveSettings();
      applySettings();
    });

    $('sAvatarFile').addEventListener('change', function () {
      var file = $('sAvatarFile').files && $('sAvatarFile').files[0];
      $('sAvatarFile').value = '';   // so choosing the same file twice still fires
      acceptAvatarFile(file);
    });

    $('sAvatarClear').addEventListener('click', function () {
      setAvatar('');
      toast('Ball image cleared.');
    });

    $('sDefaults').addEventListener('click', function () {
      settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      saveSettings();
      applySettings();
      fillSettingsForm();
      toast('Settings restored.');
    });

    /* --- misc ------------------------------------------------------ */

    $('helpLink').addEventListener('click', function (event) {
      event.preventDefault();
      openModal('helpDialog');
    });

    $('chatInput').addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeChat(); return; }
      if (event.key !== 'Enter') return;
      var text = $('chatInput').value.trim();
      if (text) send({ type: 'chat', text: text });
      $('chatInput').value = '';
      closeChat();
    });

    $('chatInput').addEventListener('focus', function () {
      document.body.classList.add('chat-open');
    });

    canvas.addEventListener('mousedown', function () { closeChat(); });

    // Right-clicking a disc out on the pitch opens the same menu.  A click
    // on empty grass is left to the browser's own menu.
    canvas.addEventListener('contextmenu', function (event) {
      var box = canvas.getBoundingClientRect();
      var who = playerAtScreen(event.clientX - box.left, event.clientY - box.top);
      if (!who || !isAdmin() || who.id === youId) return;
      openPlayerMenu(event, who);
    });

    // The menu is a passing thing: anything else the player does puts it away.
    document.addEventListener('mousedown', function (event) {
      if (menuEl && !menuEl.contains(event.target)) closePlayerMenu();
    });
    window.addEventListener('blur', closePlayerMenu);
    window.addEventListener('resize', closePlayerMenu);
    window.addEventListener('wheel', closePlayerMenu, { passive: true });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (menuEl) closePlayerMenu();
      else if (document.body.classList.contains('chat-open')) closeChat();
      else closeModals();
    });

    if (window.ResizeObserver) {
      new ResizeObserver(function () { if (info) resizeCanvas(); })
        .observe(canvas.parentElement);
    }

    setInterval(pumpInput, 40);
    setInterval(tickPing, 1000);
    setInterval(function () {
      if (!info && connected && settings.autoRefresh) requestRooms();
    }, 2000);

    // ?room=CODE turns a copied invite link straight into the join dialog.
    var invited = /[?&]room=([A-Za-z0-9]{6})/.exec(location.search);
    if (invited) openJoinDialog(invited[1].toUpperCase(), '');

    requestAnimationFrame(frame);
    connect();
  }

  boot();
})();
