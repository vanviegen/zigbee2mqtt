const settings = require('../util/settings');
const logger = require('../util/logger');
const Extension = require('./extension');
const ws = require('ws');

class WebSocket extends Extension {
    constructor(...args) {
        super(...args);

        this.port = settings.get().websocket.port;
        this.clients = new Set();
        this.eventBus.on('pathChange', this.onPathChange.bind(this));
    }

    onPathChange({command, path, data}) {
        const json = JSON.stringify({command, path, data});
        this.clients.forEach((client) => {
            client.send(json);
        });
    }

    onZigbeeStarted() {
        this.server = new ws.Server({port: this.port});
        this.server.on('connection', (client) => {
            client.on('message', async (json) => {
                let request;
                try {
                    request = JSON.parse(json);
                } catch (e) {
                    return this.api.logError('command_failed', `Failed to parse WebSocket json: ${json}`);
                }

                const response = await this.api.call(request);
                if (request.requestId != null) {
                    response.requestId = request.requestId;
                    client.send(JSON.stringify(response));
                }
            });

            client.on('close', () => {
                this.clients.delete(this);
            });

            this.clients.add(client);
            client.send(JSON.stringify({command: 'set', path: [], data: this.api.getTree()}));
        });
        logger.info(`WebSocket listening on port ${this.port}`);
    }

    stop() {
        if (this.server) {
            this.server.close();
            delete this.server;
        }
    }
}

module.exports = WebSocket;
