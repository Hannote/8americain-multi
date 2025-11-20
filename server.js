const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

/*
rooms[codeSalle] = {
  hostId: playerId,
  players: [{ playerId, pseudo, socketId, hand: [], isConnected: true, eliminated: false, leftCurrentGame: false }],
  settings: {
    mode: null,
    totalRounds: 0,
    currentRound: 1,
    scores: {},
    eliminated: [],
  },
  game: {
    drawPile: [cartes],
    discardPile: [cartes],
    playerStates: [{ playerId, pseudo, socketId, hand: [cartes] }],
    currentTurnIndex: number,
    currentColor: "coeur" | "carreau" | "trefle" | "pique",
    attackPlus: number,
    pendingEight: { playerIndex, cardId, previousHandLength } | null
  }
}
*/

const rooms = {};

// Nombre de sons disponibles pour le Roi de cœur (côté client: tableau de sons)
const ROI_COEUR_SOUND_COUNT = 3; // adapte ce nombre si besoin
const HUIT_CONTRE_SOUND_COUNT = 3; // sons 8-contre-*.mp3
const AS_SOUND_COUNT = 4; // sons as-*.mp3

// Un joueur (playerId) ne doit jamais être dans plusieurs salles en même temps.
// Cette fonction le retire de toutes les salles sauf éventuellement une salle à garder.
function removePlayerFromOtherRooms(playerId, roomToKeep = null) {
  if (!playerId) return;
  for (const [code, r] of Object.entries(rooms)) {
    if (roomToKeep && code === roomToKeep) continue;
    if (!r || !Array.isArray(r.players)) continue;

    const idx = r.players.findIndex((p) => p.playerId === playerId);
    if (idx !== -1) {
      const removed = r.players.splice(idx, 1)[0];
      console.log(
        `Player ${removed.pseudo || removed.playerId} retiré de la salle ${code} car il rejoint/crée une autre salle.`
      );
      sendPlayersUpdate(code);

      if (r.players.length === 0 && !r.game) {
        console.log(`Salle ${code} vide sans partie active, suppression.`);
        delete rooms[code];
      }
    }
  }
}

// =============== UTILITAIRES CARTES ===============

function createDeck() {
  const suits = ["coeur", "carreau", "trefle", "pique"];
  const ranks = ["7", "8", "9", "10", "V", "D", "R", "A"];

  const deck = [];
  let idCounter = 0;

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({
        rank,
        suit,
        id: `${rank}_${suit}_${idCounter++}`,
      });
    }
  }
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function reshuffleIfNeeded(game) {
  if (game.drawPile.length > 0) return;
  if (game.discardPile.length <= 1) return;

  const top = game.discardPile[game.discardPile.length - 1];
  const toShuffle = game.discardPile.slice(0, -1);
  shuffle(toShuffle);
  game.drawPile = toShuffle;
  game.discardPile = [top];
}

function nextPlayerIndex(game) {
  const n = game.playerStates.length;
  if (n === 0) return 0;
  const dir = game.direction || 1;
  let attempts = 0;
  let idx = game.currentTurnIndex;

  while (attempts < n) {
    idx = (idx + dir + n) % n;
    const candidate = game.playerStates[idx];
    if (
      candidate &&
      !candidate.finishedThisRound &&
      Array.isArray(candidate.hand) &&
      candidate.hand.length > 0
    ) {
      return idx;
    }
    attempts += 1;
  }

  return game.currentTurnIndex;
}

function nextActivePlayerIndex(roomCode, game) {
  const r = rooms[roomCode];
  if (!r || !game) {
    return game && typeof game.currentTurnIndex === "number"
      ? game.currentTurnIndex
      : 0;
  }

  const n = game.playerStates.length;
  if (n === 0) return 0;

  const dir = game.direction || 1;
  let idx = game.currentTurnIndex;
  let attempts = 0;

  while (attempts < n) {
    idx = (idx + dir + n) % n;
    const candidate = game.playerStates[idx];
    if (!candidate) {
      attempts += 1;
      continue;
    }

    const roomPlayer = r.players.find(
      (p) => p.playerId === candidate.playerId
    );
    if (!roomPlayer || roomPlayer.eliminated) {
      attempts += 1;
      continue;
    }
    if (candidate.finishedThisRound) {
      attempts += 1;
      continue;
    }
    if (!Array.isArray(candidate.hand) || candidate.hand.length === 0) {
      attempts += 1;
      continue;
    }

    return idx;
  }

  return game.currentTurnIndex;
}

function isCardPlayable(game, card) {
  const top = game.discardPile[game.discardPile.length - 1] || null;

  if (!top || !game.currentColor) return true;
  if (card.rank === "8") return true;
  if (card.suit === game.currentColor) return true;
  if (card.rank === top.rank) return true;

  return false;
}

// Règle des Dames pour la première carte
function initFirstCardAndTurn(game) {
  game.discardPile = [];
  game.currentColor = null;

  const orderDames = [
    { rank: "D", suit: "coeur" },
    { rank: "D", suit: "pique" },
    { rank: "D", suit: "trefle" },
    { rank: "D", suit: "carreau" },
  ];

  for (const dame of orderDames) {
    for (let i = 0; i < game.playerStates.length; i++) {
      const ps = game.playerStates[i];
      const idx = ps.hand.findIndex(
        (c) => c.rank === dame.rank && c.suit === dame.suit
      );
      if (idx !== -1) {
        const card = ps.hand.splice(idx, 1)[0];
        game.discardPile.push(card);
        game.currentColor = card.suit;

        const first = nextPlayerIndex({ ...game, currentTurnIndex: i });
        game.currentTurnIndex = first;
        return;
      }
    }
  }

  const firstCard = game.drawPile.shift();
  if (firstCard) {
    game.discardPile.push(firstCard);
    game.currentColor = firstCard.suit;
  }

  game.currentTurnIndex = 0;
}

// Etat public envoyé aux joueurs
function getPublicPlayers(r) {
  if (!r || !r.game) return [];
  const mode = r.settings ? r.settings.mode : null;
  const scores = r.settings && r.settings.scores ? r.settings.scores : {};

  return r.game.playerStates.map((ps) => {
    const roomPlayer = r.players.find((p) => p.playerId === ps.playerId);
    const score = mode === "chill" ? scores[ps.playerId] || 0 : 0;
    return {
      playerId: ps.playerId,
      pseudo: ps.pseudo,
      cardCount: ps.hand.length,
      isConnected: roomPlayer ? !!roomPlayer.isConnected : true,
      score,
    };
  });
}

