/*
=============================================================================
6x7 TACTICAL BOARD GAME - MULTIPLAYER SERVER (Updated with Board Size Options)
=============================================================================

DEPLOYMENT INSTRUCTIONS:
1. Create a new folder for your game
2. Save this file as 'server.js'
3. Save the HTML file as 'public/index.html'
4. Run: npm init -y
5. Run: npm install express socket.io
6. Run: node server.js
7. Share the URL with your friend!

For hosting online:
- Use services like Heroku, Railway, or Render
- They support Node.js apps with these dependencies

=============================================================================
*/

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Game state management
const gameRooms = new Map();

class GameRoom {
    constructor(roomId, boardSize = { width: 6, height: 7 }) {
        this.roomId = roomId;
        this.boardSize = boardSize;
        this.players = new Map(); // playerId -> {socket, playerNumber, name}
        this.gameState = this.initializeGameState();
        this.spectators = new Set();
    }

    initializeGameState() {
        return {
            currentPlayer: 1,
            gamePhase: 'waiting', // 'waiting', 'placement', 'battle'
            placementTurn: 1,
            piecesPlacedThisTurn: 0,
            hasMoved: false,
            hasAttacked: false,
            gameEnded: false,
            winner: null,
            boardSize: this.boardSize,
            
            // Board state - dynamic size
            board: Array(this.boardSize.height).fill(null).map(() => Array(this.boardSize.width).fill(null)),
            
            // Piece counts
            player1Pieces: { 'General': 1, 'Cavalry': 2, 'Heavy Infantry': 2, 'Light Infantry': 2, 'Archer': 1 },
            player2Pieces: { 'General': 1, 'Cavalry': 2, 'Heavy Infantry': 2, 'Light Infantry': 2, 'Archer': 1 },
            
            // Game options
            lineOfSightEnabled: false,
            limitedRangeEnabled: false,
            
            // Selection state
            selectedPiece: null,
            selectedCell: null
        };
    }

    addPlayer(socket, playerName, requestedBoardSize) {
        if (this.players.size >= 2) {
            // Add as spectator
            this.spectators.add(socket.id);
            socket.emit('joinedAsSpectator');
            this.broadcastGameState();
            return false;
        }

        // Check board size compatibility
        if (this.players.size === 1 && requestedBoardSize) {
            if (requestedBoardSize.width !== this.boardSize.width || 
                requestedBoardSize.height !== this.boardSize.height) {
                socket.emit('error', `Board size mismatch! Room uses ${this.boardSize.width}x${this.boardSize.height}`);
                return false;
            }
        }

        const playerNumber = this.players.size + 1;
        this.players.set(socket.id, {
            socket: socket,
            playerNumber: playerNumber,
            name: playerName
        });

        socket.emit('playerAssigned', { 
            playerNumber: playerNumber,
            playerName: playerName 
        });

        // Start game if we have 2 players
        if (this.players.size === 2) {
            this.gameState.gamePhase = 'placement';
            this.broadcastMessage(`Game started! ${this.getPlayerName(1)} goes first.`);
        }

        this.broadcastGameState();
        this.broadcastPlayerList();
        return true;
    }

    removePlayer(socketId) {
        if (this.players.has(socketId)) {
            const player = this.players.get(socketId);
            this.players.delete(socketId);
            
            if (this.players.size === 0) {
                // Room is empty, can be cleaned up
                return true;
            }
            
            // Reassign player numbers if needed
            if (this.players.size === 1) {
                const remainingPlayer = Array.from(this.players.values())[0];
                this.players.set(remainingPlayer.socket.id, {
                    ...remainingPlayer,
                    playerNumber: 1
                });
                remainingPlayer.socket.emit('playerAssigned', { 
                    playerNumber: 1,
                    playerName: remainingPlayer.name 
                });
                
                // Reset game state
                this.gameState = this.initializeGameState();
                this.broadcastMessage(`${player.name} left. Waiting for another player...`);
            }
            
            this.broadcastGameState();
            this.broadcastPlayerList();
        } else if (this.spectators.has(socketId)) {
            this.spectators.delete(socketId);
        }
        
        return false;
    }

