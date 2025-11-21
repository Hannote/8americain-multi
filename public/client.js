let playerId = localStorage.getItem("playerId");
if (!playerId) {
  playerId = "p_" + Math.random().toString(36).slice(2, 12);
  localStorage.setItem("playerId", playerId);
}
console.log("playerId:", playerId);

const socket = io();

/* ===============================
      CONSTANTES CARTES
================================ */

const PIOCHE_IMAGE = "cartes/dos.png";

// ===============================
//           SONS CARTES
// ===============================

// Préférence simple (pour plus tard, si on ajoute un bouton mute)
let soundEnabled = true;
let audioUnlocked = false;

// ===============================
//      AUDIO WEB (AudioContext)
// ===============================

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioBuffers = {};

// Map logique -> fichier audio (les chemins restent les mêmes qu'avant)
const soundFiles = {
  play: "sons/card-play.mp3",
  draw: "sons/card-draw.mp3",
  // Couleurs (8)
  coeur: "sons/coeur.mp3",
  carreau: "sons/carreau.mp3",
  trefle: "sons/trefle.mp3",
  pique: "sons/pique.mp3",
  // Roi de coeur
  roiCoeur0: "sons/roi-coeur-1.mp3",
  roiCoeur1: "sons/roi-coeur-2.mp3",
  roiCoeur2: "sons/roi-coeur-3.mp3",
  // 8 qui contre
  huitContre0: "sons/8-contre-1.mp3",
  huitContre1: "sons/8-contre-2.mp3",
  // As (pour l’instant 1 seul)
  as0: "sons/as-1.mp3",
};

// Charge et décode un son
async function loadSound(key, url) {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    audioBuffers[key] = audioBuffer;
  } catch (e) {
    console.warn("Impossible de charger le son :", key, url, e);
  }
}

// Préchargement de tous les sons au démarrage
Object.entries(soundFiles).forEach(([key, url]) => {
  loadSound(key, url);
});

// Fonction générique pour jouer un son à partir de sa clé
function playSoundByKey(key) {
  if (!soundEnabled) return;
  if (!audioUnlocked) return;

  const buffer = audioBuffers[key];
  if (!buffer) return; // pas encore chargé → on ne fait rien

  // Si le contexte est suspendu (souvent le cas au chargement), on tente de le reprendre
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => { });
  }

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start(0);
}

// ===============================
//   FONCTIONS APPELÉES PAR LE JEU
//   (API identique à avant)
// ===============================

function playCardSound() {
  playSoundByKey("play");
}

function playDrawSound() {
  playSoundByKey("draw");
}

function playColorSound(color) {
  // color = "coeur" | "carreau" | "trefle" | "pique"
  playSoundByKey(color);
}

function playRoiCoeurSound(index) {
  const maxSounds = 3;
  let i;
  if (typeof index === "number") {
    i = ((index % maxSounds) + maxSounds) % maxSounds;
  } else {
    i = Math.floor(Math.random() * maxSounds);
  }
  playSoundByKey(`roiCoeur${i}`);
}

function playHuitContreSound(index) {
  const maxSounds = 2;
  let i;
  if (typeof index === "number") {
    i = ((index % maxSounds) + maxSounds) % maxSounds;
  } else {
    i = Math.floor(Math.random() * maxSounds);
  }
  playSoundByKey(`huitContre${i}`);
}

function playAsSound(index) {
  // on ignore l'index pour l’instant, un seul son
  playSoundByKey("as0");
}

// ===============================
//       DÉBLOCAGE AUDIO MOBILE
// ===============================

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;

  if (audioCtx.state === "suspended") {
    audioCtx
      .resume()
      .then(() => {
        // petit buffer silencieux pour "réveiller" iOS en douceur
        try {
          const buffer = audioCtx.createBuffer(1, 1, 22050);
          const source = audioCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(audioCtx.destination);
          source.start(0);
        } catch (e) {
          // on ignore, ce n'est qu'une optimisation
        }
      })
      .catch(() => { });
  }
}

// On s'assure de débloquer l'audio dès le premier geste utilisateur
window.addEventListener("click", unlockAudio, { once: true });
window.addEventListener("touchstart", unlockAudio, { once: true });

const cardImages = {
  "7_coeur": "cartes/7h.png",
  "8_coeur": "cartes/8h.png",
  "9_coeur": "cartes/9h.png",
  "10_coeur": "cartes/10h.png",
  "V_coeur": "cartes/jh.png",
  "D_coeur": "cartes/qh.png",
  "R_coeur": "cartes/kh.png",
  "A_coeur": "cartes/1h.png",

  "7_carreau": "cartes/7d.png",
  "8_carreau": "cartes/8d.png",
  "9_carreau": "cartes/9d.png",
  "10_carreau": "cartes/10d.png",
  "V_carreau": "cartes/jd.png",
  "D_carreau": "cartes/qd.png",
  "R_carreau": "cartes/kd.png",
  "A_carreau": "cartes/1d.png",

  "7_trefle": "cartes/7c.png",
  "8_trefle": "cartes/8c.png",
  "9_trefle": "cartes/9c.png",
  "10_trefle": "cartes/10c.png",
  "V_trefle": "cartes/jc.png",
  "D_trefle": "cartes/qc.png",
  "R_trefle": "cartes/kc.png",
  "A_trefle": "cartes/1c.png",

  "7_pique": "cartes/7s.png",
  "8_pique": "cartes/8s.png",
  "9_pique": "cartes/9s.png",
  "10_pique": "cartes/10s.png",
  "V_pique": "cartes/js.png",
  "D_pique": "cartes/qs.png",
  "R_pique": "cartes/ks.png",
  "A_pique": "cartes/1s.png",
};

// ===============================
//      HELPERS ANIMATIONS CARTES
// ===============================

function getElementCenter(el) {
  if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
  };
}

function animateCardMove(fromEl, toEl, imageSrc) {
  const layer = document.getElementById("cardAnimationLayer");
  if (!layer) return;

  const from = getElementCenter(fromEl);
  const to = getElementCenter(toEl);

  const img = document.createElement("img");
  img.src = imageSrc;
  img.className = "flying-card";

  const startX = from.x - 60;
  const startY = from.y - 90;
  const endX = to.x - 60;
  const endY = to.y - 90;

  img.style.transform = `translate(${startX}px, ${startY}px)`;
  img.style.opacity = "1";

  layer.appendChild(img);

  requestAnimationFrame(() => {
    img.style.transform = `translate(${endX}px, ${endY}px)`;
    img.style.opacity = "0";
  });

  img.addEventListener("transitionend", () => {
    img.remove();
  });
}

