import { Server } from 'socket.io';
import { registerEvents } from './events/index.js';
import { authenticateSocket } from './middlewares/authenticate.socket.js';

let io = null;

export const initSocket = (server, corsConfig) => {
    io = new Server(server, {
        // Managed hosts may reject inbound WebSocket upgrades. Polling uses
        // the same authenticated Socket.IO events without changing trade rules.
        transports: process.env.SOCKET_TRANSPORTS === 'polling' ? ['polling'] : ['websocket', 'polling'],
        cors: corsConfig,
    });

    io.use(authenticateSocket);
    io.on('connection', (socket) => {
        // Handshake check
        const userId = socket.userId;
        if (userId) {
            socket.userId = userId;
            socket.join(`u:${userId}`);
        }

        console.log(`\n[Socket] Connected: ${socket.id}`);
        console.log(`[Socket] Total: ${io.engine.clientsCount}\n`);

        registerEvents(io, socket); // main entrance
    });

    return io;
};

export const getIO = () => {
    if (!io) {
        throw new Error('Socket.io not initialized!');
    }
    return io;
};