    getPlayerName(playerNumber) {
        for (const player of this.players.values()) {
            if (player.playerNumber === playerNumber) {
                return player.name;
            }
        }
        return `Player ${playerNumber}`;
    }

    getPlayerBySocketId(socketId) {
        return this.players.get(socketId);
    }

    isPlayerTurn(socketId) {
        const player = this.getPlayerBySocketId(socketId);
        return player && player.playerNumber === this.gameState.currentPlayer;
    }

    broadcastGameState() {
        const stateData = {
            ...this.gameState,
            playerNames: {
                1: this.getPlayerName(1),
                2: this.getPlayerName(2)
            }
        };
        
        this.broadcast('gameStateUpdate', stateData);
    }

    broadcastPlayerList() {
        const playerList = Array.from(this.players.values()).map(p => ({
            name: p.name,
            playerNumber: p.playerNumber
        }));
        
        this.broadcast('playerListUpdate', {
            players: playerList,
            spectatorCount: this.spectators.size
        });
    }

    broadcastMessage(message, type = 'info') {
        this.broadcast('gameMessage', { message, type });
    }

    broadcast(event, data) {
        // Send to all players
        for (const player of this.players.values()) {
            player.socket.emit(event, data);
        }
        
        // Send to all spectators
        for (const spectatorId of this.spectators) {
            const spectatorSocket = io.sockets.sockets.get(spectatorId);
            if (spectatorSocket) {
                spectatorSocket.emit(event, data);
            }
        }
    }

    // Helper method to get placement rows for players
    getPlacementRows(player) {
        const topRows = Math.ceil(this.boardSize.height / 3);
        const bottomRows = Math.ceil(this.boardSize.height / 3);
        
        if (player === 1) {
            return { min: 0, max: topRows - 1 };
        } else {
            return { min: this.boardSize.height - bottomRows, max: this.boardSize.height - 1 };
        }
    }

    // Helper method to get healing rows
    getHealingRows() {
        return {
            player1: this.boardSize.height - 1, // Bottom row for player 1
            player2: 0 // Top row for player 2
        };
    }
}

// Socket connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinRoom', (data) => {
        const { roomId, playerName, boardSize } = data;
        
        if (!roomId || !playerName) {
            socket.emit('error', 'Room ID and player name are required');
            return;
        }

        // Leave any existing rooms
        socket.rooms.forEach(room => {
            if (room !== socket.id) {
                socket.leave(room);
            }
        });

        socket.join(roomId);

        // Get or create game room
        if (!gameRooms.has(roomId)) {
            const size = boardSize || { width: 6, height: 7 };
            gameRooms.set(roomId, new GameRoom(roomId, size));
        }

        const gameRoom = gameRooms.get(roomId);
        gameRoom.addPlayer(socket, playerName, boardSize);

        console.log(`${playerName} joined room ${roomId} with board size ${gameRoom.boardSize.width}x${gameRoom.boardSize.height}`);
    });

    // Game action handlers
    socket.on('gameAction', (data) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) return;

        const gameRoom = gameRooms.get(roomId);
        if (!gameRoom) return;

        const player = gameRoom.getPlayerBySocketId(socket.id);
        if (!player) return;

        // Process game action based on type
        switch (data.type) {
            case 'placePiece':
                handlePlacePiece(gameRoom, player, data);
                break;
            case 'selectCell':
                handleSelectCell(gameRoom, player, data);
                break;
            case 'endTurn':
                handleEndTurn(gameRoom, player);
                break;
            case 'toggleOption':
                handleToggleOption(gameRoom, player, data);
                break;
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Remove from all game rooms
        for (const [roomId, gameRoom] of gameRooms.entries()) {
            const shouldDeleteRoom = gameRoom.removePlayer(socket.id);
            if (shouldDeleteRoom) {
                gameRooms.delete(roomId);
                console.log(`Room ${roomId} deleted`);
            }
        }
    });
});