function getCardImage(card) {
  if (!card) return PIOCHE_IMAGE;
  const key = `${card.rank}_${card.suit}`;
  return cardImages[key] || PIOCHE_IMAGE;
}

function cardToText(card) {
  if (!card) return "";
  const suitSymbols = { coeur: "♥", carreau: "♦", trefle: "♣", pique: "♠" };
  return `${card.rank}${suitSymbols[card.suit] || "?"}`;
}

/* ===============================
        DOM ELEMENTS
================================ */

// Lobby
const pseudoInput = document.getElementById("pseudo");
const roomInput = document.getElementById("room");
const playersDiv = document.getElementById("players");
const statusDiv = document.getElementById("status");
const roomInfoDiv = document.getElementById("roomInfo");
const startBtn = document.getElementById("startBtn");
const lobbyDiv = document.getElementById("lobby");
const modeSelect = document.getElementById("modeSelect");
const chillConfigDiv = document.getElementById("chillConfig");

// Plateau
const gameAreaDiv = document.getElementById("gameArea");
const gameRoomName = document.getElementById("gameRoomName");
const gamePlayersDiv = document.getElementById("gamePlayers");
const yourHandDiv = document.getElementById("yourHand");
const yourHandTitle = document.getElementById("yourHandTitle");
const gameStatusDiv = document.getElementById("gameStatus");
const currentTurnBannerDiv = document.getElementById("currentTurnBanner");
const currentColorBannerDiv = document.getElementById("currentColorBanner");

const piocheCardDiv = document.getElementById("piocheCard");
const piocheCountDiv = document.getElementById("piocheCount");
const defausseCardDiv = document.getElementById("defausseCard");
const defausseInfoDiv = document.getElementById("defausseInfo");
const chillScoreBoard = document.getElementById("chillScoreBoard");

// Zone pour animations / effets
const effectZone = document.getElementById("effectZone");
const carteZoneDiv = document.getElementById("carteZone");
const carteBtn = document.getElementById("btnCarte");
const contreBtn = document.getElementById("btnContre");
const toggleSortModeBtn = document.getElementById("toggleSortMode");
const autoSortColorBtn = document.getElementById("autoSortColor");
const autoSortRankBtn = document.getElementById("autoSortRank");
const quitBtn = document.getElementById("quitGameButton");

if (carteBtn) {
  carteBtn.addEventListener("click", sendCarte);
}
if (contreBtn) {
  contreBtn.addEventListener("click", sendContreCarte);
}
if (toggleSortModeBtn) {
  toggleSortModeBtn.addEventListener("click", toggleSortMode);
}
if (autoSortColorBtn) {
  autoSortColorBtn.addEventListener("click", autoSortByColor);
}
if (autoSortRankBtn) {
  autoSortRankBtn.addEventListener("click", autoSortByRank);
}
if (quitBtn) {
  quitBtn.addEventListener("click", () => {
    quitCurrentGame();
  });
}
if (modeSelect && chillConfigDiv) {
  modeSelect.addEventListener("change", () => {
    chillConfigDiv.style.display =
      modeSelect.value === "chill" ? "block" : "none";
  });
  chillConfigDiv.style.display =
    modeSelect.value === "chill" ? "block" : "none";
}
/* ===============================
      ETAT CLIENT
================================ */

let currentRoom = null;
let isHost = false;
let myPseudo = null;

let currentPlayersPub = [];
let currentTurnIdx = 0;

let myHand = [];
let myIndexInGame = -1;

let drawPileCount = 0;
let discardTop = null;
let currentColor = null;

let currentAttackPlus = 0;
let discardCount = 0;
let canOnlyPlaySeven = false;
let cartePhaseActive = false;
let carteTargetIndex = null;
let carteContreDisponible = false;
window.roomCode = null;
window.myPlayerIndex = -1;
let currentMode = null;
let sortMode = false;
let sortSelectedIndex = null;
let lastAttackPlusDisplayed = 0;
// État pour synchroniser sons + animations à partir de gameState
let lastDiscardCardKey = null;
let lastDrawPileCountValue = null;
let lastPlayersSnapshot = null;
let lastTurnIndex = null;
let gameStateInitialized = false;
let lastImposedColor = null;

function getHandOrderKey() {
  const room = currentRoom || window.roomCode || "";
  return `handOrder_${playerId}_${room}`;
}

function saveHandOrder() {
  if (!Array.isArray(myHand) || myHand.length === 0) return;
  const key = getHandOrderKey();
  const ids = myHand
    .filter((c) => c && typeof c.id === "string")
    .map((c) => c.id);
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch (e) {
    console.warn("Impossible de sauvegarder l'ordre de la main :", e);
  }
}

function applySavedHandOrder(hand) {
  if (!Array.isArray(hand) || hand.length === 0) return hand;
  const key = getHandOrderKey();
  let savedIds = null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return hand;
    savedIds = JSON.parse(raw);
  } catch (e) {
    console.warn("Impossible de relire l'ordre de la main :", e);
    return hand;
  }
  if (!Array.isArray(savedIds) || savedIds.length === 0) return hand;

  const indexMap = new Map();
  savedIds.forEach((id, idx) => {
    if (!indexMap.has(id)) indexMap.set(id, idx);
  });

  return [...hand].sort((a, b) => {
    const ia = indexMap.has(a.id) ? indexMap.get(a.id) : 9999;
    const ib = indexMap.has(b.id) ? indexMap.get(b.id) : 9999;
    return ia - ib;
  });
}

/* =============================== */

function setStatus(msg) {
  statusDiv.textContent = msg || "";
}

function setGameStatus(msg) {
  gameStatusDiv.textContent = msg || "";
}

/* ===========================================================
    LOBBY — CREATION / JOIN
=========================================================== */

function createRoom() {
  unlockAudio();
  const pseudo = pseudoInput.value.trim();
  const room = roomInput.value.trim();

  if (!pseudo || !room) {
    alert("Pseudo ou code de salle manquant");
    return;
  }

  socket.emit("createRoom", { pseudo, room, playerId }, (res) => {
    if (!res.ok) {
      setStatus("Erreur : " + res.error);
      return;
    }

    myPseudo = pseudo;
    currentRoom = room;
    try {
      localStorage.setItem("lastRoomCode", room);
      localStorage.setItem("lastPseudo", pseudo);
    } catch (e) { }
    isHost = true;

    roomInfoDiv.textContent = "Salle : " + room + " (tu es l'hôte)";
    startBtn.style.display = "inline-block";
    setStatus("Salle créée. En attente d'autres joueurs...");
  });
}

