// ================================================================
//  PEW PEW AKIMBO — script.js
//  Webcam finger-gun shooting gallery  •  MediaPipe Hand Landmarker
// ================================================================

import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// ====================================================================
//  TUNABLE CONSTANTS  (tweak these to adjust feel & difficulty)
// ====================================================================

// --- Spawning ---
const INITIAL_SPAWN_INTERVAL = 800;     // ms between spawns at the start
const MIN_SPAWN_INTERVAL     = 200;     // fastest possible spawn interval
const SPAWN_INTERVAL_DECREASE = 80;     // ms shaved off per difficulty step
const DIFFICULTY_SCORE_STEP  = 150;     // every N points → one difficulty step
const MAX_TARGETS_ON_SCREEN  = 8;       // cap balloons on screen at once

// --- Target movement ---
const INITIAL_TARGET_SPEED   = 2.0;     // px / frame at the start
const MAX_TARGET_SPEED       = 6.0;     // speed cap
const TARGET_SPEED_INCREASE  = 0.35;    // added per difficulty step

// --- Target size ---
const TARGET_RADIUS_MIN = 72;           // smallest balloon radius (px) (bigger targets)
const TARGET_RADIUS_MAX = 130;          // largest balloon radius  (px) (bigger targets)

// --- Player ---
const STARTING_LIVES = 5;

// --- Scoring ---
const HIT_SCORE            = 10;
const COMBO_WINDOW_MS      = 1500;      // ms window to keep combo alive
const MAX_COMBO_MULTIPLIER = 10;

// --- Gesture detection ---
const FINGER_EXTEND_RATIO = 1.18;       // tip-dist / mcp-dist to count as extended (more lenient)
const FINGER_CURL_RATIO   = 1.22;       // tip-dist / mcp-dist to count as curled (more lenient)
const THUMB_DOWN_RATIO    = 0.42;       // thumb→index distance / handScale to count as "fired" (scale-invariant)
const THUMB_UP_RATIO      = 0.58;       // thumb→index distance / handScale to count as "cocked" (scale-invariant)
const FIRE_DEBOUNCE_MS    = 250;        // minimum ms between shots per hand
const HIT_RADIUS_BONUS    = 55;         // extra px added to balloon hitbox for forgiving aim (generous)

// --- Power-ups ---
const POWERUP_TYPES = ["freeze", "catpaws"];
const POWERUP_ICONS = { freeze: "🧊", catpaws: "🐾" };
const POWERUP_NAMES = { freeze: "FREEZE!", catpaws: "CAT PAWS!" };
const POWERUP_COLORS = { freeze: "#00e5ff", catpaws: "#ff9cf5" };
const POWERUP_DURATIONS = { freeze: 5000, catpaws: 8000 };
const POWERUP_DESCS = {
  freeze: "All balloons freeze in place for 5s",
  catpaws: "Giant paw auto-pops on contact — no trigger needed!"
};
const POWERUP_ORB_RADIUS = 38;
const POWERUP_ORB_SPEED  = 1.5;
const COMBO_POWERUP_THRESHOLD = 5;       // combo level that spawns a power-up
const MERCY_POWERUP_CHANCE    = 0.5;     // 50% chance on life lost

// --- Verdict lines (edit freely) ---
const VERDICTS = [
  "Not bad for a rookie! 🤠",
  "Fastest fingers in the West! 🌵",
  "You call that shooting?! Try again! 😤",
  "Annie Oakley would be proud! 🎯",
  "Your trigger fingers need more yoga 🧘",
  "Dual-wielding legend! 💥",
  "The balloons barely felt that… 🎈",
  "Pew pew perfection! ✨",
  "You're a menace to balloons everywhere! 🎪",
  "Two guns, one absolute legend! 🔥",
  "Not a single balloon is safe! 💀",
  "Certified akimbo master! 🏆",
];

// ====================================================================
//  DOM REFERENCES
// ====================================================================

const video  = document.getElementById("webcam");
const canvas = document.getElementById("gameCanvas");
const ctx    = canvas.getContext("2d");

const titleScreen    = document.getElementById("titleScreen");
const loadingScreen  = document.getElementById("loadingScreen");
const deniedScreen   = document.getElementById("deniedScreen");
const gameOverScreen = document.getElementById("gameOverScreen");
const hud            = document.getElementById("hud");

const startBtn   = document.getElementById("startBtn");
const restartBtn = document.getElementById("restartBtn");
const retryBtn   = document.getElementById("retryBtn");

const scoreValueEl    = document.getElementById("scoreValue");
const comboDisplayEl  = document.getElementById("comboDisplay");
const comboValueEl    = document.getElementById("comboValue");
const livesDisplayEl  = document.getElementById("livesDisplay");
const finalScoreValEl = document.getElementById("finalScoreValue");
const verdictTextEl   = document.getElementById("verdictText");
const leftIndicator   = document.getElementById("leftIndicator");
const rightIndicator  = document.getElementById("rightIndicator");

const highScoreForm       = document.getElementById("highScoreForm");
const playerNameInput     = document.getElementById("playerNameInput");
const submitScoreBtn       = document.getElementById("submitScoreBtn");
const leaderboardSection  = document.getElementById("leaderboardSection");
const leaderboardLoading  = document.getElementById("leaderboardLoading");
const leaderboardTable    = document.getElementById("leaderboardTable");
const leaderboardBody     = document.getElementById("leaderboardBody");

// ====================================================================
//  GAME STATE
// ====================================================================

let gameState      = "TITLE"; // TITLE | LOADING | PLAYING | GAME_OVER
let handLandmarker = null;
let score          = 0;
let lives          = STARTING_LIVES;
let combo          = 0;
let lastHitTime    = 0;
let difficultyLevel = 0;
let lastSpawnTime  = 0;
let lastTimestamp   = 0;