function sendPlayersUpdate(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;
  const payload = r.players.map((p) => ({
    pseudo: p.pseudo,
    cardCount: Array.isArray(p.hand) ? p.hand.length : 0,
    isConnected: !!p.isConnected,
  }));
  io.to(roomCode).emit("updatePlayers", payload);
}

function broadcastGameState(roomCode) {
  const r = rooms[roomCode];
  if (!r || !r.game) return;
  const g = r.game;
  if (g.cartePhaseActive) return;

  const publicPlayers = getPublicPlayers(r);
  const top = g.discardPile[g.discardPile.length - 1] || null;

  io.to(roomCode).emit("gameState", {
    room: roomCode,
    players: publicPlayers,
    currentTurnIndex: g.currentTurnIndex,
    drawCount: g.drawPile.length,
    discardTopCard: top,
    currentColor: g.currentColor,
    attackPlus: g.attackPlus,
    discardCount: g.discardPile.length,
    skipTurns: g.skipTurns || 0,
    mode: r.settings ? r.settings.mode : null,
  });

  for (const ps of g.playerStates) {
    if (ps.socketId) {
      io.to(ps.socketId).emit("handUpdate", { hand: ps.hand });
    }
  }
  sendPlayersUpdate(roomCode);
}

function updatePlayerSocketReference(room, playerId, socketId) {
  if (!room || !room.game) return;
  const ps = room.game.playerStates.find((state) => state.playerId === playerId);
  if (ps) {
    ps.socketId = socketId;
  }
}

function getPlayerBySocket(room, socketId) {
  if (!room) return null;
  return room.players.find((p) => p.socketId === socketId);
}

function createNewGameState(players) {
  const deck = createDeck();
  shuffle(deck);
  const numPlayers = players.length;
  let cardsPerPlayer;
  switch (numPlayers) {
    case 2:
      cardsPerPlayer = 8;
      break;
    case 3:
      cardsPerPlayer = 7;
      break;
    case 4:
      cardsPerPlayer = 6;
      break;
    case 5:
      cardsPerPlayer = 5;
      break;
    case 6:
      cardsPerPlayer = 4;
      break;
    default:
      cardsPerPlayer = 6;
  }

  const playerStates = players.map((p) => {
    const hand = [];
    p.hand = hand;
    p.leftCurrentGame = false;
    return {
      playerId: p.playerId,
      pseudo: p.pseudo,
      socketId: p.socketId,
      hand,
      finishedThisRound: false,
    };
  });

  for (let i = 0; i < cardsPerPlayer; i++) {
    for (let j = 0; j < numPlayers; j++) {
      const card = deck.shift();
      if (card) playerStates[j].hand.push(card);
    }
  }

  const game = {
    drawPile: deck,
    discardPile: [],
    playerStates,
    currentTurnIndex: 0,
    currentColor: null,
    attackPlus: 0,
    pendingEight: null,
    skipTurns: 0,
    direction: 1,
    extraTurnPending: false, // <--- flag pour gérer 10 / valet en duel / logique de rejouer
    cartePhaseActive: false,
    carteTargetIndex: null,
    carteContreDisponible: false,
    cartePhaseTimer: null,
  };

  initFirstCardAndTurn(game);
  return game;
}

function startNewRound(room) {
  const r = rooms[room];
  if (!r) return;
  if (!r.settings.currentRound) {
    r.settings.currentRound = 1;
  }
  const activePlayers = r.players.filter(
    (p) => !p.eliminated && !p.leftCurrentGame
  );
  activePlayers.forEach((p) => {
    p.finishedThisRound = false;
  });
  r.game = createNewGameState(activePlayers);

  if (
    r.settings &&
    r.settings.mode === "battle" &&
    r.game &&
    Array.isArray(r.game.playerStates)
  ) {
    r.game.playerStates.forEach((ps) => {
      ps.finishedThisRound = false;
    });
  }

  const totalObjective =
    r.settings.mode === "chill" ? r.settings.totalRounds : 0;

  io.to(room).emit("newRound", {
    round: r.settings.currentRound,
    total: totalObjective,
    mode: r.settings.mode,
    players: getPublicPlayers(r),
  });
  broadcastGameState(room);
}

function sendErrorTo(socketId, msg) {
  io.to(socketId).emit("errorMessage", { msg });
}

function checkEndOfTurnAndCartePhase(
  room,
  g,
  ps,
  playerIndex,
  previousHandLength,
  keepCurrentTurnOnFinish
) {
  const r = rooms[room];
  if (!r) return false;

  const mode = r.settings && r.settings.mode ? r.settings.mode : null;

  // Fin de manche si le joueur n'a plus de cartes
  if (ps.hand.length === 0) {
    if (g.cartePhaseActive) {
      endCartePhase(room);
    }

    if (mode === "battle") {
      if (!ps.finishedThisRound) {
        ps.finishedThisRound = true;
        const roomPlayer = r.players.find((p) => p.playerId === ps.playerId);
        if (roomPlayer) {
          roomPlayer.finishedThisRound = true;
        }
        io.to(room).emit("battlePlayerQualified", {
          pseudo: ps.pseudo,
        });
        console.log(
          `${ps.pseudo} est qualifié pour la prochaine manche dans la salle ${room}.`
        );
      }

      const stillPlaying = g.playerStates.filter((st) => {
        const roomPlayer = r.players.find((p) => p.playerId === st.playerId);
        if (!roomPlayer) return false;
        if (roomPlayer.eliminated) return false;
        if (st.finishedThisRound) return false;
        if (!Array.isArray(st.hand) || st.hand.length === 0) return false;
        return true;
      });

      if (stillPlaying.length === 0) {
        return true;
      }

      if (stillPlaying.length === 1) {
        endBattleRound(room, stillPlaying[0].playerId);
        return true;
      }

      if (!keepCurrentTurnOnFinish) {
        g.currentTurnIndex = nextActivePlayerIndex(room, g);
      }
      broadcastGameState(room);
      return true;
    }

    endRound(room, ps.playerId);
    return true;
  }

  // Phase "carte" uniquement si on passe de 2 cartes -> 1 carte
  if (
    typeof previousHandLength === "number" &&
    previousHandLength === 2 &&
    ps.hand.length === 1
  ) {
    startCartePhase(room, playerIndex);
    return true;
  }

  return false;
}

