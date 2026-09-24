<?php session_start(); if (!isset($_SESSION['nick'])) { $_SESSION['nick'] = 'Player' . rand(100, 999); } ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MiniBall</title>
<link rel="stylesheet" href="assets/style.css">
<link rel="icon" type="image/x-icon" href="assets/mb-favi.png">
</head>
<body>

<header class="topbar">
  <div class="brand"><img src="assets/mb-logo.png" alt="MiniBall"></div>
  <nav class="nav">
    <a href="#" class="active">Play</a>
    <a href="#" id="helpLink">Controls</a>
    <a href="#" id="aboutLink">About</a>
  </nav>
  <div class="conn" id="conn"><i></i><span id="connText">connecting…</span></div>
</header>

<main>

<!-- ============================ LOBBY ============================ -->
<section id="lobby" class="lobby">
  <div class="bar">
    <label class="field">
      <span>Nickname</span>
      <input id="nick" maxlength="16" autocomplete="off" spellcheck="false">
    </label>
    <div class="grow"></div>
    <button id="refreshBtn" class="btn">Refresh</button>
    <button id="joinBtn" class="btn">Join Room</button>
    <button id="createBtn" class="btn primary">Create Room</button>
  </div>

  <div class="table-wrap">
    <table class="rooms">
      <thead>
        <tr>
          <th class="c-name">Room Name</th>
          <th class="c-players">Players</th>
          <th class="c-map">Map</th>
          <th class="c-pass">Pass</th>
          <th class="c-time">Time</th>
          <th class="c-status">Status</th>
        </tr>
      </thead>
      <tbody id="roomRows"></tbody>
    </table>
    <p id="lobbyEmpty" class="empty">No rooms are open right now. Create one and send the 6&nbsp;character code to whoever you want to play with.</p>
  </div>
</section>

<!-- ============================ ROOM =============================
     The pitch fills the whole window.  Everything else — the score
     pill, the room panel, the chat — floats on top of it.
     ================================================================= -->