// Object pools
let targets       = [];
let particles     = [];
let floatingTexts = [];
let muzzleFlashes = [];
let powerUpOrbs   = [];

// Power-up state
let activePowerUp        = null;  // { type, endTime }
let powerUpAnnouncement  = null;  // { type, startTime, duration }
let comboRewardGiven     = false; // prevent multiple orbs per combo streak


// Per-hand state
const handState = {
  Left:  { x: 0, y: 0, detected: false, isFingerGun: false, wasThumbUp: false, lastFireTime: 0 },
  Right: { x: 0, y: 0, detected: false, isFingerGun: false, wasThumbUp: false, lastFireTime: 0 },
};

// Screen-shake
let shakeIntensity = 0;
const SHAKE_DECAY  = 0.88;

// Audio
let audioCtx = null;

// Balloon palette
const BALLOON_COLORS = [
  "#ff006e", "#fb5607", "#ffbe0b", "#8338ec",
  "#3a86ff", "#06d6a0", "#ef476f", "#118ab2",
  "#ff595e", "#ffca3a", "#8ac926", "#6a4c93",
];

// ====================================================================
//  AUDIO (synthesised — no external files)
// ====================================================================

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function playPewSound() {
  ensureAudio();
  const t = audioCtx.currentTime;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain).connect(audioCtx.destination);
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(140, t + 0.12);
  gain.gain.setValueAtTime(0.14, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.start(t);
  osc.stop(t + 0.13);
}

function playPopSound() {
  ensureAudio();
  const t = audioCtx.currentTime;

  // Noise burst
  const len    = audioCtx.sampleRate * 0.07;
  const buf    = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data   = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.5;
  const noise  = audioCtx.createBufferSource();
  noise.buffer = buf;
  const nGain  = audioCtx.createGain();
  nGain.gain.setValueAtTime(0.28, t);
  nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  const hp = audioCtx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 900;
  noise.connect(hp).connect(nGain).connect(audioCtx.destination);
  noise.start(t); noise.stop(t + 0.08);

  // Tonal "pop"
  const osc  = audioCtx.createOscillator();
  const oGain = audioCtx.createGain();
  osc.connect(oGain).connect(audioCtx.destination);
  osc.frequency.setValueAtTime(620, t);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.06);
  oGain.gain.setValueAtTime(0.13, t);
  oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  osc.start(t); osc.stop(t + 0.07);
}

function playMissSound() {
  ensureAudio();
  const t = audioCtx.currentTime;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain).connect(audioCtx.destination);
  osc.type = "sine";
  osc.frequency.setValueAtTime(320, t);
  osc.frequency.exponentialRampToValueAtTime(90, t + 0.35);
  gain.gain.setValueAtTime(0.10, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  osc.start(t); osc.stop(t + 0.36);
}

// ====================================================================
//  HELPERS
// ====================================================================

function dist3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function dist2D(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Map a MediaPipe normalised landmark to on-screen canvas coordinates,
 *  accounting for CSS `object-fit: cover` and the horizontal mirror. */
function landmarkToScreen(lm) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const sw = canvas.width;
  const sh = canvas.height;
  if (!vw || !vh) return { x: 0, y: 0 };

  const scale = Math.max(sw / vw, sh / vh);
  const offX  = (vw * scale - sw) / 2;
  const offY  = (vh * scale - sh) / 2;

  // Mirror x so that canvas matches the CSS-flipped video
  return {
    x: sw - (lm.x * vw * scale - offX),
    y: lm.y * vh * scale - offY,
  };
}

// Colour utilities
function lightenHex(hex, amt = 50) {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amt);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amt);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amt);
  return `rgb(${r},${g},${b})`;
}

function darkenHex(hex, amt = 40) {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amt);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amt);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amt);
  return `rgb(${r},${g},${b})`;
}

// ====================================================================
//  CANVAS SIZE
// ====================================================================

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ====================================================================
//  MEDIAPIPE INIT
// ====================================================================

async function initMediaPipe() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
  });
}

// ====================================================================
//  CAMERA INIT
// ====================================================================

async function initCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  await new Promise((res) => (video.onloadeddata = res));
}

// ====================================================================
//  GESTURE DETECTION
// ====================================================================

function detectFingerGun(lm) {
  const w = lm[0]; // wrist

  // Index extended
  const idxExt = dist3D(lm[8], w) > dist3D(lm[5], w) * FINGER_EXTEND_RATIO;

  // Middle, ring, pinky curled
  const midCurl = dist3D(lm[12], w) < dist3D(lm[9],  w) * FINGER_CURL_RATIO;
  const rngCurl = dist3D(lm[16], w) < dist3D(lm[13], w) * FINGER_CURL_RATIO;
  const pnkCurl = dist3D(lm[20], w) < dist3D(lm[17], w) * FINGER_CURL_RATIO;

  return idxExt && midCurl && rngCurl && pnkCurl;
}

function getThumbDistRatio(lm) {
  const handScale = dist3D(lm[5], lm[0]) || 1; // wrist to index knuckle
  return dist3D(lm[4], lm[6]) / handScale;     // thumb tip to index PIP joint distance ratio
}

function isThumbDown(lm) {
  return getThumbDistRatio(lm) < THUMB_DOWN_RATIO;
}

function isThumbUp(lm) {
  return getThumbDistRatio(lm) > THUMB_UP_RATIO;
}