function startCartePhase(roomCode, targetIndex) {
  const r = rooms[roomCode];
  if (!r || !r.game) return;
  const g = r.game;

  if (g.cartePhaseActive) return;

  g.cartePhaseActive = true;
  g.carteTargetIndex = targetIndex;
  g.carteContreDisponible = false;
  if (g.cartePhaseTimer) {
    clearTimeout(g.cartePhaseTimer);
    g.cartePhaseTimer = null;
  }

  const target = g.playerStates[targetIndex];
  if (!target) return;

  io.to(roomCode).emit("cartePhaseStart", {
    targetIndex,
    targetPseudo: target.pseudo,
  });

  g.cartePhaseTimer = setTimeout(() => {
    const r2 = rooms[roomCode];
    if (!r2 || !r2.game) return;
    const g2 = r2.game;

    if (!g2.cartePhaseActive) return;

    g2.carteContreDisponible = true;
    io.to(roomCode).emit("cartePhaseContreOpen", {});
    g2.cartePhaseTimer = null;
  }, 1000);
}

function endRound(room, winnerId) {
  const r = rooms[room];
  if (!r) return;

  if (r.settings.mode === "chill") {
    const targetWins = Math.max(1, r.settings.totalRounds || 1);
    const newScore = (r.settings.scores[winnerId] || 0) + 1;
    r.settings.scores[winnerId] = newScore;

    // Mode chill = manches gagnantes : on s'arrête dès qu'un joueur atteint targetWins
    if (newScore >= targetWins) {
      const winnerPlayer = r.players.find((p) => p.playerId === winnerId);
      const winnerPseudo = winnerPlayer ? winnerPlayer.pseudo : null;

      io.to(room).emit("chillGameOver", {
        scores: r.settings.scores,
        winnerId,
        winnerPseudo,
      });
      r.game = null;
      return;
    }

    // Sinon on rejoue une nouvelle manche
    r.settings.currentRound += 1;
    startNewRound(room);
  } else if (r.settings.mode === "battle") {
    return;
  } else {
    io.to(room).emit("gameEnded", { winner: null });
  }
}

function endBattleRound(room, loserId) {
  const r = rooms[room];
  if (!r) return;

  const loser = r.players.find((p) => p.playerId === loserId);
  if (loser) {
    loser.eliminated = true;
    loser.finishedThisRound = false;
  }

  const survivors = r.players.filter((p) => !p.eliminated);

  if (survivors.length === 1) {
    io.to(room).emit("battleGameOver", {
      winner: survivors[0].pseudo,
    });
    r.game = null;
    sendPlayersUpdate(room);
    return;
  }

  survivors.forEach((p) => {
    p.finishedThisRound = false;
  });

  io.to(room).emit("battlePlayerEliminated", {
    eliminatedPseudo: loser ? loser.pseudo : null,
  });

  r.settings.currentRound = (r.settings.currentRound || 1) + 1;
  startNewRound(room);
}

function endCartePhase(roomCode) {
  const r = rooms[roomCode];
  if (!r || !r.game) return;
  const g = r.game;

  if (g.cartePhaseTimer) {
    clearTimeout(g.cartePhaseTimer);
    g.cartePhaseTimer = null;
  }
  g.cartePhaseActive = false;
  g.carteTargetIndex = null;
  g.carteContreDisponible = false;

  if (!g.extraTurnPending && (!g.skipTurns || g.skipTurns === 0)) {
    g.currentTurnIndex = nextActivePlayerIndex(roomCode, g);
  }

  io.to(roomCode).emit("cartePhaseEnd");
}

// ====================== SOCKET.IO ======================