function joinRoom() {
  unlockAudio();
  const pseudo = pseudoInput.value.trim();
  const room = roomInput.value.trim();

  if (!pseudo || !room) {
    alert("Pseudo ou code de salle manquant");
    return;
  }

  socket.emit("joinRoom", { pseudo, room, playerId }, (res) => {
    if (!res.ok) {
      setStatus("Erreur : " + res.error);
      return;
    }

    myPseudo = pseudo;
    currentRoom = room;
    try {
      localStorage.setItem("lastRoomCode", room);
      localStorage.setItem("lastPseudo", pseudo);
    } catch (e) { }
    isHost = false;

    roomInfoDiv.textContent = "Salle : " + room;
    setStatus("Tu as rejoint la salle. En attente du lancement...");
  });
}

socket.on("updatePlayers", (playerList) => {
  if (!playerList || playerList.length === 0) {
    playersDiv.innerHTML = "(personne pour l'instant)";
    return;
  }
  playersDiv.innerHTML = playerList
    .map((p) => {
      const pseudo = p.pseudo || "?";
      const status = p.isConnected ? "" : " (déconnecté)";
      const count =
        typeof p.cardCount === "number"
          ? ` - ${p.cardCount} carte${p.cardCount > 1 ? "s" : ""}`
          : "";
      return `• ${pseudo}${status}${count}`;
    })
    .join("<br>");
});

/* ===========================================================
       DEMARRAGE DE PARTIE
=========================================================== */

function startGame() {
  unlockAudio();
  if (!currentRoom || !isHost) return;
  const mode = modeSelect ? modeSelect.value : "battle";
  const roundsInput = document.getElementById("chillRounds");
  let rounds = 0;
  if (mode === "chill" && roundsInput) {
    rounds = parseInt(roundsInput.value, 10) || 1;
  }
  socket.emit("startGameWithMode", {
    room: currentRoom,
    mode,
    rounds,
  });
}

socket.on("gameStarted", ({ room }) => {
  lobbyDiv.style.display = "none";
  gameAreaDiv.style.display = "block";
  if (quitBtn) quitBtn.style.display = "block";
  gameRoomName.textContent = "Salle : " + room;
  setGameStatus("La partie a démarré.");
});

/* ===========================================================
    RENDU DES JOUEURS SUR LE PLATEAU
=========================================================== */

function renderGamePlayers() {
  gamePlayersDiv.innerHTML = "";
  if (!currentPlayersPub || currentPlayersPub.length === 0) return;

  currentPlayersPub.forEach((p, idx) => {
    const box = document.createElement("div");
    box.className = "player-box";

    const headerDiv = document.createElement("div");
    headerDiv.style.display = "flex";
    headerDiv.style.justifyContent = "space-between";
    headerDiv.style.alignItems = "center";

    const nameDiv = document.createElement("div");
    nameDiv.className = "player-name";
    if (idx === currentTurnIdx) {
      nameDiv.classList.add("current");
    }

    let label = p.pseudo;
    if (p.pseudo === myPseudo) label += " (toi)";
    if (!p.isConnected) label += " (déconnecté)";
    nameDiv.textContent = `${label} - ${p.cardCount} carte(s)`;
    headerDiv.appendChild(nameDiv);

    if (isHost && p.playerId && p.playerId !== window.playerId) {
      const kickBtn = document.createElement("button");
      kickBtn.textContent = "Kick";
      kickBtn.style.fontSize = "14px";
      kickBtn.style.padding = "4px 8px";
      kickBtn.style.marginLeft = "8px";
      kickBtn.addEventListener("click", () => {
        if (!currentRoom) return;
        const confirmKick = confirm(
          `Voulez-vous vraiment expulser ${p.pseudo} de la partie ?`
        );
        if (!confirmKick) return;
        socket.emit("kickPlayer", {
          room: currentRoom,
          targetPlayerId: p.playerId,
        });
      });
      headerDiv.appendChild(kickBtn);
    }

    box.appendChild(headerDiv);

    const cardsDiv = document.createElement("div");
    cardsDiv.className = "player-cards";

    for (let i = 0; i < p.cardCount; i++) {
      const back = document.createElement("div");
      back.className = "card-back";
      cardsDiv.appendChild(back);
    }

    box.appendChild(cardsDiv);
    gamePlayersDiv.appendChild(box);
  });
}

function findPlayerBoxByIndex(index) {
  if (!gamePlayersDiv) return null;
  const boxes = gamePlayersDiv.querySelectorAll(".player-box");
  return boxes[index] || null;
}

function renderChillScores(players, mode) {
  if (!chillScoreBoard) return;
  if (mode !== "chill" || !Array.isArray(players) || players.length === 0) {
    chillScoreBoard.style.display = "none";
    chillScoreBoard.innerHTML = "";
    return;
  }

  chillScoreBoard.style.display = "block";
  chillScoreBoard.innerHTML = players
    .map((p) => {
      const pseudo = p.pseudo || "?";
      const score = typeof p.score === "number" && p.score > 0 ? p.score : 0;
      return `${pseudo} ${"★".repeat(score)}`;
    })
    .join("<br>");
}

/* ===========================================================
        RENDU DE LA MAIN DU JOUEUR
=========================================================== */

function playCard(cardId) {
  if (!currentRoom || !cardId) return;
  // On n'appelle plus playCardSound() directement ici
  socket.emit("playCard", { room: currentRoom, cardId });
}

function updateSortControlsUI() {
  if (!toggleSortModeBtn || !autoSortColorBtn || !autoSortRankBtn) return;

  if (sortMode) {
    toggleSortModeBtn.textContent = "Mode tri : ON";
    toggleSortModeBtn.style.background =
      "linear-gradient(135deg, #1976d2, #42a5f5)";
    autoSortColorBtn.style.display = "inline-block";
    autoSortRankBtn.style.display = "inline-block";
  } else {
    toggleSortModeBtn.textContent = "Mode tri : OFF";
    toggleSortModeBtn.style.background = "";
    autoSortColorBtn.style.display = "none";
    autoSortRankBtn.style.display = "none";
  }
}

function toggleSortMode() {
  sortMode = !sortMode;
  sortSelectedIndex = null;
  updateSortControlsUI();
  renderMyHand();
}