function processHandResults(results, ts) {
  // Reset flags
  handState.Left.detected  = handState.Right.detected  = false;
  handState.Left.isFingerGun = handState.Right.isFingerGun = false;

  if (!results.landmarks || results.landmarks.length === 0) return;

  // Build array & sort by screen-x so leftmost hand → "Left"
  const detected = results.landmarks.map((lm) => ({
    lm,
    pos: landmarkToScreen(lm[8]),
  }));
  detected.sort((a, b) => a.pos.x - b.pos.x);

  const slots = ["Left", "Right"];

  // Special case: one hand → assign by screen half
  if (detected.length === 1) {
    slots[0] = detected[0].pos.x < canvas.width / 2 ? "Left" : "Right";
  }

  for (let i = 0; i < detected.length && i < 2; i++) {
    const label = slots[i];
    const hand  = handState[label];
    const { lm, pos } = detected[i];

    hand.x = pos.x;
    hand.y = pos.y;
    hand.detected = true;
    hand.isFingerGun = detectFingerGun(lm);

    // Trigger check (only while playing)
    if (gameState === "PLAYING") {
      const isIndexExtended = dist3D(lm[8], lm[0]) > dist3D(lm[5], lm[0]) * FINGER_EXTEND_RATIO;

      if (hand.isFingerGun && isThumbUp(lm)) {
        hand.wasThumbUp = true;
      } else if (isIndexExtended && isThumbDown(lm) && hand.wasThumbUp && ts - hand.lastFireTime > FIRE_DEBOUNCE_MS) {
        hand.wasThumbUp  = false;
        hand.lastFireTime = ts;
        fireShot(hand, label, lm);
      }
    }
  }
}

// ====================================================================
//  SHOOTING
// ====================================================================

const AIM_RAY_LENGTH   = 1200;  // how far (px) to project the aim ray forward
const AUTO_AIM_RADIUS  = 250;   // if no direct hit, snap to nearest balloon within this range

function fireShot(hand, label, lm) {
  playPewSound();

  // --- Compute aim point via ray projection ---
  // Use index finger MCP (5) → TIP (8) direction, projected forward
  const mcp = landmarkToScreen(lm[5]);
  const tip = landmarkToScreen(lm[8]);
  const dx  = tip.x - mcp.x;
  const dy  = tip.y - mcp.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx  = dx / len;
  const ny  = dy / len;

  // Project aim point far ahead of the fingertip
  const aimX = tip.x + nx * AIM_RAY_LENGTH;
  const aimY = tip.y + ny * AIM_RAY_LENGTH;

  // Muzzle flash at fingertip
  muzzleFlashes.push({
    x: hand.x, y: hand.y, life: 1,
    color: label === "Left" ? "#00f5ff" : "#ff00ff",
  });

  // --- Hit test along the ray (piercing — pops ALL balloons the ray touches) ---
  // First check power-up orbs
  tryShootPowerUpOrb(hand);

  const hitTargets = [];

  for (const t of targets) {
    if (!t.alive) continue;

    // Point-to-line-segment distance from balloon center to the ray
    const segDist = pointToSegmentDist(t.x, t.y, tip.x, tip.y, aimX, aimY);
    if (segDist < t.radius + HIT_RADIUS_BONUS) {
      hitTargets.push(t);
    }
  }

  // --- Auto-aim fallback: if ray missed everything, snap to nearest balloon ---
  if (hitTargets.length === 0) {
    let bestTarget = null;
    let bestDist   = Infinity;
    for (const t of targets) {
      if (!t.alive) continue;
      const dTip = dist2D(hand.x, hand.y, t.x, t.y);
      const dAim = dist2D(aimX, aimY, t.x, t.y);
      const dMin = Math.min(dTip, dAim);
      if (dMin < AUTO_AIM_RADIUS && dMin < bestDist) {
        bestTarget = t;
        bestDist   = dMin;
      }
    }
    if (bestTarget) hitTargets.push(bestTarget);
  }

  // Pop all hit balloons
  for (const t of hitTargets) destroyTarget(t);
}

/** Shortest distance from point (px,py) to line segment (x1,y1)→(x2,y2) */
function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const sdx = x2 - x1, sdy = y2 - y1;
  const lenSq = sdx * sdx + sdy * sdy;
  if (lenSq === 0) return dist2D(px, py, x1, y1);
  let t = ((px - x1) * sdx + (py - y1) * sdy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist2D(px, py, x1 + t * sdx, y1 + t * sdy);
}

function destroyTarget(target) {
  target.alive = false;
  playPopSound();

  // Combo
  const now = performance.now();
  combo = (now - lastHitTime < COMBO_WINDOW_MS)
    ? Math.min(combo + 1, MAX_COMBO_MULTIPLIER)
    : 1;
  lastHitTime = now;

  // Score
  const pts = HIT_SCORE * combo;
  score += pts;

  // Difficulty ramp
  difficultyLevel = Math.floor(score / DIFFICULTY_SCORE_STEP);

  // HUD
  updateScoreDisplay();

  // Effects
  createHitEffect(target.x, target.y, target.color, target.radius);
  floatingTexts.push({
    x: target.x, y: target.y,
    text: `+${pts}`,
    color: combo > 1 ? "#ff006e" : "#ffd700",
    life: 1,
    scale: 1 + combo * 0.08,
    vy: -2.5,
  });

  shakeIntensity = Math.min(3 + combo * 1.2, 14);

  scoreValueEl.classList.add("pop");
  setTimeout(() => scoreValueEl.classList.remove("pop"), 120);
  // --- Combo power-up reward ---
  if (combo >= COMBO_POWERUP_THRESHOLD && !comboRewardGiven && !activePowerUp) {
    comboRewardGiven = true;
    spawnPowerUpOrb();
  }
}

// ====================================================================
//  TARGET SYSTEM
// ====================================================================

