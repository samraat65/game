/*
=============================================================================
ANCIENT EMPIRES - MULTIPLAYER SERVER
=============================================================================

DEPLOYMENT INSTRUCTIONS:
1. Create a new folder for your game
2. Save this file as 'server.js'
3. Save the Ancient Empires HTML file as 'public/index.html'
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

// Nation definitions
const nations = {
    english: {
        name: 'English',
        pieces: { 'General': 1, 'Cavalry': 2, 'Heavy Infantry': 2, 'Light Infantry': 2, 'Archer': 1 },
        abilities: {
            archerRangeBonus: 1,
            archerKillAmmoSave: true
        }
    },
    mongols: {
        name: 'Mongols',
        pieces: { 'General': 1, 'Cavalry': 1, 'Horse Archer': 2, 'Heavy Infantry': 2, 'Light Infantry': 2, 'Archer': 0 },
        abilities: {
            horseArcherMobility: true,
            horseArcherAmmo: 2
        }
    },
    macedonians: {
        name: 'Macedonians',
        pieces: { 'General': 1, 'Cavalry': 2, 'Heavy Infantry': 2, 'Light Infantry': 2, 'Archer': 1 },
        abilities: {
            alexanderCavalryMovement: true
        }
    },
    spartans: {
        name: 'Spartans',
        pieces: { 'General': 1, 'Cavalry': 2, 'Heavy Infantry': 2, 'Light Infantry': 2, 'Archer': 0 },
        abilities: {
            heavyInfantryDiagonalMove: true,
            heavyInfantryCleave: true
        }
    }
};

const pieceTypes = {
    'General': { symbol: '👑', health: 3 },
    'Cavalry': { symbol: '🐎', health: 2 },
    'Horse Archer': { symbol: '🐎🏹', health: 2, ammo: 2 },
    'Heavy Infantry': { symbol: '🛡️', health: 3 },
    'Light Infantry': { symbol: '⚔️', health: 2 },
    'Archer': { symbol: '🏹', health: 2, ammo: 3 }
};

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = new Map(); // playerId -> {socket, playerNumber, name, nation}
        this.gameState = this.initializeGameState();
        this.spectators = new Set();
    }

    initializeGameState() {
        return {
            currentPlayer: 1,
            gamePhase: 'waiting', // 'waiting', 'nation-selection', 'placement', 'battle'
            placementTurn: 1,
            piecesPlacedThisTurn: 0,
            hasMoved: false,
            hasAttacked: false,
            gameEnded: false,
            winner: null,
            
            // 7x7 board for Ancient Empires
            board: Array(7).fill(null).map(() => Array(7).fill(null)),
            
            // Player nations and pieces
            player1Nation: null,
            player2Nation: null,
            player1Pieces: {},
            player2Pieces: {},
            
            // Selection state
            selectedPiece: null,
            selectedCell: null,
            selectedPieceType: null
        };
    }

    addPlayer(socket, playerName) {
        if (this.players.size >= 2) {
            // Add as spectator
            this.spectators.add(socket.id);
            socket.emit('joinedAsSpectator');
            this.broadcastGameState();
            return false;
        }

        const playerNumber = this.players.size + 1;
        this.players.set(socket.id, {
            socket: socket,
            playerNumber: playerNumber,
            name: playerName,
            nation: null
        });

        socket.emit('playerAssigned', { 
            playerNumber: playerNumber,
            playerName: playerName 
        });

        // Start nation selection if we have 2 players
        if (this.players.size === 2) {
            this.gameState.gamePhase = 'nation-selection';
            this.broadcastMessage(`Game ready! Players select your nations.`);
        }

        this.broadcastGameState();
        this.broadcastPlayerList();
        return true;
    }

    selectNation(socketId, nationKey) {
        const player = this.players.get(socketId);
        if (!player) return false;

        // Check if nation is already taken
        for (const p of this.players.values()) {
            if (p.nation === nationKey && p.socket.id !== socketId) {
                return false; // Nation already taken
            }
        }

        // Set player nation
        player.nation = nationKey;
        
        if (player.playerNumber === 1) {
            this.gameState.player1Nation = nationKey;
            this.gameState.player1Pieces = {...nations[nationKey].pieces};
        } else {
            this.gameState.player2Nation = nationKey;
            this.gameState.player2Pieces = {...nations[nationKey].pieces};
        }

        // Check if both players have selected nations
        const allSelected = Array.from(this.players.values()).every(p => p.nation !== null);
        if (allSelected) {
            this.gameState.gamePhase = 'placement';
            this.broadcastMessage(`Nations selected! ${this.getPlayerName(1)} goes first with placement.`);
        }

        this.broadcastGameState();
        return true;
    }

    removePlayer(socketId) {
        if (this.players.has(socketId)) {
            const player = this.players.get(socketId);
            this.players.delete(socketId);
            
            if (this.players.size === 0) {
                return true; // Room is empty
            }
            
            // Reset game if a player leaves
            this.gameState = this.initializeGameState();
            this.broadcastMessage(`${player.name} left. Game reset.`);
            
            // Reassign remaining player as player 1
            if (this.players.size === 1) {
                const remainingPlayer = Array.from(this.players.values())[0];
                remainingPlayer.playerNumber = 1;
                remainingPlayer.nation = null;
                remainingPlayer.socket.emit('playerAssigned', { 
                    playerNumber: 1,
                    playerName: remainingPlayer.name 
                });
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
            },
            nations: nations
        };
        
        this.broadcast('gameStateUpdate', stateData);
    }

    broadcastPlayerList() {
        const playerList = Array.from(this.players.values()).map(p => ({
            name: p.name,
            playerNumber: p.playerNumber,
            nation: p.nation
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
}

// Socket connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinRoom', (data) => {
        const { roomId, playerName } = data;
        
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
            gameRooms.set(roomId, new GameRoom(roomId));
        }

        const gameRoom = gameRooms.get(roomId);
        gameRoom.addPlayer(socket, playerName);

        console.log(`${playerName} joined room ${roomId}`);
    });

    // Nation selection
    socket.on('selectNation', (data) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) return;

        const gameRoom = gameRooms.get(roomId);
        if (!gameRoom) return;

        const success = gameRoom.selectNation(socket.id, data.nationKey);
        if (!success) {
            socket.emit('error', 'Nation already selected or invalid');
        }
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
            case 'selectPieceType':
                handleSelectPieceType(gameRoom, player, data);
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
function handleSelectPieceType(gameRoom, player, data) {
    const { pieceType } = data;
    const gameState = gameRoom.gameState;

    if (gameState.gamePhase !== 'placement' || !gameRoom.isPlayerTurn(player.socket.id)) {
        return;
    }

    gameState.selectedPieceType = pieceType;
    gameRoom.broadcastGameState();
}

function handlePlacePiece(gameRoom, player, data) {
    const { row, col } = data;
    const gameState = gameRoom.gameState;

    // Validate it's player's turn and placement phase
    if (!gameRoom.isPlayerTurn(player.socket.id) || gameState.gamePhase !== 'placement') {
        return;
    }

    if (!gameState.selectedPieceType) {
        gameRoom.broadcastMessage('Select a piece type first!', 'error');
        return;
    }

    const requiredPieces = gameState.placementTurn === 1 ? 4 : 
        (Object.values(player.playerNumber === 1 ? gameState.player1Pieces : gameState.player2Pieces).reduce((a,b) => a+b, 0));

    // Validate placement rules
    if (gameState.piecesPlacedThisTurn >= requiredPieces) {
        gameRoom.broadcastMessage(`You can only place ${requiredPieces} pieces this turn!`, 'error');
        return;
    }

    if (gameState.board[row][col]) {
        gameRoom.broadcastMessage('Cell is already occupied!', 'error');
        return;
    }

    // Check placement zone (top 3 rows for player 1, bottom 3 rows for player 2)
    const validRows = player.playerNumber === 1 ? [0, 1, 2] : [4, 5, 6];
    if (!validRows.includes(row)) {
        gameRoom.broadcastMessage(`Player ${player.playerNumber} can only place pieces in their deployment zone!`, 'error');
        return;
    }

    const pieces = player.playerNumber === 1 ? gameState.player1Pieces : gameState.player2Pieces;
    if (pieces[gameState.selectedPieceType] === 0) {
        gameRoom.broadcastMessage('No more pieces of this type available!', 'error');
        return;
    }

    // Create piece with nation-specific properties
    const pieceData = createPieceData(gameState.selectedPieceType, player.playerNumber, player.nation, gameState.placementTurn);

    gameState.board[row][col] = pieceData;
    pieces[gameState.selectedPieceType]--;
    gameState.piecesPlacedThisTurn++;
    gameState.selectedPieceType = null;

    gameRoom.broadcastGameState();
}

function createPieceData(pieceType, player, nation, placementTurn) {
    const pieceData = {
        type: pieceType,
        player: player,
        health: pieceTypes[pieceType].health,
        maxHealth: pieceTypes[pieceType].health,
        hasBeenReplenished: false,
        placedInTurn: placementTurn,
        nation: nation
    };

    // Add ammo for archers or horse archers
    if (pieceType === 'Archer') {
        pieceData.ammo = pieceTypes[pieceType].ammo;
    } else if (pieceType === 'Horse Archer') {
        pieceData.ammo = pieceTypes[pieceType].ammo;
    }

    return pieceData;
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

        if (!targetPiece && canMove(selectedPiece, gameState.selectedCell.row, gameState.selectedCell.col, row, col)) {
            // Move piece
            if (!gameState.hasAttacked && !gameState.hasMoved) {
                movePiece(gameRoom, gameState.selectedCell.row, gameState.selectedCell.col, row, col);
                gameState.hasMoved = true;
                gameRoom.broadcastMessage('Move completed!', 'success');
            } else {
                gameRoom.broadcastMessage('Invalid move timing!', 'error');
            }
        } else if (targetPiece && targetPiece.player !== selectedPiece.player && canAttack(selectedPiece, gameState.selectedCell.row, gameState.selectedCell.col, row, col, gameState)) {
            // Attack piece
            if (!gameState.hasAttacked) {
                attackPiece(gameRoom, gameState.selectedCell.row, gameState.selectedCell.col, row, col);
                gameState.hasAttacked = true;
                gameRoom.broadcastMessage('Attack completed!', 'success');
            } else {
                gameRoom.broadcastMessage('You can only attack once per turn!', 'error');
            }
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

    // Handle placement phase turn ending
    if (gameState.gamePhase === 'placement') {
        const requiredPieces = gameState.placementTurn === 1 ? 4 : 
            Object.values(player.playerNumber === 1 ? nations[gameState.player1Nation].pieces : nations[gameState.player2Nation].pieces).reduce((a,b) => a+b, 0) - 4;
        
        if (gameState.piecesPlacedThisTurn !== requiredPieces) {
            gameRoom.broadcastMessage(`You must place exactly ${requiredPieces} pieces before ending your turn!`, 'error');
            return;
        }
    }

    // Reset turn state
    gameState.selectedPiece = null;
    gameState.selectedCell = null;
    gameState.selectedPieceType = null;
    gameState.hasMoved = false;
    gameState.hasAttacked = false;

    // Clear cavalry charge directions
    for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 7; col++) {
            if (gameState.board[row][col] && 
                (gameState.board[row][col].type === 'Cavalry' || 
                 (gameState.board[row][col].type === 'General' && gameState.board[row][col].nation === 'macedonians'))) {
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
                gameRoom.broadcastMessage('Battle Phase begins!', 'info');
            }
        }
    } else {
        gameState.currentPlayer = gameState.currentPlayer === 1 ? 2 : 1;
    }

    gameRoom.broadcastGameState();
}

// Ancient Empires specific game logic
function canMove(piece, fromRow, fromCol, toRow, toCol) {
    // Check bounds
    if (toRow < 0 || toRow >= 7 || toCol < 0 || toCol >= 7) {
        return false;
    }

    // Macedonian General with cavalry movement
    if (piece.type === 'General' && piece.nation === 'macedonians') {
        const rowDiff = Math.abs(fromRow - toRow);
        const colDiff = Math.abs(fromCol - toCol);
        return (rowDiff <= 2 && colDiff === 0) || (rowDiff === 0 && colDiff <= 2);
    }

    // Cavalry and Horse Archer movement (2 spaces)
    if (piece.type === 'Cavalry' || piece.type === 'Horse Archer') {
        const rowDiff = Math.abs(fromRow - toRow);
        const colDiff = Math.abs(fromCol - toCol);
        return (rowDiff <= 2 && colDiff === 0) || (rowDiff === 0 && colDiff <= 2);
    }

    // Spartan Heavy Infantry with diagonal movement
    if (piece.type === 'Heavy Infantry' && piece.nation === 'spartans') {
        const rowDiff = Math.abs(fromRow - toRow);
        const colDiff = Math.abs(fromCol - toCol);
        return (rowDiff <= 1 && colDiff <= 1 && (rowDiff + colDiff > 0));
    }

    // Standard movement
    const distance = Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol);
    return distance === 1;
}

function canAttack(piece, fromRow, fromCol, toRow, toCol, gameState) {
    // Check bounds
    if (toRow < 0 || toRow >= 7 || toCol < 0 || toCol >= 7) {
        return false;
    }

    const target = gameState.board[toRow][toCol];
    if (!target || target.player === piece.player) return false;

    const distance = Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol);

    // Adjacent attacks for all pieces
    if (distance === 1) return true;

    // Ranged attacks for archers
    if (piece.type === 'Archer' && piece.ammo > 0) {
        const range = getArcherRange(piece);
        if ((fromRow === toRow || fromCol === toCol) && distance <= range) {
            return true;
        }
    }

    // Horse Archer ranged attacks
    if (piece.type === 'Horse Archer' && piece.ammo > 0) {
        if ((fromRow === toRow || fromCol === toCol) && distance <= 4) {
            return true;
        }
    }

    return false;
}

function getArcherRange(piece) {
    const nation = nations[piece.nation];
    let baseRange = 4;
    if (nation.abilities && nation.abilities.archerRangeBonus) {
        baseRange += nation.abilities.archerRangeBonus;
    }
    return baseRange;
}

function movePiece(gameRoom, fromRow, fromCol, toRow, toCol) {
    const gameState = gameRoom.gameState;
    const piece = gameState.board[fromRow][fromCol];

    // Set charge direction for cavalry and Macedonian generals
    if (piece.type === 'Cavalry' || (piece.type === 'General' && piece.nation === 'macedonians')) {
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

    // Check for healing at enemy back rows
    checkForHealing(gameRoom, piece, toRow);
}

function checkForHealing(gameRoom, piece, row) {
    const shouldHeal = (piece.player === 1 && row === 6) || (piece.player === 2 && row === 0);
    
    if (shouldHeal && !piece.hasBeenReplenished && piece.type !== 'General') {
        piece.health = piece.maxHealth;
        piece.hasBeenReplenished = true;
        if (piece.type === 'Archer' || piece.type === 'Horse Archer') {
            piece.ammo = pieceTypes[piece.type].ammo;
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

    // Cavalry and Macedonian General charge bonus
    if ((attacker.type === 'Cavalry' || (attacker.type === 'General' && attacker.nation === 'macedonians')) && 
        attacker.chargeDirection && distance === 1 && target.type !== 'Heavy Infantry') {
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

    // Handle ammunition consumption (with English special ability)
    if (shouldConsumeAmmo(attacker, target, distance)) {
        attacker.ammo--;
    }

    const wasGeneral = target.type === 'General';
    target.health -= damage;

    // Spartan Heavy Infantry cleave attack
    if (attacker.type === 'Heavy Infantry' && attacker.nation === 'spartans') {
        handleSpartanCleave(gameRoom, attackerRow, attackerCol, targetRow, targetCol);
    }

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

function shouldConsumeAmmo(attacker, target, distance) {
    // English archers don't consume ammo on kills
    if (attacker.type === 'Archer' && attacker.nation === 'english') {
        const nation = nations[attacker.nation];
        if (nation.abilities.archerKillAmmoSave && target.health <= 1) {
            return false; // Don't consume ammo on kill shots
        }
    }
    return distance > 1; // Only consume ammo for ranged attacks
}

function handleSpartanCleave(gameRoom, attackerRow, attackerCol, targetRow, targetCol) {
    const gameState = gameRoom.gameState;
    const attacker = gameState.board[attackerRow][attackerCol];
    const directions = [[-1,0], [1,0], [0,-1], [0,1]]; // orthogonal only
    
    let cleaveCount = 0;
    for (const [dr, dc] of directions) {
        const cleaveRow = attackerRow + dr;
        const cleaveCol = attackerCol + dc;
        
        if (cleaveRow >= 0 && cleaveRow < 7 && cleaveCol >= 0 && cleaveCol < 7) {
            const cleaveTarget = gameState.board[cleaveRow][cleaveCol];
            // Don't hit the original target again, and only hit enemies
            if (cleaveTarget && cleaveTarget.player !== attacker.player && 
                !(cleaveRow === targetRow && cleaveCol === targetCol)) {
                
                cleaveTarget.health -= 1;
                cleaveCount++;
                
                if (cleaveTarget.health <= 0) {
                    gameState.board[cleaveRow][cleaveCol] = null;
                    
                    if (cleaveTarget.type === 'General') {
                        gameState.gameEnded = true;
                        gameState.winner = attacker.player;
                        const winnerName = gameRoom.getPlayerName(attacker.player);
                        gameRoom.broadcastMessage(`${winnerName} wins! Enemy General defeated by cleave attack!`, 'victory');
                        return;
                    }
                }
            }
        }
    }
    
    if (cleaveCount > 0) {
        gameRoom.broadcastMessage(`Spartan Heavy Infantry cleaves ${cleaveCount} additional enemies!`, 'success');
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🏛️  Ancient Empires multiplayer server running on port ${PORT}`);
    console.log(`🌐 Game available at: http://localhost:${PORT}`);
    console.log(`👥 Players can join the same room to play together!`);
});