function handleSortClick(cardIndex) {
  if (!Array.isArray(myHand) || myHand.length === 0) return;

  if (sortSelectedIndex === null) {
    sortSelectedIndex = cardIndex;
    renderMyHand();
    return;
  }

  if (sortSelectedIndex === cardIndex) {
    sortSelectedIndex = null;
    renderMyHand();
    return;
  }

  const i = sortSelectedIndex;
  const j = cardIndex;
  const tmp = myHand[i];
  myHand[i] = myHand[j];
  myHand[j] = tmp;

  saveHandOrder();
  sortSelectedIndex = null;
  renderMyHand();
}

function autoSortByColor() {
  if (!Array.isArray(myHand) || myHand.length === 0) return;
  const suitOrder = { coeur: 0, carreau: 1, trefle: 2, pique: 3 };
  const rankOrder = { "7": 0, "8": 1, "9": 2, "10": 3, V: 4, D: 5, R: 6, A: 7 };

  myHand.sort((a, b) => {
    const sa = suitOrder[a.suit] ?? 0;
    const sb = suitOrder[b.suit] ?? 0;
    if (sa !== sb) return sa - sb;
    const ra = rankOrder[a.rank] ?? 0;
    const rb = rankOrder[b.rank] ?? 0;
    return ra - rb;
  });

  saveHandOrder();
  sortSelectedIndex = null;
  renderMyHand();
}

function autoSortByRank() {
  if (!Array.isArray(myHand) || myHand.length === 0) return;
  const suitOrder = { coeur: 0, carreau: 1, trefle: 2, pique: 3 };
  const rankOrder = { "7": 0, "8": 1, "9": 2, "10": 3, V: 4, D: 5, R: 6, A: 7 };

  myHand.sort((a, b) => {
    const ra = rankOrder[a.rank] ?? 0;
    const rb = rankOrder[b.rank] ?? 0;
    if (ra !== rb) return ra - rb;
    const sa = suitOrder[a.suit] ?? 0;
    const sb = suitOrder[b.suit] ?? 0;
    return sa - sb;
  });

  saveHandOrder();
  sortSelectedIndex = null;
  renderMyHand();
}

function renderMyHand() {
  yourHandDiv.innerHTML = "";

  const count = myHand ? myHand.length : 0;
  if (yourHandTitle) {
    yourHandTitle.textContent =
      `Ta main (${count} carte${count > 1 ? "s" : ""}) :`;
  }

  if (!myHand || myHand.length === 0) {
    yourHandDiv.textContent = "(tu n'as pas de carte)";
    return;
  }

  const isClickLocked = canOnlyPlaySeven && !sortMode;

  myHand.forEach((card, index) => {
    const cardDiv = document.createElement("div");
    cardDiv.className = "card";

    const img = document.createElement("img");
    img.className = "card-img";
    img.src = getCardImage(card);
    img.alt = cardToText(card);

    if (isClickLocked && card.rank !== "7") {
      cardDiv.classList.add("lockedCard");
    }

    if (sortMode && sortSelectedIndex === index) {
      cardDiv.classList.add("selectedCard");
    }

    cardDiv.appendChild(img);
    cardDiv.addEventListener("click", () => {
      if (sortMode) {
        handleSortClick(index);
        return;
      }
      if (cartePhaseActive) {
        return;
      }
      if (canOnlyPlaySeven && card.rank !== "7") {
        setGameStatus(
          "Tu es sous l'effet d'un 7 : tu peux jouer un 7 pour renvoyer l'effet, ou cliquer sur 'Sauter le tour'."
        );
        return;
      }
      playCard(card.id);
    });

    yourHandDiv.appendChild(cardDiv);
  });
}

function updateCarteButtons() {
  if (!carteZoneDiv || !carteBtn || !contreBtn) return;

  carteBtn.style.display = "none";
  contreBtn.style.display = "none";
  carteBtn.disabled = true;
  contreBtn.disabled = true;

  const drawBtn = document.getElementById("drawButton");
  if (drawBtn) {
    drawBtn.disabled = cartePhaseActive;
  }

  if (!cartePhaseActive) {
    return;
  }

  const applyStyle = (btn, background, color) => {
    btn.style.display = "inline-block";
    btn.style.fontSize = "30px";
    btn.style.padding = "20px 40px";
    btn.style.minWidth = "200px";
    btn.style.height = "120px";
    btn.style.borderRadius = "20px";
    btn.style.fontWeight = "bold";
    btn.style.border = "none";
    btn.style.boxShadow = "0 6px 18px rgba(0,0,0,0.8)";
    btn.style.cursor = "pointer";
    btn.style.background = background;
    btn.style.color = color;
    btn.disabled = false;
  };

  const isTarget = myIndexInGame === carteTargetIndex;

  if (isTarget) {
    applyStyle(carteBtn, "linear-gradient(135deg, #ffca28, #ff9800)", "#000");
  } else if (carteContreDisponible) {
    applyStyle(contreBtn, "linear-gradient(135deg, #f44336, #d32f2f)", "#fff");
  }
}

/* ===========================================================
        RENDU PIOCHE / DEFAUSSE / TOUR
=========================================================== */

function renderBoard() {
  // PIOCHE
  piocheCardDiv.innerHTML = "";

  if (drawPileCount > 0) {
    const img = document.createElement("img");
    img.src = PIOCHE_IMAGE;
    img.alt = "Pioche";
    piocheCardDiv.appendChild(img);
    piocheCountDiv.textContent = `${drawPileCount} carte(s)`;
  } else {
    piocheCardDiv.innerHTML =
      '<span style="opacity:0.8;">Pioche vide</span>';
    piocheCountDiv.textContent = "0 carte";
  }

  // DEFAUSSE
  defausseCardDiv.innerHTML = "";

  if (discardTop) {
    const img = document.createElement("img");
    img.src = getCardImage(discardTop);
    img.alt = cardToText(discardTop);
    defausseCardDiv.appendChild(img);

    // Texte simplifié : uniquement le nombre de cartes
    defausseInfoDiv.textContent = `${discardCount} carte(s)`;
  } else {
    defausseCardDiv.innerHTML =
      '<span style="opacity:0.8;">Aucune carte</span>';
    // Cohérent avec la pioche : 0 carte(s)
    defausseInfoDiv.textContent = "0 carte(s)";
  }

  // BANNIÈRE TOUR
  let pseudoTour = "?";
  if (currentPlayersPub && currentPlayersPub[currentTurnIdx]) {
    pseudoTour = currentPlayersPub[currentTurnIdx].pseudo;
  }

  const imposedColor = currentColor || (discardTop ? discardTop.suit : null);

  if (imposedColor) {
    let bannerHtml =
      `C'est le tour de <span>${pseudoTour}</span>` +
      `<div class="current-color-line">Couleur impos\u00e9e : ${imposedColor}</div>`;

    // Affichage de la cha\u00eene d'as : +2, +4, +6, +8
    if (currentAttackPlus && currentAttackPlus > 0) {
      bannerHtml += `<div class="attack-chain-line">Attaque en cours : +${currentAttackPlus}</div>`;
    }

    currentTurnBannerDiv.innerHTML = bannerHtml;
  } else {
    currentTurnBannerDiv.innerHTML =
      `C'est le tour de <span>${pseudoTour}</span>`;
  }

  // Ancienne bannière couleur désormais vide : la couleur est affichée sous le tour
  if (currentColorBannerDiv) {
    currentColorBannerDiv.textContent = "";
  }
}