function spawnTarget() {
  const fromLeft = Math.random() < 0.5;
  const r = rand(TARGET_RADIUS_MIN, TARGET_RADIUS_MAX);
  const spd = Math.min(INITIAL_TARGET_SPEED + difficultyLevel * TARGET_SPEED_INCREASE, MAX_TARGET_SPEED);

  targets.push({
    x: fromLeft ? -r : canvas.width + r,
    y: rand(r + 70, canvas.height - r - 110),
    radius: r,
    speed: spd * (fromLeft ? 1 : -1),
    vy: 0,                                    // vertical velocity (used by collisions)
    color: pick(BALLOON_COLORS),
    alive: true,
    wobbleOff:   Math.random() * Math.PI * 2,
    wobbleSpeed: rand(0.02, 0.05),
    wobbleAmp:   rand(12, 35),
    rotation:      0,
    rotationSpeed: rand(-0.015, 0.015),
  });
}

function updateTargets() {
  // --- Move ---
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    if (!t.alive) { targets.splice(i, 1); continue; }

    t.x += t.speed;
    t.wobbleOff += t.wobbleSpeed;
    t.y += Math.sin(t.wobbleOff) * 0.7 + t.vy;
    t.vy *= 0.92;                              // dampen vertical velocity
    t.rotation += t.rotationSpeed;

    // Clamp to screen top/bottom so collisions don't push balloons off-screen
    t.y = Math.max(t.radius + 20, Math.min(canvas.height - t.radius - 60, t.y));

    const escaped =
      (t.speed > 0 && t.x > canvas.width  + t.radius + 20) ||
      (t.speed < 0 && t.x < -t.radius - 20);

    if (escaped) {
      targets.splice(i, 1);
      loseLife();
    }
  }

  // --- Balloon-to-balloon collision ---
  for (let i = 0; i < targets.length; i++) {
    const a = targets[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < targets.length; j++) {
      const b = targets[j];
      if (!b.alive) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minDist = a.radius + b.radius;

      if (dist < minDist && dist > 0) {
        // Normalised collision axis
        const nx = dx / dist;
        const ny = dy / dist;

        // Gently push apart (half the overlap each)
        const overlap = (minDist - dist) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;

        // No horizontal speed change — balloons keep their travel direction
        // Just a gentle vertical nudge so they separate visually
        const pushStrength = 0.5;
        a.vy -= ny * pushStrength;
        b.vy += ny * pushStrength;

        // Clamp vertical velocity so collisions never launch balloons
        a.vy = Math.max(-2, Math.min(2, a.vy));
        b.vy = Math.max(-2, Math.min(2, b.vy));
      }
    }
  }
}

function loseLife() {
  lives--;
  playMissSound();
  shakeIntensity = 10;
  updateLivesDisplay();
  if (lives <= 0) { endGame(); return; }

  // --- Mercy power-up drop ---
  if (Math.random() < MERCY_POWERUP_CHANCE && !activePowerUp && powerUpOrbs.length === 0) {
    spawnPowerUpOrb();
  }
}

// ====================================================================
//  POWER-UP SYSTEM
// ====================================================================

function spawnPowerUpOrb() {
  const type = pick(POWERUP_TYPES);
  const fromLeft = Math.random() < 0.5;
  powerUpOrbs.push({
    x: fromLeft ? -POWERUP_ORB_RADIUS : canvas.width + POWERUP_ORB_RADIUS,
    y: rand(120, canvas.height - 200),
    type,
    speed: POWERUP_ORB_SPEED * (fromLeft ? 1 : -1),
    alive: true,
    bobOff: Math.random() * Math.PI * 2,
    glowPhase: 0,
  });
}

function updatePowerUpOrbs() {
  for (let i = powerUpOrbs.length - 1; i >= 0; i--) {
    const orb = powerUpOrbs[i];
    if (!orb.alive) { powerUpOrbs.splice(i, 1); continue; }
    orb.x += orb.speed;
    orb.bobOff += 0.04;
    orb.y += Math.sin(orb.bobOff) * 0.8;
    orb.glowPhase += 0.06;

    // Remove if escaped off-screen
    if (orb.x < -80 || orb.x > canvas.width + 80) {
      powerUpOrbs.splice(i, 1);
    }
  }
}

function tryShootPowerUpOrb(hand) {
  for (const orb of powerUpOrbs) {
    if (!orb.alive) continue;
    if (dist2D(hand.x, hand.y, orb.x, orb.y) < POWERUP_ORB_RADIUS + HIT_RADIUS_BONUS) {
      orb.alive = false;
      activatePowerUp(orb.type);
      return true;
    }
  }
  return false;
}

function activatePowerUp(type) {
  activePowerUp = {
    type,
    endTime: performance.now() + POWERUP_DURATIONS[type],
  };

  // Announce centrally
  powerUpAnnouncement = {
    type,
    startTime: performance.now(),
    duration: 2500, // 2.5 seconds prominent display
  };

  // Freeze: stop all balloons
  if (type === "freeze") {
    for (const t of targets) {
      t._savedSpeed = t.speed;
      t.speed = 0;
      t._savedWobbleSpeed = t.wobbleSpeed;
      t.wobbleSpeed = 0;
    }
  }

  playPopSound();
  shakeIntensity = 8;
}

function deactivatePowerUp() {
  if (!activePowerUp) return;

  // Unfreeze
  if (activePowerUp.type === "freeze") {
    for (const t of targets) {
      if (t._savedSpeed !== undefined) t.speed = t._savedSpeed;
      if (t._savedWobbleSpeed !== undefined) t.wobbleSpeed = t._savedWobbleSpeed;
    }
  }

  activePowerUp = null;
}

function isPowerUpActive(type) {
  return activePowerUp && activePowerUp.type === type;
}