// Game action handlers
function handlePlacePiece(gameRoom, player, data) {
    const { pieceType, row, col } = data;
    const gameState = gameRoom.gameState;

    // Validate it's player's turn and placement phase
    if (!gameRoom.isPlayerTurn(player.socket.id) || gameState.gamePhase !== 'placement') {
        return;
    }

    // Validate placement rules
    if (gameState.piecesPlacedThisTurn >= 4) {
        gameRoom.broadcastMessage('You can only place 4 pieces per turn!', 'error');
        return;
    }

    if (gameState.board[row][col]) {
        gameRoom.broadcastMessage('Cell is already occupied!', 'error');
        return;
    }

    // Check placement zone based on board size
    const placementRows = gameRoom.getPlacementRows(player.playerNumber);
    if (row < placementRows.min || row > placementRows.max) {
        gameRoom.broadcastMessage(`Player ${player.playerNumber} can only place pieces in their territory!`, 'error');
        return;
    }

    const pieces = player.playerNumber === 1 ? gameState.player1Pieces : gameState.player2Pieces;
    if (pieces[pieceType] === 0) {
        gameRoom.broadcastMessage('No more pieces of this type available!', 'error');
        return;
    }

    // Place the piece
    const pieceTypes = {
        'General': { symbol: '♔', health: 3 },
        'Cavalry': { symbol: '♘', health: 2 },
        'Heavy Infantry': { symbol: '⚔️', health: 3 },
        'Light Infantry': { symbol: '🗡️', health: 2 },
        'Archer': { symbol: '🏹', health: 2, ammo: 3 }
    };

    const pieceData = {
        type: pieceType,
        player: player.playerNumber,
        health: pieceTypes[pieceType].health,
        maxHealth: pieceTypes[pieceType].health,
        hasBeenReplenished: false
    };

    if (pieceType === 'Archer') {
        pieceData.ammo = pieceTypes[pieceType].ammo;
    }

    gameState.board[row][col] = pieceData;
    pieces[pieceType]--;
    gameState.piecesPlacedThisTurn++;

    gameRoom.broadcastGameState();
}

function handleSelectCell(gameRoom, player, data) {
    const { row, col } = data;
    const gameState = gameRoom.gameState;

    // Only handle battle phase selections
    if (gameState.gamePhase !== 'battle' || !gameRoom.isPlayerTurn(player.socket.id)) {
        return;
    }

    if (!gameState.selectedCell) {
        // Select a piece
        const piece = gameState.board[row][col];
        if (piece && piece.player === player.playerNumber) {
            gameState.selectedCell = { row, col };
            gameRoom.broadcastGameState();
        }
    } else {
        // Handle move or attack
        const selectedPiece = gameState.board[gameState.selectedCell.row][gameState.selectedCell.col];
        const targetPiece = gameState.board[row][col];

        if (gameState.selectedCell.row === row && gameState.selectedCell.col === col) {
            // Deselect
            gameState.selectedCell = null;
            gameRoom.broadcastGameState();
            return;
        }

        if (!targetPiece && canMove(selectedPiece, gameState.selectedCell.row, gameState.selectedCell.col, row, col, gameRoom.boardSize)) {
            // Move piece
            if (!gameState.hasAttacked && !gameState.hasMoved) {
                movePiece(gameRoom, gameState.selectedCell.row, gameState.selectedCell.col, row, col);
                gameState.hasMoved = true;
                gameRoom.broadcastMessage('Move completed! You can now attack with any piece or end turn.', 'success');
            } else if (gameState.hasMoved) {
                gameRoom.broadcastMessage('You can only move once per turn!', 'error');
            } else if (gameState.hasAttacked) {
                gameRoom.broadcastMessage('You cannot move after attacking!', 'error');
            }
        } else if (targetPiece && targetPiece.player !== selectedPiece.player && canAttack(selectedPiece, gameState.selectedCell.row, gameState.selectedCell.col, row, col, gameState, gameRoom.boardSize)) {
            // Attack piece - FIXED: Can attack without moving first
            if (!gameState.hasAttacked) {
                attackPiece(gameRoom, gameState.selectedCell.row, gameState.selectedCell.col, row, col);
                gameState.hasAttacked = true;
                gameRoom.broadcastMessage('Attack completed! Turn is over.', 'success');
            } else {
                gameRoom.broadcastMessage('You can only attack once per turn!', 'error');
            }
        } else {
            gameRoom.broadcastMessage('Invalid move or attack!', 'error');
        }

        gameState.selectedCell = null;
        gameRoom.broadcastGameState();
    }
}