/* ===========================================================
          BOUTON PIOCHER
=========================================================== */

function drawCard() {
  if (!currentRoom) return;
  if (cartePhaseActive) return;
  // On n'appelle plus playDrawSound() directement ici
  socket.emit("drawCard", { room: currentRoom });
}

function resetToLobby(message) {
  if (gameAreaDiv && lobbyDiv) {
    gameAreaDiv.style.display = "none";
    lobbyDiv.style.display = "block";
  }
  if (quitBtn) {
    quitBtn.style.display = "none";
  }

  currentRoom = null;
  window.roomCode = null;
  try {
    const key = getHandOrderKey();
    localStorage.removeItem(key);
  } catch (e) {
    console.warn("Impossible de nettoyer l'ordre de main :", e);
  }
  myHand = [];
  currentPlayersPub = [];
  currentTurnIdx = 0;
  drawPileCount = 0;
  discardTop = null;
  currentColor = null;
  currentAttackPlus = 0;
  discardCount = 0;
  canOnlyPlaySeven = false;
  cartePhaseActive = false;
  carteTargetIndex = null;
  carteContreDisponible = false;
  isHost = false;
  myIndexInGame = -1;
  window.myPlayerIndex = -1;

  renderGamePlayers();
  if (yourHandDiv) yourHandDiv.innerHTML = "";
  if (gameStatusDiv) gameStatusDiv.textContent = "";
  if (currentTurnBannerDiv) currentTurnBannerDiv.innerHTML = "";
  if (playersDiv) playersDiv.innerHTML = "(personne pour l'instant)";
  if (roomInfoDiv) roomInfoDiv.textContent = "";
  if (startBtn) startBtn.style.display = "none";
  updateCarteButtons();

  if (typeof message === "string" && message) {
    setStatus(message);
  } else {
    setStatus("");
  }
}

function quitCurrentGame() {
  if (!currentRoom) {
    resetToLobby("Tu n'es pas dans une partie.");
    return;
  }

  const sure = confirm(
    "⚠️ Voulez-vous vraiment quitter la partie ?\nCette action est irréversible."
  );
  if (!sure) {
    return;
  }

  const wasHost = isHost;
  if (isHost) {
    socket.emit("hostQuitGame", { room: currentRoom });
  } else {
    socket.emit("quitGame", { room: currentRoom });
  }

  resetToLobby(
    wasHost
      ? "Tu as quitté la partie en tant qu'hôte. La salle est fermée."
      : "Tu as quitté la partie en cours. Tu restes dans le lobby."
  );
}

function sendCarte() {
  if (!currentRoom) return;
  socket.emit("announceCarte", { room: currentRoom });
}

function sendContreCarte() {
  if (!currentRoom) return;
  socket.emit("announceContreCarte", { room: currentRoom });
}

/* ===========================================================
      ZONE D'EFFETS (anims +2/+4/+6/+8)
=========================================================== */

function showEffect(message, imageUrl = null) {
  if (!effectZone) return;
  effectZone.style.zIndex = "99999";

  // reset
  effectZone.innerHTML = "";

  const msg = document.createElement("div");
  msg.className = "effectMessage";
  msg.textContent = message;
  effectZone.appendChild(msg);

  if (imageUrl) {
    const img = document.createElement("img");
    img.className = "effectImage";
    img.src = imageUrl;
    effectZone.appendChild(img);
  }

  // affiche
  effectZone.classList.add("visible");

  // disparaît après 2s
  setTimeout(() => {
    effectZone.classList.remove("visible");
  }, 3000);
}

/* ===========================================================
   ANIMATION VISUELLE QUAND UN 8 CHOISIT UNE COULEUR
   =========================================================== */

function showColorFlash(color) {
  const symbols = {
    coeur: "♥",
    carreau: "♦",
    trefle: "♣",
    pique: "♠",
  };

  const symbol = symbols[color] || "?";

  // Conteneur plein écran
  const overlay = document.createElement("div");
  overlay.className = "color-flash-overlay";

  // Symbole au centre
  const inner = document.createElement("div");
  inner.className = `color-flash-symbol color-${color}`;
  inner.textContent = symbol;
  overlay.appendChild(inner);

  document.body.appendChild(overlay);

  // Force le reflow pour bien lancer la transition
  void overlay.offsetWidth;
  overlay.classList.add("visible");

  // Animation courte (1,5 s) puis suppression
  setTimeout(() => {
    overlay.classList.remove("visible");
    setTimeout(() => {
      overlay.remove();
    }, 300);
  }, 1500);
}


/* ===========================================================
      LOGIQUE CLIENT POUR CHOIX DE COULEUR (8)
=========================================================== */

let pendingEightCard = null;

function askColorChoice(cardId) {
  pendingEightCard = cardId;

  const popup = document.createElement("div");
  popup.id = "colorChoicePopup";

  popup.innerHTML = `
    <div class="color-choice-box">
      <h3>Choisis une couleur :</h3>
      <button class="color-btn" data-color="coeur">♥</button>
      <button class="color-btn" data-color="carreau">♦</button>
      <button class="color-btn" data-color="trefle">♣</button>
      <button class="color-btn" data-color="pique">♠</button>
    </div>
  `;

  document.body.appendChild(popup);

  popup.querySelectorAll(".color-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const chosen = btn.dataset.color;
      document.body.removeChild(popup);

      socket.emit("playEight", {
        room: currentRoom,
        cardId: pendingEightCard,
        color: chosen,
      });

      pendingEightCard = null;
    });
  });
}

socket.on("askColor", ({ cardId }) => {
  askColorChoice(cardId);
});

/* ===========================================================
        RECEPTION DES MESSAGES SERVEUR
=========================================================== */