function updatePowerUps() {
  if (activePowerUp && performance.now() > activePowerUp.endTime) {
    deactivatePowerUp();
  }

  // Reset combo reward flag when combo drops
  if (combo < COMBO_POWERUP_THRESHOLD) {
    comboRewardGiven = false;
  }

  // --- Cat Paws: auto-pop on proximity (no trigger needed) ---
  if (isPowerUpActive("catpaws")) {
    const pawRadius = 90;
    for (const label of ["Left", "Right"]) {
      const hand = handState[label];
      if (!hand.detected) continue;
      for (const t of targets) {
        if (!t.alive) continue;
        if (dist2D(hand.x, hand.y, t.x, t.y) < t.radius + pawRadius) {
          destroyTarget(t);
        }
      }
    }
  }

  // --- Freeze: ensure newly spawned balloons also freeze ---
  if (isPowerUpActive("freeze")) {
    for (const t of targets) {
      if (t._savedSpeed === undefined) {
        t._savedSpeed = t.speed;
        t._savedWobbleSpeed = t.wobbleSpeed;
        t.speed = 0;
        t.wobbleSpeed = 0;
      }
    }
  }
}

function drawPowerUpOrbs() {
  for (const orb of powerUpOrbs) {
    if (!orb.alive) continue;
    const { x, y, type, glowPhase } = orb;
    const pulse = 1 + Math.sin(glowPhase) * 0.15;
    const r = POWERUP_ORB_RADIUS * pulse;
    const color = POWERUP_COLORS[type];

    ctx.save();

    // Outer glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 25 + Math.sin(glowPhase * 1.5) * 10;

    // Orb body
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, color + "44");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Icon
    ctx.shadowBlur = 0;
    ctx.font = "28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(POWERUP_ICONS[type], x, y);

    // Sparkle ring
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.4 + Math.sin(glowPhase * 2) * 0.3;
    ctx.beginPath();
    ctx.arc(x, y, r + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();
  }
}

function drawActivePowerUpHUD() {
  if (!activePowerUp) return;
  const { type, endTime } = activePowerUp;
  const remaining = Math.max(0, endTime - performance.now());
  const total = POWERUP_DURATIONS[type];
  const pct = remaining / total;
  const color = POWERUP_COLORS[type];

  // Timer bar at top of screen
  const barW = canvas.width * 0.3;
  const barH = 8;
  const barX = (canvas.width - barW) / 2;
  const barY = 18;

  ctx.save();
  // Background
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 4);
  ctx.fill();
  // Fill
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW * pct, barH, 4);
  ctx.fill();
  // Label
  ctx.shadowBlur = 0;
  ctx.font = "bold 14px Orbitron, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
  ctx.lineWidth = 3;
  ctx.strokeText(`${POWERUP_ICONS[type]} ${POWERUP_NAMES[type]}`, canvas.width / 2, barY - 4);
  ctx.fillStyle = color;
  ctx.fillText(`${POWERUP_ICONS[type]} ${POWERUP_NAMES[type]}`, canvas.width / 2, barY - 4);

  // Description
  ctx.font = "12px Orbitron, sans-serif";
  ctx.textBaseline = "top";
  ctx.strokeText(POWERUP_DESCS[type], canvas.width / 2, barY + barH + 6);
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillText(POWERUP_DESCS[type], canvas.width / 2, barY + barH + 6);

  ctx.restore();
}

function drawPowerUpAnnouncement() {
  if (!powerUpAnnouncement) return;
  const now = performance.now();
  const elapsed = now - powerUpAnnouncement.startTime;
  const { type, duration } = powerUpAnnouncement;

  if (elapsed >= duration) {
    powerUpAnnouncement = null;
    return;
  }

  // Compute alpha and scale
  let alpha = 1;
  let scale = 1;

  const fadeInTime = 300;
  const fadeOutTime = 400;

  if (elapsed < fadeInTime) {
    const t = elapsed / fadeInTime;
    alpha = t;
    scale = 0.85 + 0.15 * t; // ease scale up
  } else if (elapsed > duration - fadeOutTime) {
    const t = (duration - elapsed) / fadeOutTime;
    alpha = t;
    scale = 1.0 + 0.05 * (1 - t); // slight expand as it fades
  }

  const color = POWERUP_COLORS[type];
  const title = `${POWERUP_ICONS[type]} ${POWERUP_NAMES[type]}`;
  const desc = POWERUP_DESCS[type];

  ctx.save();
  ctx.globalAlpha = alpha;

  const centerY = canvas.height / 2;
  const bannerHeight = 160;

  // 1. Draw glowing background banner
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  ctx.fillRect(0, centerY - bannerHeight / 2, canvas.width, bannerHeight);

  // Banner border lines (top and bottom) with powerup color glow
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.shadowColor = color;
  ctx.shadowBlur = 15;

  ctx.beginPath();
  ctx.moveTo(0, centerY - bannerHeight / 2);
  ctx.lineTo(canvas.width, centerY - bannerHeight / 2);
  ctx.moveTo(0, centerY + bannerHeight / 2);
  ctx.lineTo(canvas.width, centerY + bannerHeight / 2);
  ctx.stroke();

  // 2. Draw Title and Description with scale transform centered
  ctx.translate(canvas.width / 2, centerY);
  ctx.scale(scale, scale);

  // Draw Title
  ctx.shadowColor = color;
  ctx.shadowBlur = 20;
  ctx.font = "900 44px Orbitron, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = color;
  ctx.fillText(title, 0, -8);

  // Draw Description
  ctx.shadowBlur = 10;
  ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
  ctx.font = "bold 18px Orbitron, sans-serif";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(desc, 0, 8);

  ctx.restore();
}