function handleEndTurn(gameRoom, player) {
    const gameState = gameRoom.gameState;

    if (!gameRoom.isPlayerTurn(player.socket.id)) {
        return;
    }

    // Validate turn completion
    if (gameState.gamePhase === 'placement' && gameState.piecesPlacedThisTurn !== 4) {
        gameRoom.broadcastMessage('You must place exactly 4 pieces before ending your turn!', 'error');
        return;
    }

    // Reset turn state
    gameState.selectedPiece = null;
    gameState.selectedCell = null;
    gameState.hasMoved = false;
    gameState.hasAttacked = false;

    // Clear cavalry charge directions
    for (let row = 0; row < gameRoom.boardSize.height; row++) {
        for (let col = 0; col < gameRoom.boardSize.width; col++) {
            if (gameState.board[row][col] && gameState.board[row][col].type === 'Cavalry') {
                gameState.board[row][col].chargeDirection = null;
            }
        }
    }

    // Handle phase transitions
    if (gameState.gamePhase === 'placement') {
        gameState.piecesPlacedThisTurn = 0;
        if (gameState.currentPlayer === 1) {
            gameState.currentPlayer = 2;
        } else {
            gameState.currentPlayer = 1;
            gameState.placementTurn++;
            if (gameState.placementTurn > 2) {
                gameState.gamePhase = 'battle';
                gameRoom.broadcastMessage('Battle Phase begins! You can move first (optional) then attack, OR just attack directly!', 'info');
            }
        }
    } else {
        gameState.currentPlayer = gameState.currentPlayer === 1 ? 2 : 1;
    }

    gameRoom.broadcastGameState();
}

function handleToggleOption(gameRoom, player, data) {
    const { option } = data;
    const gameState = gameRoom.gameState;

    // Only allow options to be changed during placement phase
    if (gameState.gamePhase !== 'placement' && gameState.gamePhase !== 'waiting') {
        return;
    }

    switch (option) {
        case 'lineOfSight':
            gameState.lineOfSightEnabled = !gameState.lineOfSightEnabled;
            gameRoom.broadcastMessage(`Line of Sight ${gameState.lineOfSightEnabled ? 'enabled' : 'disabled'}`, 'info');
            break;
        case 'limitedRange':
            gameState.limitedRangeEnabled = !gameState.limitedRangeEnabled;
            gameRoom.broadcastMessage(`Archer range ${gameState.limitedRangeEnabled ? 'limited to 4 spaces' : 'unlimited'}`, 'info');
            break;
    }

    gameRoom.broadcastGameState();
}

// Game logic functions
function canMove(piece, fromRow, fromCol, toRow, toCol, boardSize) {
    // Check bounds
    if (toRow < 0 || toRow >= boardSize.height || toCol < 0 || toCol >= boardSize.width) {
        return false;
    }

    if (piece.type === 'Cavalry') {
        const rowDiff = Math.abs(fromRow - toRow);
        const colDiff = Math.abs(fromCol - toCol);
        return (rowDiff <= 2 && colDiff === 0) || (rowDiff === 0 && colDiff <= 2);
    } else {
        const distance = Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol);
        return distance === 1;
    }
}

function canAttack(piece, fromRow, fromCol, toRow, toCol, gameState, boardSize) {
    // Check bounds
    if (toRow < 0 || toRow >= boardSize.height || toCol < 0 || toCol >= boardSize.width) {
        return false;
    }

    const target = gameState.board[toRow][toCol];
    if (!target || target.player === piece.player) return false;

    if (piece.type === 'Archer') {
        const distance = Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol);
        if (distance === 1) return true;
        if (piece.ammo > 0 && (fromRow === toRow || fromCol === toCol)) {
            if (gameState.limitedRangeEnabled && distance > 4) return false;
            if (gameState.lineOfSightEnabled && !hasLineOfSight(fromRow, fromCol, toRow, toCol, gameState.board)) return false;
            return true;
        }
        return false;
    } else {
        const distance = Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol);
        return distance === 1;
    }
}

