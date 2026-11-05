import { brokerManager } from '../brokers/index.js';
import { registerAccountPageEvents } from './account.page.events.js';
import { registerSetupPageEvents } from './setup.page.events.js';

export const registerEvents = (io, socket) => {
    registerAccountPageEvents(io, socket);
    registerSetupPageEvents(io, socket);

    socket.on('disconnect', (reason) => {
        const id = socket.userId || 'Guest';

        console.log(`[Socket] User: ${id} disconnected. cleaning up streams...`);
        if (socket.userId) {
            brokerManager.stopAllStreams(socket.userId);
        }
        console.log(`-----------------------------\n`);
    });
};