function drawCatPawCrosshair(hand) {
  const { x, y } = hand;
  const time = performance.now() * 0.003;
  const sz = 55 + Math.sin(time * 2) * 5;

  ctx.save();
  ctx.globalAlpha = 0.85;

  // Paw pad glow
  ctx.shadowColor = "#ff9cf5";
  ctx.shadowBlur = 25;
  ctx.fillStyle = "rgba(255,156,245,0.3)";
  ctx.beginPath();
  ctx.arc(x, y, sz, 0, Math.PI * 2);
  ctx.fill();

  // Paw emoji
  ctx.shadowBlur = 0;
  ctx.font = `${Math.floor(sz * 1.2)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("🐾", x, y);

  ctx.restore();
}



// ====================================================================
//  EFFECTS
// ====================================================================

function createHitEffect(x, y, color, r) {
  const n = 14 + Math.floor(r / 4);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = rand(2, 8);
    particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s - 2,
      radius: rand(2, 5.5),
      color,
      life: 1,
      decay: rand(0.016, 0.04),
      gravity: 0.14,
    });
  }
  // Expanding ring
  particles.push({
    x, y, vx: 0, vy: 0,
    radius: r * 0.5,
    maxRadius: r * 2.5,
    color,
    life: 1,
    decay: 0.045,
    isRing: true,
    gravity: 0,
  });
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= p.decay;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    if (p.isRing) {
      p.radius = lerp(p.radius, p.maxRadius, 0.1);
    } else {
      p.x += p.vx; p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.98;
    }
  }
}

function updateMuzzleFlashes() {
  for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
    muzzleFlashes[i].life -= 0.09;
    if (muzzleFlashes[i].life <= 0) muzzleFlashes.splice(i, 1);
  }
}

function updateFloatingTexts() {
  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const ft = floatingTexts[i];
    ft.y += ft.vy;
    ft.life -= 0.018;
    if (ft.life <= 0) floatingTexts.splice(i, 1);
  }
}

// ====================================================================
//  RENDERING
// ====================================================================

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // --- Screen shake transform ---
  const shaking = shakeIntensity > 0.4;
  if (shaking) {
    const sx = (Math.random() - 0.5) * shakeIntensity * 2;
    const sy = (Math.random() - 0.5) * shakeIntensity * 2;
    ctx.save();
    ctx.translate(sx, sy);
    shakeIntensity *= SHAKE_DECAY;
  }

  // Light overlay for contrast
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Vignette
  drawVignette();

  // Targets
  for (const t of targets) if (t.alive) drawBalloon(t);

  // Particles
  for (const p of particles) {
    ctx.globalAlpha = p.life;
    if (p.isRing) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius * p.life, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Muzzle flashes
  for (const mf of muzzleFlashes) {
    const r = 22 + (1 - mf.life) * 35;
    const g = ctx.createRadialGradient(mf.x, mf.y, 0, mf.x, mf.y, r);
    g.addColorStop(0, mf.color);
    g.addColorStop(0.35, mf.color + "88");
    g.addColorStop(1, "transparent");
    ctx.globalAlpha = mf.life;
    ctx.fillStyle = g;
    ctx.fillRect(mf.x - r, mf.y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  // Floating score texts
  for (const ft of floatingTexts) {
    ctx.globalAlpha = ft.life;
    const sz = Math.floor(22 * ft.scale);
    ctx.font = `bold ${sz}px Orbitron, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3;
    ctx.strokeText(ft.text, ft.x, ft.y);
    ctx.fillStyle = ft.color;
    ctx.fillText(ft.text, ft.x, ft.y);
    ctx.globalAlpha = 1;
  }

  // Power-up orbs
  drawPowerUpOrbs();

  // Crosshairs (swap for cat paws when active)
  if (isPowerUpActive("catpaws")) {
    if (handState.Left.detected)  drawCatPawCrosshair(handState.Left);
    if (handState.Right.detected) drawCatPawCrosshair(handState.Right);
  } else {
    if (handState.Left.detected)  drawCrosshair(handState.Left,  "#00f5ff", handState.Left.isFingerGun);
    if (handState.Right.detected) drawCrosshair(handState.Right, "#ff00ff", handState.Right.isFingerGun);
  }

  // Active power-up HUD timer
  drawActivePowerUpHUD();

  // Freeze overlay
  if (isPowerUpActive("freeze")) {
    ctx.fillStyle = "rgba(0, 200, 255, 0.06)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (shaking) ctx.restore();

  // Screen-centered announcement (not affected by shake, drawn on top of everything)
  drawPowerUpAnnouncement();
}

// --- Balloon ---
function drawBalloon(t) {
  const { x, y, radius: r, color, rotation } = t;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);

  // Glow
  ctx.shadowColor = color;
  ctx.shadowBlur  = 18;

  // Body
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  const bg = ctx.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.08, 0, 0, r);
  bg.addColorStop(0, lightenHex(color, 55));
  bg.addColorStop(0.65, color);
  bg.addColorStop(1, darkenHex(color, 30));
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Highlight
  ctx.beginPath();
  ctx.ellipse(-r * 0.28, -r * 0.3, r * 0.13, r * 0.22, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fill();

  // Knot
  ctx.beginPath();
  ctx.moveTo(-3, r);
  ctx.lineTo(0, r + 7);
  ctx.lineTo(3, r);
  ctx.closePath();
  ctx.fillStyle = darkenHex(color, 45);
  ctx.fill();

  // String
  const now = performance.now() * 0.003;
  ctx.beginPath();
  ctx.moveTo(0, r + 7);
  ctx.quadraticCurveTo(
    Math.sin(now + t.wobbleOff) * 7, r + 24,
    Math.sin(now + t.wobbleOff + 1) * 4, r + 42,
  );
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1.3;
  ctx.stroke();

  ctx.restore();
}