socket.on("gameState", (data) => {
  const {
    room,
    players,
    currentTurnIndex,
    drawCount,
    discardTopCard,
    currentColor: col,
    attackPlus,
    discardCount: discCount,
    skipTurns,
    mode,
  } = data;

  const imposedColorNow =
    col || (discardTopCard ? discardTopCard.suit : null);
  const imposedColorBefore = lastImposedColor;

  const prevPlayers = Array.isArray(lastPlayersSnapshot)
    ? lastPlayersSnapshot
    : null;
  const prevTurnIndex = lastTurnIndex;

  const newPlayers = Array.isArray(players) ? players : [];
  const newDrawCount =
    typeof drawCount === "number" ? drawCount : 0;

  const newDiscardKey = discardTopCard
    ? (discardTopCard.id || `${discardTopCard.rank}_${discardTopCard.suit}`)
    : null;

  let playedCard = false;
  let drewCard = false;
  let playPlayerIndex = null;
  let drawPlayerIndex = null;

  if (gameStateInitialized) {
    if (newDiscardKey && newDiscardKey !== lastDiscardCardKey) {
      playedCard = true;
      if (typeof prevTurnIndex === "number") {
        playPlayerIndex = prevTurnIndex;
      }
    }

    if (
      lastDrawPileCountValue != null &&
      newDrawCount < lastDrawPileCountValue
    ) {
      drewCard = true;

      if (prevPlayers && prevPlayers.length === newPlayers.length) {
        for (let i = 0; i < newPlayers.length; i++) {
          const before = prevPlayers[i];
          const after = newPlayers[i];
          const beforeCount =
            before && typeof before.cardCount === "number"
              ? before.cardCount
              : 0;
          const afterCount =
            after && typeof after.cardCount === "number"
              ? after.cardCount
              : 0;
          if (afterCount > beforeCount) {
            drawPlayerIndex = i;
            break;
          }
        }
      }
    }
  }

  lastDiscardCardKey = newDiscardKey;
  lastDrawPileCountValue = newDrawCount;
  lastPlayersSnapshot = newPlayers.map((p) => ({
    cardCount: typeof p.cardCount === "number" ? p.cardCount : 0,
  }));
  lastTurnIndex =
    typeof currentTurnIndex === "number" ? currentTurnIndex : null;

  const localMyIndexBefore = myIndexInGame;

  currentRoom = room;
  window.roomCode = room;
  currentPlayersPub = newPlayers;
  currentMode = mode || null;
  currentTurnIdx =
    typeof currentTurnIndex === "number" ? currentTurnIndex : 0;
  drawPileCount = newDrawCount;

  discardTop = discardTopCard || null;
  currentColor = col || (discardTop ? discardTop.suit : null);

  currentAttackPlus = attackPlus || 0;
  discardCount = discCount || 0;

  renderChillScores(currentPlayersPub, currentMode);

  myIndexInGame = currentPlayersPub.findIndex(
    (p) => p.pseudo === myPseudo
  );
  window.myPlayerIndex = myIndexInGame;

  const isMyTurn =
    myIndexInGame !== -1 && myIndexInGame === currentTurnIdx;
  const skip = skipTurns || 0;

  canOnlyPlaySeven = isMyTurn && skip === 1;
  if (canOnlyPlaySeven) {
    setGameStatus(
      "Tu es sous l'effet d'un 7 : joue un 7 pour renvoyer l'effet ou clique sur 'Sauter le tour'."
    );
  }

  const drawBtn = document.getElementById("drawButton");
  if (drawBtn) {
    if (canOnlyPlaySeven) {
      drawBtn.textContent = "Sauter le tour";
      drawBtn.style.background = "linear-gradient(135deg, #b71c1c, #d32f2f)";
      drawBtn.disabled = false;
    } else {
      drawBtn.textContent = "Piocher";
      drawBtn.style.background = "";
      drawBtn.disabled = cartePhaseActive;
    }
  }

  renderGamePlayers();
  renderBoard();
  renderMyHand();

  // Déclenchement correct de l’animation du 8 : uniquement après CHANGEMENT de couleur imposée
  const isEightOnTop = discardTopCard && discardTopCard.rank === "8";

  const eightColorJustChosen =
    gameStateInitialized &&
    isEightOnTop &&
    imposedColorBefore &&
    imposedColorNow &&
    imposedColorBefore !== imposedColorNow;

  if (eightColorJustChosen) {
    showColorFlash(imposedColorNow);
    playColorSound(imposedColorNow);  // joue le son correspondant
  }

  if (gameStateInitialized) {
    if (playedCard && discardTopCard) {
      playCardSound();

      const toEl = defausseCardDiv;
      let fromEl = null;

      const effectivePlayIndex = playPlayerIndex;

      if (
        typeof effectivePlayIndex === "number" &&
        effectivePlayIndex >= 0
      ) {
        if (
          localMyIndexBefore !== -1 &&
          effectivePlayIndex === localMyIndexBefore
        ) {
          fromEl = yourHandDiv;
        } else {
          fromEl = findPlayerBoxByIndex(effectivePlayIndex);
        }
      }

      const imgSrc = getCardImage(discardTopCard);
      animateCardMove(fromEl || toEl, toEl, imgSrc);

    }

    if (drewCard && drawPlayerIndex != null) {
      playDrawSound();

      const fromEl = piocheCardDiv;
      let toEl = null;

      if (
        localMyIndexBefore !== -1 &&
        drawPlayerIndex === localMyIndexBefore
      ) {
        toEl = yourHandDiv;
      } else {
        toEl = findPlayerBoxByIndex(drawPlayerIndex) || fromEl;
      }

      animateCardMove(fromEl, toEl, PIOCHE_IMAGE);
    }
  }

  lastImposedColor = imposedColorNow;

  if (!gameStateInitialized) {
    gameStateInitialized = true;
  }
});

socket.on("handUpdate", ({ hand }) => {
  const rawHand = hand || [];
  myHand = applySavedHandOrder(rawHand);
  renderMyHand();
  saveHandOrder();
});