io.on("connection", (socket) => {
  console.log("Nouveau joueur connecté :", socket.id);

  socket.on("createRoom", ({ pseudo, room, playerId }, callback) => {
    try {
      if (!room) {
        return callback({ ok: false, error: "Code de salle invalide." });
      }
      if (!playerId) {
        return callback({ ok: false, error: "playerId manquant." });
    }
    if (rooms[room]) {
      return callback({ ok: false, error: "Cette salle existe déjà." });
    }

    // S'assurer que ce playerId ne reste pas dans une autre salle
    removePlayerFromOtherRooms(playerId);

    rooms[room] = {
      hostId: playerId,
      players: [],
      game: null,
      settings: {
          mode: null,
          totalRounds: 0,
          currentRound: 1,
          scores: {},
          eliminated: [],
        },
      };

      const newPlayer = {
        playerId,
        socketId: socket.id,
        pseudo,
        hand: [],
        isConnected: true,
        eliminated: false,
        leftCurrentGame: false,
      };
      rooms[room].players.push(newPlayer);

      socket.join(room);
      console.log(`Salle ${room} créée par ${pseudo}`);
      callback({ ok: true });

      sendPlayersUpdate(room);
    } catch (e) {
      console.error(e);
      callback({ ok: false, error: "Erreur serveur." });
    }
  });

  socket.on("joinRoom", ({ pseudo, room, playerId }, callback) => {
    try {
      const r = rooms[room];
    if (!r) {
      return callback({ ok: false, error: "Salle introuvable." });
    }
    if (!playerId) {
      return callback({ ok: false, error: "playerId manquant." });
    }

    // S'assurer que ce playerId ne reste pas inscrit dans une autre salle
    removePlayerFromOtherRooms(playerId, room);

    let player = r.players.find((p) => p.playerId === playerId);
    if (player) {
        player.socketId = socket.id;
        player.isConnected = true;
        player.leftCurrentGame = false;
        if (!player.pseudo && pseudo) {
          player.pseudo = pseudo;
        }
      } else {
        player = {
          playerId,
          socketId: socket.id,
          pseudo,
          hand: [],
          isConnected: true,
          eliminated: false,
          leftCurrentGame: false,
        };
        r.players.push(player);
      }
      if (r.game) {
        updatePlayerSocketReference(r, playerId, socket.id);
      }

      socket.join(room);

      console.log(`${pseudo} rejoint la salle ${room}`);
      callback({ ok: true });

      sendPlayersUpdate(room);
    } catch (e) {
      console.error(e);
      callback({ ok: false, error: "Erreur serveur." });
    }
  });

  socket.on("hostQuitGame", ({ room }) => {
    const r = rooms[room];
    if (!r) return;
    const requester = r.players.find((p) => p.socketId === socket.id);
    if (!requester) return;
    if (requester.playerId !== r.hostId) return;

    console.log(`Hôte ${requester.pseudo} quitte la partie, salle ${room} fermée.`);
    io.to(room).emit("roomClosed", { reason: "host_quit" });
    delete rooms[room];
  });

  socket.on("quitGame", ({ room }) => {
    const r = rooms[room];
    if (!r || !r.game) return;
    const g = r.game;
    const roomPlayer = r.players.find((p) => p.socketId === socket.id);
    if (!roomPlayer) return;

    console.log(`${roomPlayer.pseudo} quitte volontairement la partie dans la salle ${room}.`);

    roomPlayer.leftCurrentGame = true;

    const idx = g.playerStates.findIndex(
      (ps) => ps.playerId === roomPlayer.playerId
    );
    if (idx === -1) return;

    const ps = g.playerStates[idx];
    if (Array.isArray(ps.hand) && ps.hand.length > 0) {
      g.drawPile.push(...ps.hand);
      ps.hand.length = 0;
      shuffle(g.drawPile);
    }
    g.playerStates.splice(idx, 1);
    roomPlayer.hand = ps.hand;

    if (g.playerStates.length === 0) {
      io.to(room).emit("gameEnded", { winner: null });
      r.game = null;
      sendPlayersUpdate(room);
      return;
    }

    if (idx < g.currentTurnIndex) {
      g.currentTurnIndex = Math.max(g.currentTurnIndex - 1, 0);
    } else if (idx === g.currentTurnIndex) {
      g.currentTurnIndex = g.currentTurnIndex % g.playerStates.length;
    }

    if (g.pendingEight) {
      if (g.pendingEight.playerIndex === idx) {
        g.pendingEight = null;
      } else if (g.pendingEight.playerIndex > idx) {
        g.pendingEight.playerIndex = Math.max(
          0,
          g.pendingEight.playerIndex - 1
        );
      }
    }

    if (g.cartePhaseActive) {
      if (g.carteTargetIndex === idx || g.carteTargetIndex >= g.playerStates.length) {
        endCartePhase(room);
      } else if (g.carteTargetIndex > idx) {
        g.carteTargetIndex -= 1;
      }
    }

    io.to(room).emit("playerQuitGameInfo", { pseudo: roomPlayer.pseudo });

    const stillIn = g.playerStates.filter(
      (ps2) => Array.isArray(ps2.hand) && ps2.hand.length > 0
    );
    if (stillIn.length === 1) {
      io.to(room).emit("gameEnded", { winner: stillIn[0].pseudo });
      r.game = null;
      sendPlayersUpdate(room);
      return;
    }

    sendPlayersUpdate(room);
    broadcastGameState(room);
  });

  socket.on("kickPlayer", ({ room, targetPlayerId }) => {
    const r = rooms[room];
    if (!r || !r.game) return;
    const g = r.game;

    const requester = r.players.find((p) => p.socketId === socket.id);
    if (!requester) return;
    if (requester.playerId !== r.hostId) return;

    if (targetPlayerId === requester.playerId) return;

    const roomPlayer = r.players.find((p) => p.playerId === targetPlayerId);
    if (!roomPlayer) return;

    console.log(
      `${requester.pseudo} kick ${roomPlayer.pseudo} de la partie dans la salle ${room}.`
    );

    roomPlayer.leftCurrentGame = true;

    const idx = g.playerStates.findIndex(
      (ps) => ps.playerId === roomPlayer.playerId
    );
    if (idx === -1) return;

    const ps = g.playerStates[idx];
    if (Array.isArray(ps.hand) && ps.hand.length > 0) {
      g.drawPile.push(...ps.hand);
      ps.hand.length = 0;
      shuffle(g.drawPile);
    }
    g.playerStates.splice(idx, 1);
    roomPlayer.hand = ps.hand;

    if (g.playerStates.length === 0) {
      io.to(room).emit("gameEnded", { winner: null });
      r.game = null;
      sendPlayersUpdate(room);
      return;
    }

    if (idx < g.currentTurnIndex) {
      g.currentTurnIndex = Math.max(g.currentTurnIndex - 1, 0);
    } else if (idx === g.currentTurnIndex) {
      g.currentTurnIndex = g.currentTurnIndex % g.playerStates.length;
    }

    if (g.pendingEight) {
      if (g.pendingEight.playerIndex === idx) {
        g.pendingEight = null;
      } else if (g.pendingEight.playerIndex > idx) {
        g.pendingEight.playerIndex = Math.max(
          0,
          g.pendingEight.playerIndex - 1
        );
      }
    }

    if (g.cartePhaseActive) {
      if (
        g.carteTargetIndex === idx ||
        g.carteTargetIndex >= g.playerStates.length
      ) {
        endCartePhase(room);
      } else if (g.carteTargetIndex > idx) {
        g.carteTargetIndex -= 1;
      }
    }

    io.to(room).emit("playerQuitGameInfo", {
      pseudo: roomPlayer.pseudo,
      reason: "kicked",
    });

    if (roomPlayer.socketId) {
      io.to(roomPlayer.socketId).emit("kickedFromGame", {
        room,
        reason: "kicked_by_host",
      });
    }

    const stillIn = g.playerStates.filter(
      (ps2) => Array.isArray(ps2.hand) && ps2.hand.length > 0
    );
    if (stillIn.length === 1) {
      io.to(room).emit("gameEnded", { winner: stillIn[0].pseudo });
      r.game = null;
      sendPlayersUpdate(room);
      return;
    }

    sendPlayersUpdate(room);
    broadcastGameState(room);
  });

  socket.on("reconnectWithId", ({ playerId }) => {
    if (!playerId) return;
    for (const [roomCode, r] of Object.entries(rooms)) {
      const player = r.players.find((p) => p.playerId === playerId);
      if (player) {
        player.socketId = socket.id;
        player.isConnected = true;
        socket.join(roomCode);
        updatePlayerSocketReference(r, playerId, socket.id);
        sendPlayersUpdate(roomCode);
        if (r.game) {
          if (player.leftCurrentGame) {
            console.log(
              `${player.pseudo} a quitté volontairement la partie dans la salle ${roomCode} : pas de fullRestore.`
            );
            socket.emit("playerQuitGameInfo", { pseudo: player.pseudo });
            return;
          }
          const g = r.game;
          const top = g.discardPile[g.discardPile.length - 1] || null;
          const gameState = {
            room: roomCode,
            players: getPublicPlayers(r),
            currentTurnIndex: g.currentTurnIndex,
            drawCount: g.drawPile.length,
            discardTopCard: top,
            currentColor: g.currentColor,
            attackPlus: g.attackPlus,
            discardCount: g.discardPile.length,
            skipTurns: g.skipTurns || 0,
            mode: r.settings ? r.settings.mode : null,
          };
          const cartePhase = {
            active: g.cartePhaseActive,
            targetIndex: g.carteTargetIndex,
            contreDisponible: g.carteContreDisponible,
          };
          const playerIndex = g.playerStates.findIndex(
            (ps) => ps.playerId === player.playerId
          );
          io.to(socket.id).emit("fullRestore", {
            hand: player.hand || [],
            gameState,
            cartePhase,
            pendingEight: g.pendingEight,
            myPlayerIndex: playerIndex,
            myPseudo: player.pseudo,
          });
        }
        socket.emit("reconnectedToRoom", { room: roomCode });
        return;
      }
    }
  });

  socket.on("reconnectByPseudo", ({ room, pseudo }) => {
    if (!room || !pseudo) return;
    const r = rooms[room];
    if (!r) return;

    const player = r.players.find(
      (p) =>
        p.pseudo === pseudo &&
        !p.isConnected &&
        !p.leftCurrentGame
    );
    if (!player) return;

    player.socketId = socket.id;
    player.isConnected = true;
    socket.join(room);
    updatePlayerSocketReference(r, player.playerId, socket.id);
    sendPlayersUpdate(room);

    if (r.game) {
      const g = r.game;
      const top = g.discardPile[g.discardPile.length - 1] || null;

      const gameState = {
        room,
        players: getPublicPlayers(r),
        currentTurnIndex: g.currentTurnIndex,
        drawCount: g.drawPile.length,
        discardTopCard: top,
        currentColor: g.currentColor,
        attackPlus: g.attackPlus,
        discardCount: g.discardPile.length,
        skipTurns: g.skipTurns || 0,
        mode: r.settings ? r.settings.mode : null,
      };

      const cartePhase = {
        active: g.cartePhaseActive,
        targetIndex: g.carteTargetIndex,
        contreDisponible: g.carteContreDisponible,
      };

      const playerIndex = g.playerStates.findIndex(
        (ps) => ps.playerId === player.playerId
      );

      io.to(socket.id).emit("fullRestore", {
        hand: player.hand || [],
        gameState,
        cartePhase,
        pendingEight: g.pendingEight,
        myPlayerIndex: playerIndex,
        myPseudo: player.pseudo,
      });
    }

    socket.emit("reconnectedToRoom", { room });
  });

  socket.on("startGame", ({ room }) => {
    const r = rooms[room];
    if (!r) return;
    const requester = getPlayerBySocket(r, socket.id);
    if (!requester || r.hostId !== requester.playerId) return;

    console.log(`Partie lancée dans la salle ${room}`);

    const numPlayers = r.players.length;
    if (numPlayers < 2 || numPlayers > 6) {
      console.log("Nombre de joueurs invalide pour démarrer :", numPlayers);
      return;
    }

    let cardsPerPlayer;
    switch (numPlayers) {
      case 2: cardsPerPlayer = 8; break;
      case 3: cardsPerPlayer = 7; break;
      case 4: cardsPerPlayer = 6; break;
      case 5: cardsPerPlayer = 5; break;
      case 6: cardsPerPlayer = 4; break;
      default: cardsPerPlayer = 6;
    }

    const deck = createDeck();
    shuffle(deck);
  });

  socket.on("startGameWithMode", ({ room, mode, rounds }) => {
    const r = rooms[room];
    if (!r) return;
    const requester = r.players.find((p) => p.socketId === socket.id);
    if (!requester || requester.playerId !== r.hostId) return;

    if (!["battle", "chill"].includes(mode)) {
      mode = "battle";
    }
    const chillTarget = Math.max(1, rounds || 1);
    r.settings.mode = mode;
    r.settings.totalRounds = mode === "chill" ? chillTarget : 0;
    r.settings.currentRound = 1;
    r.settings.scores = {};

    r.players.forEach((p) => {
      p.eliminated = false;
      p.leftCurrentGame = false;
      r.settings.scores[p.playerId] = 0;
    });

    io.to(room).emit("gameStarted", { room, mode, rounds: r.settings.totalRounds });
    startNewRound(room);
  });

  // Jouer une carte (hors 8 avec choix de couleur)
  socket.on("playCard", ({ room, cardId }) => {
    const r = rooms[room];
    if (!r || !r.game) return;
    const g = r.game;

    if (g.cartePhaseActive) {
      sendErrorTo(
        socket.id,
        "La phase 'carte / contre carte' est en cours, il faut d'abord cliquer sur 'Carte' ou 'Contre carte'."
      );
      return;
    }

    if (g.pendingEight) {
      sendErrorTo(socket.id, "Le joueur doit d'abord choisir une couleur pour son 8.");
      return;
    }

    const playerIndex = g.playerStates.findIndex(
      (ps) => ps.socketId === socket.id
    );
    if (playerIndex === -1) return;

    if (playerIndex !== g.currentTurnIndex) {
      sendErrorTo(socket.id, "Ce n'est pas ton tour.");
      return;
    }

    const ps = g.playerStates[playerIndex];
    const previousHandLength = ps.hand.length;
    const cardIdx = ps.hand.findIndex((c) => c.id === cardId);
    if (cardIdx === -1) {
      sendErrorTo(socket.id, "Cette carte n'est pas dans ta main.");
      return;
    }

    const card = ps.hand[cardIdx];
    const isSeven = card.rank === "7";
    const skipActive = (g.skipTurns || 0) > 0;

    if (skipActive && !isSeven) {
      sendErrorTo(
        socket.id,
        "Tu es sous l'effet d'un 7 : tu peux jouer un 7 pour renvoyer l'effet, ou cliquer sur 'Sauter le tour'."
      );
      return;
    }

    if (
      g.attackPlus > 0 &&
      card.rank !== "A" &&
      card.rank !== "8" &&
      !(skipActive && isSeven)
    ) {
      sendErrorTo(
        socket.id,
        "Tu subis une attaque d'As : tu dois jouer un As, un 8 ou piocher."
      );
      return;
    }

    // 8 : choix de couleur
    if (card.rank === "8") {
      ps.hand.splice(cardIdx, 1);
      g.discardPile.push(card);

      const attackWasActive = g.attackPlus > 0;
      if (attackWasActive) {
        let contreSoundIndex = 0;
        if (HUIT_CONTRE_SOUND_COUNT > 0) {
          contreSoundIndex = Math.floor(
            Math.random() * HUIT_CONTRE_SOUND_COUNT
          );
        }

        g.attackPlus = 0;
        io.to(room).emit("effectEvent", {
          type: "contreHuit",
          sourcePlayerId: ps.playerId,
          message: `${ps.pseudo} a contré l'attaque et va choisir une couleur`,
          soundIndex: contreSoundIndex,
        });
      } else {
        io.to(room).emit("effectEvent", {
          type: "huitChoixCouleur",
          sourcePlayerId: ps.playerId,
          message: `${ps.pseudo} choisit une couleur`,
        });
      }

      g.pendingEight = {
        playerIndex,
        cardId: card.id,
        previousHandLength,
      };

      io.to(ps.socketId).emit("askColor", { cardId: card.id });

      console.log(`${ps.pseudo} a joué un 8 dans la salle ${room}, choix de couleur en attente.`);
      broadcastGameState(room);
      return;
    }

    if (!(skipActive && isSeven) && !isCardPlayable(g, card)) {
      sendErrorTo(
        socket.id,
        "Coup impossible : il faut suivre la couleur imposée ou jouer la même valeur (le 8 est joker)."
      );
      return;
    }

    // 10 : rejouer
    if (card.rank === "10") {
      ps.hand.splice(cardIdx, 1);
      g.discardPile.push(card);
      g.currentColor = card.suit;

      console.log(
        `${ps.pseudo} joue 10 de ${card.suit} et rejoue immédiatement dans la salle ${room}`
      );

      const triedToFinishOnTen = previousHandLength === 1;

      // Impossible de finir sur un 10
      if (ps.hand.length === 0) {
        reshuffleIfNeeded(g);
        if (g.drawPile.length > 0) {
          const penalty = g.drawPile.shift();
          ps.hand.push(penalty);
          console.log(
            `${ps.pseudo} ne peut pas finir sur un 10 : il pioche 1 carte de pénalité.`
          );
        } else {
          console.log(
            `${ps.pseudo} ne peut pas finir sur un 10 mais la pioche est vide dans la salle ${room}.`
          );
        }
      }

      if (triedToFinishOnTen) {
        g.extraTurnPending = false;

        if (checkEndOfTurnAndCartePhase(room, g, ps, playerIndex, previousHandLength)) {
          return;
        }

        g.currentTurnIndex = nextPlayerIndex(g);
        broadcastGameState(room);
        return;
      }

      const hasPlayable = ps.hand.some((c) => isCardPlayable(g, c));

      if (!hasPlayable) {
        // Pas de coup possible après le 10 : il pioche 1 carte et passe son tour
        reshuffleIfNeeded(g);
        if (g.drawPile.length > 0) {
          const forced = g.drawPile.shift();
          ps.hand.push(forced);
          console.log(
            `${ps.pseudo} n'a aucun coup après son 10 : il pioche 1 carte et passe son tour dans la salle ${room}.`
          );
        } else {
          console.log(
            `${ps.pseudo} n'a aucun coup après son 10 mais la pioche est vide dans la salle ${room}.`
          );
        }

        g.extraTurnPending = false;

        if (checkEndOfTurnAndCartePhase(room, g, ps, playerIndex, previousHandLength)) {
          return;
        }

        g.currentTurnIndex = nextPlayerIndex(g);
        broadcastGameState(room);
        return;
      }

      // Il a encore au moins un coup possible : son tour continue (rejoue)
      g.extraTurnPending = true;

      if (
        checkEndOfTurnAndCartePhase(
          room,
          g,
          ps,
          playerIndex,
          previousHandLength,
          true
        )
      ) {
        return;
      }

      broadcastGameState(room);
      return;
    }

    // 7 : saute tour / chaîne
    if (isSeven) {
      ps.hand.splice(cardIdx, 1);
      g.discardPile.push(card);
      g.currentColor = card.suit;

      const threatenedIndex = nextPlayerIndex(g);
      const threatened = g.playerStates[threatenedIndex];
      const isDuel = g.playerStates.length === 2;

      if (threatened) {
        io.to(room).emit("effectEvent", {
          type: "skipSeven",
          sourcePlayerId: ps.playerId,
          targetPlayerId: threatened.playerId,
          message: `${ps.pseudo} essaye de sauter ${threatened.pseudo}`,
        });
      }

      if (skipActive) {
        console.log(`Chaîne de 7 : ${ps.pseudo} répond avec un 7.`);
      } else if (threatened) {
        console.log(
          `${ps.pseudo} joue un 7, le tour de ${threatened.pseudo} est menacé.`
        );
      }

      // Règle 1v1 : on ne peut pas finir sur un 7
      if (isDuel && ps.hand.length === 0) {
        reshuffleIfNeeded(g);
        if (g.drawPile.length > 0) {
          const penaltyCard = g.drawPile.shift();
          ps.hand.push(penaltyCard);
        }
      }

      g.skipTurns = 1;
      g.currentTurnIndex = threatenedIndex;
      g.extraTurnPending = false; // le joueur ne rejoue pas directement après un 7

      if (checkEndOfTurnAndCartePhase(
        room,
        g,
        ps,
        playerIndex,
        previousHandLength,
        true
      )) {
        return;
      }

      setTimeout(() => {
        broadcastGameState(room);
      }, 50);
      return;
    }

    // Valet
    if (card.rank === "V") {
      const activePlayers = g.playerStates.filter(
        (st) => Array.isArray(st.hand) && st.hand.length > 0
      );
      const isDuel = activePlayers.length === 2;
      const triedToFinishOnJack = previousHandLength === 1;

      ps.hand.splice(cardIdx, 1);
      g.discardPile.push(card);
      g.currentColor = card.suit;

      if (ps.hand.length === 0) {
        g.skipTurns = 0;
      }

      io.to(room).emit("effectEvent", {
        type: "valet",
        message: `${ps.pseudo} change le sens`,
      });

      if (isDuel && triedToFinishOnJack) {
        console.log(
          `${ps.pseudo} tente de finir sur un Valet en duel dans la salle ${room} : pénalité.`
        );
        reshuffleIfNeeded(g);
        if (g.drawPile.length > 0) {
          const penalty = g.drawPile.shift();
          ps.hand.push(penalty);
        }

        g.extraTurnPending = false;

        if (checkEndOfTurnAndCartePhase(room, g, ps, playerIndex, previousHandLength)) {
          return;
        }

        g.currentTurnIndex = nextPlayerIndex(g);
        broadcastGameState(room);
        return;
      }

      if (isDuel && ps.hand.length > 0) {
        console.log(
          `${ps.pseudo} joue un Valet en duel dans la salle ${room} : le tour lui revient.`
        );

        // Impossible de finir sur un Valet en 1v1
        if (ps.hand.length === 0) {
          reshuffleIfNeeded(g);
          if (g.drawPile.length > 0) {
            const penalty = g.drawPile.shift();
            ps.hand.push(penalty);
            console.log(
              `${ps.pseudo} ne peut pas finir sur un Valet en duel : il pioche 1 carte.`
            );
          }
        }

        // Le tour reste au même joueur (rejoue)
        g.extraTurnPending = true;

        if (checkEndOfTurnAndCartePhase(room, g, ps, playerIndex, previousHandLength)) {
          return;
        }

        broadcastGameState(room);
        return;
      } else {
        // Changement de sens
        g.direction = (g.direction || 1) * -1;

        console.log(
          `${ps.pseudo} joue un Valet de ${card.suit} dans la salle ${room} : le sens du jeu est inversé.`
        );

        g.extraTurnPending = false;

        if (checkEndOfTurnAndCartePhase(room, g, ps, playerIndex, previousHandLength)) {
          return;
        }

        g.currentTurnIndex = nextPlayerIndex(g);
        broadcastGameState(room);
        return;
      }
    }

    // Roi de cœur : l'adversaire pioche 3 cartes et son tour est sauté
    if (card.rank === "R" && card.suit === "coeur") {
      // Le joueur courant pose le Roi de cœur
      ps.hand.splice(cardIdx, 1);
      g.discardPile.push(card);
      g.currentColor = card.suit;

      // La victime est le prochain joueur "normal"
      const victimIndex = nextPlayerIndex(g);
      const forcedPlayer = g.playerStates[victimIndex];

      if (forcedPlayer) {
        for (let i = 0; i < 3; i++) {
          reshuffleIfNeeded(g);
          if (g.drawPile.length === 0) break;
          const drawnCard = g.drawPile.shift();
          forcedPlayer.hand.push(drawnCard);
        }
      }

      // Choix d'un son aléatoire pour le Roi de cœur, partagé à toute la room
      let roiSoundIndex = 0;
      if (ROI_COEUR_SOUND_COUNT > 0) {
        roiSoundIndex = Math.floor(Math.random() * ROI_COEUR_SOUND_COUNT);
      }

      io.to(room).emit("effectEvent", {
        type: "roiCoeur",
        message: `Charlie dans la gueule de ${forcedPlayer.pseudo} - Il peut rien faire`,
        soundIndex: roiSoundIndex,
      });

      console.log(
        `${ps.pseudo} a joué le Roi de cœur. ${forcedPlayer.pseudo} pioche 3 cartes (in-contrable). Son spécial index=${roiSoundIndex}.`
      );

      // On considère que le "curseur" de tour est maintenant sur la victime,
      // dont le tour va être totalement sauté.
      g.currentTurnIndex = victimIndex;
      g.skipTurns = 0;
      g.extraTurnPending = false;

      // Gérer éventuellement la fin de manche / phase "carte" pour le poseur du Roi
      if (checkEndOfTurnAndCartePhase(room, g, ps, playerIndex, previousHandLength)) {
        return;
      }

      // Pas de phase "carte" : on saute immédiatement la victime
      g.currentTurnIndex = nextPlayerIndex(g);
      broadcastGameState(room);
      return;
    }

    // As (+2)
    if (card.rank === "A") {
      ps.hand.splice(cardIdx, 1);
      g.discardPile.push(card);
      g.currentColor = card.suit;

      g.attackPlus = Math.min(g.attackPlus + 2, 8);

      console.log(
        `${ps.pseudo} joue As de ${card.suit} (+${g.attackPlus} au total) dans la salle ${room}`
      );

      const threatenedIndex = nextPlayerIndex(g);
      const threatened = g.playerStates[threatenedIndex];

      if (threatened) {
        let asSoundIndex = 0;
        if (AS_SOUND_COUNT > 0) {
          asSoundIndex = Math.floor(Math.random() * AS_SOUND_COUNT);
        }

        io.to(room).emit("effectEvent", {
          type: "attaqueAs",
          sourcePlayerId: ps.playerId,
          targetPlayerId: threatened.playerId,
          message: `${ps.pseudo} envoie un +${g.attackPlus} à ${threatened.pseudo}`,
          soundIndex: asSoundIndex,
        });
      }

      g.extraTurnPending = false;

      if (
        checkEndOfTurnAndCartePhase(
          room,
          g,
          ps,
          playerIndex,
          previousHandLength
        )
      ) {
        return;
      }

      g.currentTurnIndex = nextPlayerIndex(g);
      broadcastGameState(room);
      return;
    }

    // Carte "normale"
    ps.hand.splice(cardIdx, 1);
    g.discardPile.push(card);
    g.currentColor = card.suit;

    console.log(
      `${ps.pseudo} joue ${card.rank} de ${card.suit} dans la salle ${room}`
    );

    g.extraTurnPending = false;

    if (checkEndOfTurnAndCartePhase(room, g, ps, playerIndex, previousHandLength)) {
      return;
    }

    g.currentTurnIndex = nextPlayerIndex(g);
    broadcastGameState(room);
  });

  // Choix de couleur pour un 8
  socket.on("playEight", ({ room, cardId, color }) => {
    const r = rooms[room];
    if (!r || !r.game) return;
    const g = r.game;

    const pending = g.pendingEight;
    if (!pending) {
      sendErrorTo(socket.id, "Aucun 8 en attente de couleur.");
      return;
    }

    const playerIndex = g.playerStates.findIndex(
      (ps) => ps.socketId === socket.id
    );
    if (playerIndex === -1) return;

    if (playerIndex !== pending.playerIndex) {
      sendErrorTo(socket.id, "Ce n'est pas toi qui dois choisir la couleur pour ce 8.");
      return;
    }

    const ps = g.playerStates[playerIndex];
    const previousHandLength = pending.previousHandLength;

    const top = g.discardPile[g.discardPile.length - 1];
    if (!top || top.id !== cardId || top.rank !== "8") {
      sendErrorTo(socket.id, "La carte 8 attendue n'est pas trouvée.");
      g.pendingEight = null;
      return;
    }

    if (!["coeur", "carreau", "trefle", "pique"].includes(color)) {
      sendErrorTo(socket.id, "Couleur invalide pour le 8.");
      return;
    }

    g.currentColor = color;
    g.pendingEight = null;

    console.log(
      `${ps.pseudo} a choisi la couleur ${color} après avoir joué un 8 dans la salle ${room}`
    );

    g.extraTurnPending = false;

    if (checkEndOfTurnAndCartePhase(room, g, ps, playerIndex, previousHandLength)) {
      return;
    }

    g.currentTurnIndex = nextPlayerIndex(g);
    broadcastGameState(room);
  });

  // Piocher
  socket.on("drawCard", ({ room }) => {
    const r = rooms[room];
    if (!r || !r.game) return;
    const g = r.game;

    if (g.cartePhaseActive) {
      sendErrorTo(
        socket.id,
        "La phase 'carte / contre carte' est en cours, il faut d'abord la résoudre."
      );
      return;
    }

    if (g.pendingEight) {
      sendErrorTo(socket.id, "Il faut d'abord choisir une couleur pour le 8 joué.");
      return;
    }

    const playerIndex = g.playerStates.findIndex(
      (ps) => ps.socketId === socket.id
    );
    if (playerIndex === -1) return;

    if (playerIndex !== g.currentTurnIndex) {
      sendErrorTo(socket.id, "Ce n'est pas ton tour.");
      return;
    }

    const ps = g.playerStates[playerIndex];

    const skipActive = (g.skipTurns || 0) > 0;

    if (skipActive) {
      console.log(
        `${ps.pseudo} est sous l'effet d'un 7 : son tour est sauté (pas de pioche).`
      );
      g.skipTurns = 0;
      g.extraTurnPending = false;
      g.currentTurnIndex = nextPlayerIndex(g);
      broadcastGameState(room);
      return;
    }

    reshuffleIfNeeded(g);
    if (g.drawPile.length === 0) {
      sendErrorTo(socket.id, "La pioche est vide.");
      return;
    }

    let nbToDraw = 1;
    if (g.attackPlus > 0) {
      nbToDraw = g.attackPlus;
    }

    let actuallyDrawn = 0;
    for (let i = 0; i < nbToDraw; i++) {
      reshuffleIfNeeded(g);
      if (g.drawPile.length === 0) break;
      const c = g.drawPile.shift();
      ps.hand.push(c);
      actuallyDrawn++;
    }

    if (g.attackPlus > 0) {
      const penalty = g.attackPlus;
      console.log(
        `${ps.pseudo} pioche ${actuallyDrawn} carte(s) à cause de l'attaque d'As dans la salle ${room}`
      );

      g.attackPlus = 0;
    } else {
      console.log(`${ps.pseudo} pioche 1 carte dans la salle ${room}`);
    }

    g.extraTurnPending = false;

    if (checkEndOfTurnAndCartePhase(room, g, ps, playerIndex)) {
      return;
    }

    g.currentTurnIndex = nextPlayerIndex(g);
    broadcastGameState(room);
  });

  socket.on("announceCarte", ({ room }) => {
    const r = rooms[room];
    if (!r || !r.game) return;
    const g = r.game;

    if (!g.cartePhaseActive) return;

    const playerIndex = g.playerStates.findIndex(
      (ps) => ps.socketId === socket.id
    );
    if (playerIndex === -1) return;

    if (playerIndex !== g.carteTargetIndex) {
      sendErrorTo(
        socket.id,
        "Seul le joueur à 1 carte peut cliquer sur 'Carte'."
      );
      return;
    }

    const target = g.playerStates[g.carteTargetIndex];

    io.to(room).emit("effectEvent", {
      type: "carte",
      message: `${target.pseudo} a annoncé 'carte' à temps. Il ne pioche pas.`,
    });

    console.log(
      `${target.pseudo} a annoncé 'carte' à temps dans la salle ${room}.`
    );

    endCartePhase(room);

    broadcastGameState(room);
  });

  socket.on("announceContreCarte", ({ room }) => {
    const r = rooms[room];
    if (!r || !r.game) return;
    const g = r.game;

    if (!g.cartePhaseActive || !g.carteContreDisponible) return;

    const playerIndex = g.playerStates.findIndex(
      (ps) => ps.socketId === socket.id
    );
    if (playerIndex === -1) return;

    if (playerIndex === g.carteTargetIndex) {
      sendErrorTo(socket.id, "Tu ne peux pas te contrer toi-même.");
      return;
    }

    const penalIndex = g.carteTargetIndex;
    const penal = g.playerStates[penalIndex];

    let piochees = 0;
    for (let i = 0; i < 2; i++) {
      reshuffleIfNeeded(g);
      if (g.drawPile.length === 0) break;
      const c = g.drawPile.shift();
      penal.hand.push(c);
      piochees++;
    }

    io.to(room).emit("effectEvent", {
      type: "contreCarte",
      message: `${penal.pseudo} s'est fait contrer ! Il pioche ${piochees} carte(s).`,
    });

    console.log(
      `${penal.pseudo} s'est fait contrer dans la salle ${room} et pioche ${piochees} carte(s).`
    );

    endCartePhase(room);

    broadcastGameState(room);
  });

  socket.on("disconnect", () => {
    console.log("Déconnexion :", socket.id);
    for (const [roomCode, r] of Object.entries(rooms)) {
      const player = r.players.find((p) => p.socketId === socket.id);
      if (player) {
        player.isConnected = false;
        player.socketId = null;
        updatePlayerSocketReference(r, player.playerId, null);
        sendPlayersUpdate(roomCode);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});