<section id="room" class="room hidden">
  <canvas id="pitch"></canvas>

  <div class="overlay hidden" id="overlay"><span id="overlayText"></span></div>

  <!-- Goal celebration: animated, in the colour of the team that scored. -->
  <div class="goalflash hidden" id="goalFlash">
    <div class="gf-main" id="gfMain">Red Scored!</div>
    <div class="gf-sub" id="gfSub"></div>
  </div>

  <!-- In-game chrome: score pill, clock, corner buttons, floating chat. -->
  <div class="game-ui" id="gameUi">
    <div class="hud-top">
      <div class="scorepill">
        <span class="pill-score red" id="redScore">0</span>
        <span class="pill-dash">-</span>
        <span class="pill-score blue" id="blueScore">0</span>
      </div>
      <div class="clockbox" id="clock">--:--</div>
      <div class="kobadge b-red hidden" id="koBadge"></div>
    </div>

    <div class="hud-right">
      <button id="menuBtn" class="gamebtn"><span class="gicon">&#9776;</span>Menu</button>
      <button id="settingsBtn" class="gamebtn square" title="Settings">&#9881;</button>
    </div>

    <div class="chatbox" id="chatBox">
      <div class="log" id="chatLog"></div>
      <div class="chat-entry">
        <input id="chatInput" maxlength="120" autocomplete="off" spellcheck="false" placeholder="Press Enter to chat">
      </div>
    </div>
  </div>

  <!-- Pre-game lobby: the room panel from HaxBall's own room dialog. -->
  <div class="waiting-ui" id="waitingUi">
    <div class="roompanel" id="roomPanel">
      <div class="rp-head">
        <b id="roomName" title="Room name">Room</b>
        <code id="roomCode" class="rp-code">------</code>
        <span id="rpScore" class="rp-score hidden"></span>
        <div class="grow"></div>
        <button id="linkBtn" class="gamebtn" title="Copy an invite link for this room">&#128279;Link</button>
        <button id="leaveBtn" class="gamebtn" title="Leave the room">&#9099;Leave</button>
      </div>

      <div class="rp-main">
        <div class="rp-tools">
          <button id="autoBtn" class="rp-tool" title="Fill up and even out the two teams">Auto</button>
          <button id="randBtn" class="rp-tool" title="Shuffle everyone between Red and Blue">Rand</button>
          <button id="lockBtn" class="rp-tool" title="Stop players from switching teams">Lock</button>
          <button id="resetBtn" class="rp-tool" title="Reset the score">Reset</button>
        </div>

        <div class="rp-centre">
          <div class="rp-grid">
            <div class="rp-colhead red">Red</div>
            <button class="rp-arrow" id="moveRight" title="Move the selected player one column to the right">&#9654;</button>
            <div class="rp-colhead">Spectators</div>
            <button class="rp-arrow" id="moveLeft" title="Move the selected player one column to the left">&#9664;</button>
            <div class="rp-colhead blue">Blue</div>

            <div class="rp-list" id="redList"></div>
            <div class="rp-arrowcell"></div>
            <div class="rp-list" id="specList"></div>
            <div class="rp-arrowcell"></div>
            <div class="rp-list" id="blueList"></div>
          </div>

          <div class="rp-settings">
            <div class="rp-row">
              <span>Time limit</span>
              <input type="number" id="pTime" min="0" max="60" step="1" inputmode="numeric">
              <i class="rp-hint">min, 0 = none</i>
            </div>
            <div class="rp-row">
              <span>Score limit</span>
              <input type="number" id="pScore" min="0" max="50" step="1" inputmode="numeric">
              <i class="rp-hint">goals, 0 = none</i>
            </div>
            <div class="rp-row">
              <span>Max players</span>
              <input type="number" id="pMax" min="2" max="24" step="1" inputmode="numeric">
              <i class="rp-hint">2 – 24</i>
            </div>
            <div class="rp-row">
              <span>Stadium</span>
              <b id="pStadium">Medium</b>
              <button id="pickBtn" class="btn small">Pick</button>
            </div>
          </div>

          <button id="startBtn" class="startbtn">&#9654; Start game</button>
        </div>
      </div>
    </div>
  </div>

  <!-- On-screen controls for fingers: a thumbstick that appears wherever the
       left thumb lands, and a kick button under the right one.  Fixed to the
       screen rather than drawn on the pitch, and they take no touches of
       their own — the canvas underneath reads the fingers. -->
  <div class="touchpad" id="touchPad">
    <div class="stick" id="stickBase"><div class="knob" id="stickKnob"></div></div>
    <div class="kickbtn" id="kickBtn"></div>
  </div>

  <div class="stats" id="stats">
    <div id="statPing" class="stat hidden"></div>
    <div id="statFps" class="stat hidden"></div>
  </div>
</section>

</main>

<!-- ========================== DIALOGS ============================ -->

<div id="createDialog" class="modal hidden">
  <div class="dialog">
    <h2>Create Room</h2>
    <label class="field"><span>Room name</span><input id="cName" maxlength="28" placeholder="My room"></label>
    <label class="field"><span>Password <i>(leave empty for a public room)</i></span><input id="cPass" maxlength="24" autocomplete="off"></label>
    <div class="grid2">
      <label class="field"><span>Max players</span>
        <select id="cMax">
          <option value="2">2</option>
          <option value="4">4</option>
          <option value="6">6</option>
          <option value="8" selected>8</option>
          <option value="10">10</option>
          <option value="12">12</option>
          <option value="16">16</option>
          <option value="24">24</option>
        </select>
      </label>
      <label class="field"><span>Map size</span>
        <select id="cMap">
          <option value="small">Small</option>
          <option value="medium" selected>Medium</option>
          <option value="big">Big</option>
        </select>
      </label>
    </div>
    <div class="grid2">
      <label class="field"><span>Time limit</span>
        <select id="cTime">
          <option value="0">No limit</option>
          <option value="3">3 minutes</option>
          <option value="5" selected>5 minutes</option>
          <option value="10">10 minutes</option>
          <option value="15">15 minutes</option>
        </select>
      </label>
      <label class="field"><span>Score limit</span>
        <select id="cScore">
          <option value="0">No limit</option>
          <option value="3">3 goals</option>
          <option value="5" selected>5 goals</option>
          <option value="10">10 goals</option>
        </select>
      </label>
    </div>
    <div class="actions">
      <button class="btn" data-close>Cancel</button>
      <button id="cSubmit" class="btn primary">Create</button>
    </div>
  </div>