socket.on(
  "effectEvent",
  ({ type, message, targetPlayerId, sourcePlayerId, soundIndex }) => {
    console.log(
      "effectEvent reçu :",
      type,
      message,
      targetPlayerId,
      sourcePlayerId,
      soundIndex
    );

    // Cas spécifique Roi de cœur : son spécial + effet visuel + GIF
    if (type === "roiCoeur") {
      playRoiCoeurSound(soundIndex);

      setTimeout(() => {
        if (message) {
          // On passe le GIF en deuxième argument : il sera affiché derrière le texte
          showEffect(message, "gif.gif");
        }
      }, 50);
      return;
    }

    if (type === "skipSeven") {
      setTimeout(() => {
        if (message) showEffect(message);
      }, 50);
      return;
    }

    if (type === "attaqueAs") {
      // Son spécial pour n'importe quel As joué
      playAsSound(soundIndex);
      // pas de return : tout le monde voit le message d'attaque
    }

    if (type === "huitChoixCouleur") {
      if (sourcePlayerId && sourcePlayerId === playerId) {
        return;
      }
      setTimeout(() => {
        if (message) showEffect(message);
      }, 50);
      return;
    }

    if (type === "contreHuit") {
      playHuitContreSound(soundIndex);

      if (sourcePlayerId && sourcePlayerId === playerId) {
        return;
      }
    }

    setTimeout(() => {
      if (message) showEffect(message);
    }, 50);
  }
);

socket.on("fullRestore", (data) => {
  gameStateInitialized = false;
  lastDiscardCardKey = null;
  lastDrawPileCountValue = null;
  const restoredHand = data.hand || [];
  myHand = applySavedHandOrder(restoredHand);
  const g = data.gameState || {};
  if (g) {
    currentPlayersPub = g.players || [];
    currentTurnIdx =
      typeof g.currentTurnIndex === "number" ? g.currentTurnIndex : 0;
    drawPileCount = typeof g.drawCount === "number" ? g.drawCount : 0;
    discardTop = g.discardTopCard || null;
    currentColor = g.currentColor || null;
    currentAttackPlus = g.attackPlus || 0;
    discardCount = typeof g.discardCount === "number" ? g.discardCount : 0;
  }

  if (data.myPseudo) {
    myPseudo = data.myPseudo;
  }

  if (typeof data.myPlayerIndex === "number") {
    myIndexInGame = data.myPlayerIndex;
    window.myPlayerIndex = myIndexInGame;
  } else {
    myIndexInGame = currentPlayersPub.findIndex(
      (p) => p.pseudo === myPseudo
    );
    window.myPlayerIndex = myIndexInGame;
  }

  if (lobbyDiv && gameAreaDiv) {
    lobbyDiv.style.display = "none";
    gameAreaDiv.style.display = "block";
  }
  if (quitBtn) quitBtn.style.display = "block";

  if (g.room) {
    currentRoom = g.room;
    window.roomCode = g.room;
    if (gameRoomName) {
      gameRoomName.textContent = "Salle : " + g.room;
    }
  }

  const cp = data.cartePhase || {};
  cartePhaseActive = !!cp.active;
  carteTargetIndex =
    typeof cp.targetIndex === "number" ? cp.targetIndex : null;
  carteContreDisponible = !!cp.contreDisponible;

  const pending = data.pendingEight;
  if (
    pending &&
    typeof pending.playerIndex === "number" &&
    pending.playerIndex === myIndexInGame
  ) {
    askColorChoice(pending.cardId);
  }

  renderGamePlayers();
  renderBoard();
  renderMyHand();
  updateCarteButtons();
});

socket.on("cartePhaseStart", ({ targetIndex, targetPseudo }) => {
  cartePhaseActive = true;
  carteTargetIndex = typeof targetIndex === "number" ? targetIndex : null;
  carteContreDisponible = false;

  if (targetPseudo) {
    setGameStatus(
      `${targetPseudo} est à 1 carte ! Il doit appuyer sur "Carte". Les adversaires pourront appuyer sur "Contre carte" dans 1 seconde.`
    );
  } else {
    setGameStatus(
      `Un joueur est à 1 carte ! Il doit appuyer sur "Carte". Les adversaires pourront appuyer sur "Contre carte" dans 1 seconde.`
    );
  }

  updateCarteButtons();
  setTimeout(updateCarteButtons, 120);
});

socket.on("cartePhaseContreOpen", () => {
  if (!cartePhaseActive) return;
  carteContreDisponible = true;
  setGameStatus(
    "La phase 'carte / contre carte' est ouverte. Les adversaires peuvent appuyer sur 'Contre carte'."
  );
  updateCarteButtons();
  setTimeout(updateCarteButtons, 120);
});

socket.on("cartePhaseEnd", () => {
  cartePhaseActive = false;
  carteTargetIndex = null;
  carteContreDisponible = false;
  updateCarteButtons();
  setGameStatus("");
});

socket.on("roomClosed", ({ reason }) => {
  let msg = "La salle a été fermée.";
  if (reason === "host_quit") {
    msg = "L'hôte a quitté la partie. La salle a été fermée.";
  }
  resetToLobby(msg);
});

socket.on("playerQuitGameInfo", ({ pseudo }) => {
  if (pseudo) {
    setGameStatus(`${pseudo} a quitté la partie en cours.`);
  }
});

socket.on("kickedFromGame", ({ room, reason }) => {
  resetToLobby("Tu as été expulsé de la partie par l'hôte.");
});

socket.on("newRound", ({ round, total, mode, players }) => {
  if (Array.isArray(players)) {
    currentPlayersPub = players;
  }
  if (mode === "chill") {
    setGameStatus(`Manche ${round}/${total} (Mode Chill)`);
  } else {
    setGameStatus(`Nouvelle manche - Battle Royale (round ${round})`);
  }
  myHand = [];
  renderGamePlayers();
  renderBoard();
  renderMyHand();
});

socket.on("chillGameOver", ({ scores, winnerId, winnerPseudo }) => {
  // Déterminer le pseudo du gagnant
  let gagnant = winnerPseudo || null;

  if (!gagnant && winnerId && Array.isArray(currentPlayersPub)) {
    const found = currentPlayersPub.find((p) => p.playerId === winnerId);
    if (found && found.pseudo) {
      gagnant = found.pseudo;
    }
  }

  if (!gagnant) {
    gagnant = "Un joueur";
  }

  // Message identique pour tout le monde
  alert(`${gagnant} remporte la victoire !`);

  // On met quand même à jour l'affichage des scores finaux
  const finalPlayers = Object.entries(scores || {}).map(([id, score]) => {
    const pp = currentPlayersPub.find((p) => p.playerId === id);
    return {
      pseudo: pp ? pp.pseudo : "?",
      score,
    };
  });
  renderChillScores(finalPlayers, "chill");
});