// --- Crosshair ---
function drawCrosshair(hand, color, active) {
  const { x, y } = hand;
  const sz    = active ? 28 : 20;
  const alpha = active ? 1 : 0.35;
  const time  = performance.now() * 0.002;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.shadowColor = color;
  ctx.shadowBlur  = active ? 16 : 5;

  // Static cross
  const gap = 8;
  ctx.lineWidth = active ? 2.2 : 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y - sz - 5); ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap);    ctx.lineTo(x, y + sz + 5);
  ctx.moveTo(x - sz - 5, y); ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y);    ctx.lineTo(x + sz + 5, y);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(x, y, sz, 0, Math.PI * 2);
  ctx.lineWidth = active ? 2 : 1;
  ctx.stroke();

  // Rotating tick marks (only when gun pose active)
  if (active) {
    const dir = color === "#00f5ff" ? 1 : -1;
    for (let i = 0; i < 4; i++) {
      const a  = time * dir + (Math.PI / 2) * i + Math.PI / 4;
      const r1 = sz + 4;
      const r2 = sz + 10;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
      ctx.lineTo(x + Math.cos(a) * r2, y + Math.sin(a) * r2);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // Center dot
  ctx.beginPath();
  ctx.arc(x, y, active ? 3 : 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// --- Vignette overlay ---
function drawVignette() {
  const w = canvas.width, h = canvas.height;
  const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.25, w / 2, h / 2, w * 0.75);
  g.addColorStop(0, "transparent");
  g.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// ====================================================================
//  HUD UPDATES
// ====================================================================

function updateScoreDisplay() {
  scoreValueEl.textContent = score;
  if (combo > 1) {
    comboDisplayEl.classList.remove("hidden");
    comboValueEl.textContent = `x${combo}`;
  } else {
    comboDisplayEl.classList.add("hidden");
  }
}

function updateLivesDisplay() {
  livesDisplayEl.innerHTML = "";
  for (let i = 0; i < STARTING_LIVES; i++) {
    const s = document.createElement("span");
    s.className = "life" + (i >= lives ? " lost" : "");
    s.textContent = "❤️";
    livesDisplayEl.appendChild(s);
  }
}

function updateHandIndicators() {
  leftIndicator.classList.toggle("active",  handState.Left.detected  && handState.Left.isFingerGun);
  rightIndicator.classList.toggle("active", handState.Right.detected && handState.Right.isFingerGun);
}

// ====================================================================
//  GAME FLOW
// ====================================================================

async function startGame() {
  gameState = "LOADING";
  titleScreen.classList.add("hidden");
  loadingScreen.classList.remove("hidden");

  try {
    await initCamera();
    await initMediaPipe();

    loadingScreen.classList.add("hidden");
    resetGame();
    gameState = "PLAYING";
    hud.classList.remove("hidden");
    requestAnimationFrame(gameLoop);
  } catch (err) {
    console.error("Init failed:", err);
    loadingScreen.classList.add("hidden");
    deniedScreen.classList.remove("hidden");
  }
}

function resetGame() {
  score = 0;
  lives = STARTING_LIVES;
  combo = 0;
  lastHitTime     = 0;
  difficultyLevel = 0;
  lastSpawnTime   = 0;
  targets       = [];
  particles     = [];
  floatingTexts = [];
  muzzleFlashes = [];
  powerUpOrbs   = [];
  activePowerUp = null;
  powerUpAnnouncement = null;
  comboRewardGiven = false;
  shakeIntensity = 0;
  highScoreForm.classList.add("hidden");
  leaderboardSection.classList.add("hidden");
  playerNameInput.value = "";
  handState.Left.wasThumbUp  = false;
  handState.Left.lastFireTime = 0;
  handState.Right.wasThumbUp = false;
  handState.Right.lastFireTime = 0;
  updateScoreDisplay();
  updateLivesDisplay();
}

async function endGame() {
  gameState = "GAME_OVER";
  hud.classList.add("hidden");

  finalScoreValEl.textContent = score;
  verdictTextEl.textContent   = score === 0
    ? "Did… did you even fire? 😂"
    : pick(VERDICTS);

  gameOverScreen.classList.remove("hidden");

  await handleLeaderboardOnGameOver();
}

function restartGame() {
  gameOverScreen.classList.add("hidden");
  resetGame();
  gameState = "PLAYING";
  hud.classList.remove("hidden");
  requestAnimationFrame(gameLoop);
}

// ====================================================================
//  MAIN GAME LOOP
// ====================================================================

function gameLoop(timestamp) {
  if (gameState !== "PLAYING") return;

  lastTimestamp = timestamp;

  // --- Hand detection ---
  if (handLandmarker && video.readyState >= 2) {
    try {
      const r = handLandmarker.detectForVideo(video, timestamp);
      processHandResults(r, timestamp);
    } catch (_) { /* skip occasional detection hiccups */ }
  }

  // --- Spawn ---
  const interval = Math.max(
    MIN_SPAWN_INTERVAL,
    INITIAL_SPAWN_INTERVAL - difficultyLevel * SPAWN_INTERVAL_DECREASE,
  );
  if (timestamp - lastSpawnTime > interval && targets.length < MAX_TARGETS_ON_SCREEN) {
    spawnTarget();
    lastSpawnTime = timestamp;
  }

  // --- Combo decay ---
  if (combo > 0 && performance.now() - lastHitTime > COMBO_WINDOW_MS) {
    combo = 0;
    updateScoreDisplay();
  }

  // --- Update ---
  updateTargets();
  updatePowerUpOrbs();
  updatePowerUps();
  updateParticles();
  updateMuzzleFlashes();
  updateFloatingTexts();
  updateHandIndicators();

  // --- Render ---
  render();

  requestAnimationFrame(gameLoop);
}

// ====================================================================
//  EVENT LISTENERS
// ====================================================================

startBtn.addEventListener("click", () => { ensureAudio(); startGame(); });
restartBtn.addEventListener("click", restartGame);
retryBtn.addEventListener("click", () => { deniedScreen.classList.add("hidden"); startGame(); });


// ====================================================================
//  LEADERBOARD MANAGER
// ====================================================================

class Leaderboard {
  constructor() {
    this.useFirebase = false;
    this.db = null;
    this.scoresCollection = null;
  }

  async init() {
    try {
      const response = await fetch("/__/firebase/init.json");
      if (!response.ok) throw new Error("Auto-config JSON not available");
      const config = await response.json();

      const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
      const { getFirestore, collection } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

      const app = initializeApp(config);
      this.db = getFirestore(app);
      this.scoresCollection = collection(this.db, "leaderboard");
      this.useFirebase = true;
      console.log("🔥 Firestore Leaderboard initialized successfully.");
    } catch (e) {
      console.warn("⚠️ Firebase auto-configuration failed. Falling back to LocalStorage leaderboard.", e);
      this.useFirebase = false;
    }
  }

  async getTopScores() {
    if (this.useFirebase) {
      try {
        const { getDocs, query, orderBy, limit } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        const q = query(this.scoresCollection, orderBy("score", "desc"), limit(10));
        const snapshot = await getDocs(q);
        const scores = [];
        snapshot.forEach((doc) => {
          scores.push(doc.data());
        });
        return scores.sort((a, b) => b.score - a.score);
      } catch (e) {
        console.error("Firestore fetch failed, falling back to LocalStorage:", e);
      }
    }

    try {
      const localData = localStorage.getItem("pew_pew_leaderboard");
      if (localData) {
        return JSON.parse(localData).slice(0, 10);
      }
    } catch (e) {
      console.error("LocalStorage read error:", e);
    }
    return [];
  }

  async addScore(name, scoreValue) {
    const cleanName = name.trim().substring(0, 7).toUpperCase() || "PILOT";
    const entry = {
      name: cleanName,
      score: parseInt(scoreValue, 10) || 0,
      timestamp: Date.now(),
    };

    if (this.useFirebase) {
      try {
        const { addDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        await addDoc(this.scoresCollection, entry);
        return;
      } catch (e) {
        console.error("Firestore write failed, falling back to LocalStorage:", e);
      }
    }

    try {
      const localData = localStorage.getItem("pew_pew_leaderboard");
      let scores = localData ? JSON.parse(localData) : [];
      scores.push(entry);
      scores.sort((a, b) => b.score - a.score);
      scores = scores.slice(0, 10);
      localStorage.setItem("pew_pew_leaderboard", JSON.stringify(scores));
    } catch (e) {
      console.error("LocalStorage write error:", e);
    }
  }
}

// ====================================================================
//  LEADERBOARD UI FLOW
// ====================================================================

async function handleLeaderboardOnGameOver() {
  leaderboardSection.classList.remove("hidden");
  leaderboardLoading.classList.remove("hidden");
  leaderboardTable.classList.add("hidden");
  highScoreForm.classList.add("hidden");

  const topScores = await leaderboard.getTopScores();
  const qualifies = score > 0 && (topScores.length < 10 || score > topScores[topScores.length - 1].score);

  if (qualifies) {
    highScoreForm.classList.remove("hidden");
    playerNameInput.disabled = false;
    submitScoreBtn.disabled = false;
    playerNameInput.value = "";
    
    setTimeout(() => playerNameInput.focus(), 150);

    submitScoreBtn.onclick = async () => {
      const name = playerNameInput.value.trim().substring(0, 7).toUpperCase() || "PILOT";
      submitScoreBtn.disabled = true;
      playerNameInput.disabled = true;
      submitScoreBtn.onclick = null;
      playerNameInput.onkeydown = null;
      
      await leaderboard.addScore(name, score);
      highScoreForm.classList.add("hidden");
      await showLeaderboard(name);
    };

    playerNameInput.onkeydown = async (e) => {
      if (e.key === "Enter") {
        const name = playerNameInput.value.trim().substring(0, 7).toUpperCase() || "PILOT";
        submitScoreBtn.disabled = true;
        playerNameInput.disabled = true;
        submitScoreBtn.onclick = null;
        playerNameInput.onkeydown = null;
        
        await leaderboard.addScore(name, score);
        highScoreForm.classList.add("hidden");
        await showLeaderboard(name);
      }
    };

    drawLeaderboardTable(topScores);
  } else {
    drawLeaderboardTable(topScores);
  }
}

async function showLeaderboard(highlightName = "") {
  leaderboardLoading.classList.remove("hidden");
  leaderboardTable.classList.add("hidden");

  const topScores = await leaderboard.getTopScores();
  drawLeaderboardTable(topScores, highlightName);
}

function drawLeaderboardTable(scores, highlightName = "") {
  leaderboardLoading.classList.add("hidden");
  leaderboardBody.innerHTML = "";
  
  const displayScores = scores.slice(0, 10);
  
  if (displayScores.length === 0) {
    leaderboardBody.innerHTML = `<tr><td colspan="3" style="color: var(--text-muted); font-style: italic;">No scores recorded yet!</td></tr>`;
  } else {
    displayScores.forEach((entry, idx) => {
      const tr = document.createElement("tr");
      const rank = idx + 1;
      
      let rankText = rank;
      let rankClass = `rank-${rank}`;
      if (rank === 1) rankText = "👑 1";
      else if (rank === 2) rankText = "🥈 2";
      else if (rank === 3) rankText = "🥉 3";

      const isNewHighlight = highlightName && entry.name === highlightName && entry.score === score;
      if (isNewHighlight) {
        tr.className = "leaderboard-row-highlight";
      }

      tr.innerHTML = `
        <td class="${rankClass}">${rankText}</td>
        <td>${escapeHtml(entry.name)}</td>
        <td>${entry.score}</td>
      `;
      leaderboardBody.appendChild(tr);
    });
  }

  leaderboardTable.classList.remove("hidden");
}

function escapeHtml(str) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  };
  return str.replace(/[&<>"']/g, (m) => map[m]);
}

// Instantiate and initialize leaderboard
const leaderboard = new Leaderboard();
leaderboard.init();