</div>

<div id="joinDialog" class="modal hidden">
  <div class="dialog">
    <h2>Join Room</h2>
    <label class="field"><span>Room code</span><input id="joinCode" maxlength="6" spellcheck="false" placeholder="ABC123" style="text-transform:uppercase"></label>
    <label class="field"><span>Password <i>(only if the room has one)</i></span><input id="joinPassword" maxlength="24" type="password" autocomplete="off"></label>
    <p id="joinError" class="err hidden"></p>
    <div class="actions">
      <button class="btn" data-close>Cancel</button>
      <button id="jSubmit" class="btn primary">Join</button>
    </div>
  </div>
</div>

<!-- In-game menu, opened from the top right corner. -->
<div id="menuDialog" class="modal hidden">
  <div class="dialog narrow">
    <h2>Menu</h2>
    <div class="menulist">
      <button id="mResume" class="menubtn">Resume</button>
      <button id="mSettings" class="menubtn">Settings</button>
      <button id="mStop" class="menubtn hidden">Stop match and return to the room</button>
      <button id="mLeave" class="menubtn danger">Leave room</button>
    </div>
  </div>
</div>

<!-- General / Visual settings, persisted in localStorage. -->
<div id="settingsDialog" class="modal hidden">
  <div class="dialog settings">
    <h2>Settings</h2>
    <div class="tabs">
      <button class="tab active" data-tab="general">General</button>
      <button class="tab" data-tab="visual">Visual</button>
    </div>

    <div class="tabpage" data-page="general">
      <label class="srow">
        <span>Nickname</span>
        <input id="sNick" maxlength="16" autocomplete="off" spellcheck="false">
      </label>
      <label class="srow">
        <span>Join rooms as a spectator <i>(pick a team from the room panel instead)</i></span>
        <input type="checkbox" id="sSpec">
      </label>
      <label class="srow">
        <span>Refresh the room list automatically</span>
        <input type="checkbox" id="sAutoRefresh">
      </label>
      <label class="srow">
        <span>Keep this many chat lines <i>(20 – 500)</i></span>
        <input id="sChatLines" type="number" min="20" max="500" step="10">
      </label>
      <div class="srow avatar-row">
        <span>Your ball image <i>(PNG or GIF, up to 30&nbsp;KB — replaces your number)</i></span>
        <div class="avatar-ctl">
          <canvas id="sAvatarPreview" width="34" height="34"></canvas>
          <label class="btn small" for="sAvatarFile">Choose…</label>
          <input type="file" id="sAvatarFile" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
          <button id="sAvatarClear" class="btn small" type="button">Clear</button>
        </div>
      </div>
    </div>

    <div class="tabpage hidden" data-page="visual">
      <label class="srow">
        <span>Show the FPS counter</span>
        <input type="checkbox" id="sFps">
      </label>
      <label class="srow">
        <span>Show the ping counter</span>
        <input type="checkbox" id="sPing">
      </label>
      <label class="srow">
        <span>Show player names on the pitch</span>
        <input type="checkbox" id="sNames">
      </label>
      <label class="srow">
        <span>Number the players <i>(balls with an image show that instead)</i></span>
        <input type="checkbox" id="sNumbers">
      </label>
      <label class="srow">
        <span>Show chat messages during a match</span>
        <input type="checkbox" id="sChat">
      </label>
      <label class="srow">
        <span>Room background</span>
        <select id="sBgTheme"></select>
      </label>
      <label class="srow">
        <span>Touch controls <i>(thumbstick and kick button on the pitch)</i></span>
        <select id="sTouch"></select>
      </label>
      <label class="srow">
        <span>Grass stripes</span>
        <input type="checkbox" id="sStripes">
      </label>
      <label class="srow">
        <span>Highlight the player you control</span>
        <input type="checkbox" id="sSelf">
      </label>
    </div>

    <div class="actions">
      <button id="sDefaults" class="btn">Restore defaults</button>
      <div class="grow"></div>
      <button class="btn primary" data-close>Done</button>
    </div>
  </div>