socket.on("battleGameOver", ({ winner }) => {
  if (winner) {
    alert(`Battle Royale terminé ! ${winner} a gagné la partie.`);
    setGameStatus(`Battle Royale terminé. Vainqueur : ${winner}`);
  } else {
    alert("Battle Royale terminé !");
    setGameStatus("Battle Royale terminé.");
  }
});

socket.on("battlePlayerEliminated", ({ eliminatedPseudo }) => {
  if (eliminatedPseudo) {
    alert(`${eliminatedPseudo} est éliminé du Battle Royale.`);
    setGameStatus(`${eliminatedPseudo} est éliminé du Battle Royale.`);
  } else {
    alert("Un joueur est éliminé du Battle Royale.");
    setGameStatus("Un joueur est éliminé du Battle Royale.");
  }
});

/* ===========================================================
      MESSAGES / ERREURS / FIN
=========================================================== */

socket.on("errorMessage", ({ msg }) => {
  setGameStatus(msg || "");
});

socket.on("gameEnded", ({ winner }) => {
  if (winner) {
    setGameStatus(`Partie terminée. Vainqueur : ${winner}`);
  } else {
    setGameStatus("Partie terminée.");
  }
});

socket.on("connect", () => {
  console.log("Connecté au serveur avec playerId:", playerId);
  socket.emit("reconnectWithId", { playerId });
  try {
    const lastRoomCode = localStorage.getItem("lastRoomCode");
    const lastPseudo = localStorage.getItem("lastPseudo");

    if (lastRoomCode && lastPseudo) {
      socket.emit("reconnectByPseudo", {
        room: lastRoomCode,
        pseudo: lastPseudo,
      });
    }
  } catch (e) {
    console.warn("Impossible de lire lastRoomCode/lastPseudo", e);
  }
});

socket.on("disconnect", () => {
  console.log("Déconnecté du serveur.");
});

updateSortControlsUI();

/* ===========================================================
      STYLES POUR LA POPUP COULEUR
=========================================================== */

const style = document.createElement("style");
style.textContent = `
/* Conteneur de la popup : plus de plein écran */
#colorChoicePopup {
  position: fixed;
  left: 50%;
  top: 18%;
  transform: translateX(-50%);
  z-index: 9999;
}

/* Boîte blanche avec les 4 couleurs */
.color-choice-box {
  background: rgba(255,255,255,0.97);
  padding: 24px 32px;
  border-radius: 18px;
  box-shadow: 0 0 18px rgba(0,0,0,0.9);
  text-align: center;
  font-size: 32px;
  color: #000;
}

/* Titre */
.color-choice-box h3 {
  margin: 0 0 16px 0;
  font-size: 22px;
}

/* Boutons de couleur */
.color-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  min-width: 70px;
 min-height: 70px;
  font-size: 40px;
  padding: 10px 14px;
  margin: 6px;
  border-radius: 14px;
  cursor: pointer;
  border: 2px solid #333;
  background: #f5f5f5;
  transition: transform 0.15s, background 0.15s;
}

/* Rouge pour coeur / carreau */
.color-btn[data-color="coeur"],
.color-btn[data-color="carreau"] {
  color: #d50000;
}

/* Noir pour trèfle / pique */
.color-btn[data-color="trefle"],
.color-btn[data-color="pique"] {
  color: #000000;
}

.color-btn:hover {
  transform: scale(1.08);
  background: #e0e0e0;
}

/* Adaptation mobile : tout plus petit et largeur max */
@media (max-width: 900px) {
  #colorChoicePopup {
    top: 10%;
  }

  .color-choice-box {
    width: 90vw;
    max-width: 420px;
    padding: 16px 18px;
    font-size: 24px;
  }

  .color-choice-box h3 {
    font-size: 18px;
    margin-bottom: 10px;
  }

  .color-btn {
    min-width: 60px;
    min-height: 60px;
    font-size: 32px;
    padding: 8px 10px;
    margin: 4px;
  }
}
`;
document.head.appendChild(style);

/* ===========================================================
      STYLES POUR LA ZONE D'EFFET
=========================================================== */

const effectStyle = document.createElement("style");
effectStyle.textContent = `
/* Conteneur des messages d'event */
#effectZone {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
  z-index: 99999;
}

/* Quand un message est visible */
#effectZone.visible {
  opacity: 1;
}

/* Texte du message d'event, centré */
.effectMessage {
  position: relative;
  z-index: 2;
  font-size: 32px;
  font-weight: bold;
  color: yellow;
  margin: 0 0 12px 0;
  text-shadow: 0 0 10px black;
  padding: 12px 20px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.6);
  text-align: center;
}

/* GIF pour le Roi de Coeur : derrière le texte, centré comme lui */
.effectImage {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1;
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  pointer-events: none;
}

/* (inchangé) */
.lockedCard {
  opacity: 0.3;
  pointer-events: none;
}
`;
document.head.appendChild(effectStyle);

const sortStyle = document.createElement("style");
sortStyle.textContent = `
.selectedCard {
  transform: translateY(-12px);
  box-shadow: 0 0 12px rgba(255, 235, 59, 0.9);
  border: 3px solid #ffeb3b;
}
`;
document.head.appendChild(sortStyle);

const colorFlashStyle = document.createElement("style");
colorFlashStyle.textContent = `
.color-flash-overlay {
  position: fixed !important;
  inset: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;

  z-index: 999999 !important;     /* passe au-dessus de tout, même sur mobile */
  opacity: 0;
  transition: opacity 0.25s ease-out;

  transform: none !important;      /* évite les stacking contexts Safari */
  -webkit-transform: none !important;
}

html, body {
  position: relative !important;
  z-index: 0 !important;
}

.color-flash-overlay.visible {
  opacity: 1;
}

.color-flash-symbol {
  font-size: clamp(320px, 80vw, 800px); /* 3× plus grand */
  font-weight: bold;
  text-shadow: 0 0 40px rgba(0,0,0,0.85);
  animation: colorFlashScaleFade 4.5s ease-out forwards; /* animation 2× plus longue */
}

/* Couleurs des symboles */
.color-flash-symbol.color-coeur,
.color-flash-symbol.color-carreau {
  color: #ff5252; /* rouge vif */
}

.color-flash-symbol.color-trefle,
.color-flash-symbol.color-pique {
  color: #4caf50; /* vert vif qui contraste bien */
}

@keyframes colorFlashScaleFade {
  0%   { transform: scale(0.5); opacity: 0; }
  25%  { transform: scale(1.2); opacity: 1; }
  100% { transform: scale(1.4); opacity: 0; }
}
`;
document.head.appendChild(colorFlashStyle);
