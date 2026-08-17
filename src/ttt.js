// In-memory game state per chat - {chatId: {board, players: [p1Id, p2Id], turn, names: {}}}
const games = new Map();

const EMPTY_BOARD = () => Array(9).fill(null);

function buildKeyboard(chatId, board) {
  const symbols = { X: '❌', O: '⭕', null: '➖' };
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      row.push({
        text: symbols[board[i]],
        callback_data: `ttt:${chatId}:${i}`,
      });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function checkWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
    [0, 4, 8], [2, 4, 6], // diagonals
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every(cell => cell)) return 'draw';
  return null;
}

// Naya game start karta hai, ek player ke saath (dusra "Join" button se aayega)
function startGame(chatId, player1Id, player1Name) {
  games.set(String(chatId), {
    board: EMPTY_BOARD(),
    players: [player1Id, null],
    names: { [player1Id]: player1Name },
    turn: player1Id,
  });
}

function joinGame(chatId, player2Id, player2Name) {
  const game = games.get(String(chatId));
  if (!game || game.players[1]) return null;
  if (game.players[0] === player2Id) return null; // khud ke against nahi khel sakta
  game.players[1] = player2Id;
  game.names[player2Id] = player2Name;
  return game;
}

function getGame(chatId) {
  return games.get(String(chatId)) || null;
}

// Move karta hai, return karta hai: { success, winner, board } ya { success: false, reason }
function makeMove(chatId, playerId, cellIndex) {
  const game = games.get(String(chatId));
  if (!game) return { success: false, reason: 'no_game' };
  if (!game.players[1]) return { success: false, reason: 'waiting_for_player' };
  if (game.turn !== playerId) return { success: false, reason: 'not_your_turn' };
  if (game.board[cellIndex]) return { success: false, reason: 'cell_taken' };

  const symbol = playerId === game.players[0] ? 'X' : 'O';
  game.board[cellIndex] = symbol;

  const winner = checkWinner(game.board);
  if (winner) {
    games.delete(String(chatId));
    return { success: true, winner, board: game.board, game };
  }

  game.turn = game.turn === game.players[0] ? game.players[1] : game.players[0];
  return { success: true, winner: null, board: game.board, game };
}

function endGame(chatId) {
  games.delete(String(chatId));
}

module.exports = { startGame, joinGame, getGame, makeMove, endGame, buildKeyboard, checkWinner };