function hasLineOfSight(fromRow, fromCol, toRow, toCol, board) {
    if (fromRow === toRow) {
        const startCol = Math.min(fromCol, toCol);
        const endCol = Math.max(fromCol, toCol);
        for (let col = startCol + 1; col < endCol; col++) {
            if (board[fromRow][col]) return false;
        }
    } else if (fromCol === toCol) {
        const startRow = Math.min(fromRow, toRow);
        const endRow = Math.max(fromRow, toRow);
        for (let row = startRow + 1; row < endRow; row++) {
            if (board[row][fromCol]) return false;
        }
    }
    return true;
}

function movePiece(gameRoom, fromRow, fromCol, toRow, toCol) {
    const gameState = gameRoom.gameState;
    const piece = gameState.board[fromRow][fromCol];

    if (piece.type === 'Cavalry') {
        const distance = Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol);
        if (distance === 2) {
            piece.chargeDirection = {
                row: toRow - fromRow,
                col: toCol - fromCol
            };
            if (piece.chargeDirection.row !== 0) {
                piece.chargeDirection.row = piece.chargeDirection.row > 0 ? 1 : -1;
            }
            if (piece.chargeDirection.col !== 0) {
                piece.chargeDirection.col = piece.chargeDirection.col > 0 ? 1 : -1;
            }
        } else {
            piece.chargeDirection = null;
        }
    }

    gameState.board[toRow][toCol] = piece;
    gameState.board[fromRow][fromCol] = null;

    checkForHealing(gameRoom, piece, toRow);
}

function checkForHealing(gameRoom, piece, row) {
    const healingRows = gameRoom.getHealingRows();
    const shouldHeal = (piece.player === 1 && row === healingRows.player1) || 
                      (piece.player === 2 && row === healingRows.player2);
                      
    if (shouldHeal && !piece.hasBeenReplenished) {
        piece.health = piece.maxHealth;
        piece.hasBeenReplenished = true;
        if (piece.type === 'Archer') {
            piece.ammo = 3;
        }
        const playerName = gameRoom.getPlayerName(piece.player);
        gameRoom.broadcastMessage(`${playerName}'s ${piece.type} has been replenished!`, 'success');
    }
}

function attackPiece(gameRoom, attackerRow, attackerCol, targetRow, targetCol) {
    const gameState = gameRoom.gameState;
    if (gameState.gameEnded) return;

    const attacker = gameState.board[attackerRow][attackerCol];
    const target = gameState.board[targetRow][targetCol];
    if (!target) return;

    let damage = 1;
    const distance = Math.abs(attackerRow - targetRow) + Math.abs(attackerCol - targetCol);

    // Cavalry charge bonus
    if (attacker.type === 'Cavalry' && attacker.chargeDirection && distance === 1 && target.type !== 'Heavy Infantry') {
        const attackDirection = {
            row: targetRow - attackerRow,
            col: targetCol - attackerCol
        };

        if (attackDirection.row === attacker.chargeDirection.row && 
            attackDirection.col === attacker.chargeDirection.col) {
            damage = 2;
            gameRoom.broadcastMessage('Cavalry charge! Double damage!', 'success');
        }
    }

    if (attacker.type === 'Archer' && distance > 1) {
        attacker.ammo--;
    }

    const wasGeneral = target.type === 'General';
    target.health -= damage;

    if (target.health <= 0) {
        gameState.board[targetRow][targetCol] = null;
        if (wasGeneral) {
            gameState.gameEnded = true;
            gameState.winner = attacker.player;
            const winnerName = gameRoom.getPlayerName(attacker.player);
            gameRoom.broadcastMessage(`${winnerName} wins! Enemy General defeated!`, 'victory');
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Game available at: http://localhost:${PORT}`);
});