</div>

<!-- Stadium picker, opened from the room panel's Pick button. -->
<div id="stadiumDialog" class="modal hidden">
  <div class="dialog">
    <h2>Pick stadium</h2>
    <div class="stadiums" id="stadiumList"></div>
    <div class="hbs-row">
      <label class="btn small" for="hbsFile">Load .hbs map&hellip;</label>
      <input type="file" id="hbsFile" accept=".hbs,.json,application/json" hidden>
      <span id="hbsHint" class="rp-hint"></span>
    </div>
    <div class="actions"><button class="btn primary" data-close>Close</button></div>
  </div>
</div>

<div id="helpDialog" class="modal hidden">
  <div class="dialog">
    <h2>Controls</h2>
    <table class="keys">
      <tr><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td>Move — arrow keys work too</td></tr>
      <tr><td><kbd>X</kbd> <kbd>Space</kbd></td><td>Kick — hold it to slow down and shoot harder</td></tr>
      <tr><td><kbd>Tab</kbd></td><td>Toggle the camera on your player, with an arrow pointing at the ball</td></tr>
      <tr><td><kbd>Enter</kbd></td><td>Open the chat box</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>Close the chat box or any dialog</td></tr>
    </table>
    <p class="note">Holding the kick key lowers your acceleration the way it does in HaxBall, so tap it when you want to sprint and hold it when you are lining up a shot. The look camera turns itself on by default whenever the window is too small to show the whole pitch, and Tab overrides that either way.</p>
    <p class="note">Admins can right-click a player — on their name in the room panel, or on their ball out on the pitch — to kick, ban, move them to another team or make them an admin. You cannot use it on yourself; use the panel's own arrows for that.</p>
    <div class="actions"><button class="btn primary" data-close>Got it</button></div>
  </div>
</div>

<div id="aboutDialog" class="modal hidden">
  <div class="dialog">
    <h2>About MiniBall</h2>
    <p class="about-p">MiniBall is a browser game in the spirit of HaxBall: two teams, one ball, a small pitch and a lot of shoving. It runs on a server that owns the physics — your browser sends key presses and the server works out where everyone ends up — so every player in a room sees the same match, on the same map, at the same moment.</p>
    <p class="about-p">Rooms open with one click and are shared by a six character code; there are no accounts and nothing to sign up for. Play on one of the built-in pitches or load your own HaxBall <code>.hbs</code> map, and the host — plus any admin they appoint — can move players between teams, kick, ban and start matches.</p>
    <p class="about-p">It is a hobby project, and not affiliated with HaxBall or its authors: the code and the art here are original.</p>
    <p class="about-credit">Made by <a href="https://github.com/prodbyeternal" target="_blank" rel="noopener noreferrer">eternal</a></p>
    <div class="actions"><button class="btn primary" data-close>Close</button></div>
  </div>
</div>

<div id="toast" class="toast hidden"></div>

<!-- The name PHP hands over, taken from the session.  A host without PHP (the
     node server, see renderPhp) drops this line whole and the client names
     itself instead — getNick copes either way. -->
<?php echo '<script>window.PLAYER_NICK = ' . json_encode(substr($_SESSION['nick'], 0, 16)) . ';</script>'; ?>

<script>
// Where the game server is.  Two shapes of deployment have to work:
//   * a host that gives the app one port (Railway, Fly, any HTTPS host) —
//     the page and the socket share an origin, so wss://<host> with no port;
//   * XAMPP, where Apache serves this page on 80 and node runs on 8080.
// A port that is neither 80 nor 8080 means the page itself came from the
// node server, so its own origin is the socket.
(function () {
  var port = location.port;
  var sameOrigin = location.protocol === 'https:' || (port !== '' && port !== '80' && port !== '8080');
  window.GAME_SERVER = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.hostname
    + (sameOrigin ? (port ? ':' + port : '') : ':8080');
})();
</script>
<script src="assets/game.js"></script>
</body>
</html>
