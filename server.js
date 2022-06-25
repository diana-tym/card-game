import * as myGame from './public/game.js';
import { readFile } from 'fs';
import { createServer } from 'http';
import { server as Websocket } from 'websocket';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const baseDir = __dirname + '/public';
const port = 8000;
const NOT_FOUND_CODE = 400;
const OK_CODE = 200;

const maxPlayers = 4;
const minPlayers = 2;
const maxRooms = 5;
const waitingTime = 5;

const clients = {};
const rooms = {};

const mimeTypes = {
    'html': 'text/html',
    'jgp': 'image/jpeg',
    'css': 'text/css',
    'js': 'text/javascript',
    'png': 'image/png',
    'svg': 'image/svg+xml',
};

const httpServer = createServer((req, res) => {
    let path = req.url;
    if (path === '/') path = '/index.html';
    const contentType = getContentType(path);
    const absPath = baseDir + path;

    readFile(absPath, (err, data) => {
        if (err) {
            res.writeHead(NOT_FOUND_CODE);
            res.end();
        } else {
            res.writeHead(OK_CODE, { 'Content-Type': contentType });
            res.end(data);
        }
    })
});

httpServer.listen(port, () => console.log('Listening port 8000...'));

const socket = new Websocket({ 
    'httpServer': httpServer,
    autoAcceptConnections: false
});

// server events

socket.on('request', req => {
    const connection = req.accept(null, req.origin);
    
    const clientId = generateId();
    clients[clientId] = { connection };

    const payLoad = {
        event: 'connect',
        clientId: clientId
    }
    connection.send(JSON.stringify(payLoad));

    connection.on('open', () => console.log('Openned!'));
    
    connection.on('close', function() {
        const roomId = clients[clientId].roomId;
        const room = rooms[roomId];
        const playerName = clients[clientId].playerName;
        delete clients[clientId];
        if (typeof roomId !== 'undefined') {
            const players = room.players;
            room.players = players.filter(id => id !== clientId);
            sendAll(room, { event: 'disconnect', msg: `${playerName} has left the room!` });
            if (room.players.length === 0) {
                delete rooms[roomId];
            }
        }
    });

    connection.on('message', message => {
        const data = JSON.parse(message.utf8Data);
        const handler = handlers[data.event];
        handler(data);
    })

});

const startGame = (room) => {
    if (room.players.length < minPlayers) {
        console.log('less than 2 players');
        return;
    }

    const deck = myGame.createDeck();
    room.deck = myGame.shuffleDeck(deck);
    console.log(`deck: ${room.deck}`);

    for (const clientId of room.players) {
        const player = clients[clientId];
        player.cardsOnHand = myGame.dealCards(room.deck);
    }
    //myGame.dealCards(room.players, clients, room.deck);

    const trumpCard = room.deck.pop();
    room.trumpCard = trumpCard
    room.trumpSuit = myGame.getSuit(trumpCard);
    room.deck.unshift(trumpCard);

    room.inPlay = Array.from(room.players);
    room.turn = room.inPlay[0];
    room.scoresInPlay = [];

    room.getNextTurn = function() {
        let idx = this.inPlay.indexOf(this.turn) + 1;
        if (idx > this.inPlay.length - 1) {
            idx = 0;
        }
        return this.inPlay[idx];
    }

    const payLoad = {
        event: 'startGame',
        turn: room.turn,
        trumpSuit: room.trumpSuit,
        trumpCard: room.trumpCard,
    }

    for (const clientId of room.players) {
        const client = clients[clientId].connection;
        payLoad.cardsOnHand = clients[clientId].cardsOnHand;
        client.send(JSON.stringify(payLoad));
    }
}

// handlers

const createRoom = (data) => {
    const clientId = data.clientId;
    clients[clientId].playerName = data.playerName;
    const client = clients[clientId].connection;
    let payLoad = null;

    if (Object.keys(rooms).length >= maxRooms) {
        payLoad = {
            event: 'error',
            msg: 'Max number of rooms is reached!'
        };         
    } else {
        const roomId = generateId();
        rooms[roomId] = { 
            players: [],
            waitingTime: waitingTime,
            countdown: 0 };

        payLoad = {
            event: 'roomCreated',
            room: { roomId, players: rooms[roomId].players }
        };
    }
    client.send(JSON.stringify(payLoad));
}

const joinRoom = (data) => {
    const clientId = data.clientId;
    const client = clients[clientId].connection;
    const room = rooms[data.roomId];
        
    if (typeof room === 'undefined') {
        const payLoad = {
            event: 'error',
            msg: 'Wrong room id!'
        };
        client.send(JSON.stringify(payLoad));
        return;
    
    } else if (room.players.length >= maxPlayers) {
        const payLoad = {
            event: 'error',
            msg: 'Max number of players is reached!'
        };
        client.send(JSON.stringify(payLoad));
        return;
 
    } else {
        if (room.waitingTime > 0) {
            clients[clientId].playerName = data.playerName;
            clients[clientId].roomId = data.roomId;
            room.players.push(clientId);
            const payLoad = {
                event: 'joinedRoom',
                clientId: clientId,
                roomId: data.roomId,
                msg: `${data.playerName} has joined the room!`
            };

            sendAll(room, payLoad);
        }
    }

    if (room.players.length >= minPlayers && room.waitingTime > 0) {
        room.waitingTime = waitingTime;
        clearInterval(room.countdown);

        room.countdown = setInterval(function() {
            startCountdown(room)
        }, 1000);
    }
}

const makeMove = (data) => {
    const room = rooms[data.roomId];
    const client = clients[data.clientId];
    const card = data.card;
    const cardsOnHand = client.cardsOnHand;

    if (data.moveType === 'firstMove') {
        const defender = room.getNextTurn();
        client.cardsOnHand = cardsOnHand.filter(item => item !== card);
        room.attackCard = card;
        room.scoresInPlay.push( myGame.getScore(card) );
        const payLoad = {
            event: 'moveMade',
            moveType: 'defendMove',
            turn: defender,
            card: card
        }
        sendAll(room, payLoad);
        return;

    } else if (data.moveType === 'defendMove') {
        const isAllowed = myGame.checkDefendMove(card, room.attackCard, room.trumpSuit);
        console.log(`isAllowed = ${isAllowed}`);

        if (isAllowed) {
            room.scoresInPlay.push( myGame.getScore(card) );
            const payLoad = {
                event: 'moveMade',
                moveType: 'notFirstMove',
                turn: room.turn,
                card: card
            }
            sendAll(room, payLoad);
        }
        return;
      
        
    } else {   // not first move
        return;
    }
}

const handlers = {'createRoom': createRoom, 'joinRoom': joinRoom, 'makeMove': makeMove};

// additional functions

const getContentType = (path) => {
    const fileExtension = path.split('.').pop();
    let contentType = null;
    for (const type in mimeTypes) {
        if (fileExtension === type) {
            contentType = mimeTypes[type];
        }
    }
    return contentType;
}

const generateId = () => Math.floor(Math.random() * 10000) + 1;

const sendAll = (room, payLoad) => {
    for (const clientId of room.players) {
        const client = clients[clientId].connection;
        console.dir(payLoad);
        client.send(JSON.stringify(payLoad));
    }
}

const startCountdown = (room) => {
    let waitingTime = room.waitingTime--;
    const payLoad = { event: 'countdown', waitingTime };
    sendAll(room, payLoad);

    if (waitingTime <= 0) {
        clearInterval(room.countdown);
        console.log('start game');
        startGame(room);
    }
}


