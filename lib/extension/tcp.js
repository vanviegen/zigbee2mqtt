const settings = require('../util/settings');
const logger = require('../util/logger');
const Extension = require('./extension');
const net = require('net');
const readline = require('readline');

class TCP extends Extension {
    constructor(...args) {
        super(...args);

        this.port = settings.get().tcp.port;
        this.clients = new Set();
        this.eventBus.on('pathChange', this.onPathChange.bind(this));
    }

    onPathChange({command, path, data}) {
        const text = JSON.stringify({command, path, data})+'\n';
        this.clients.forEach((client) => {
            client.write(text);
        });
    }

    onZigbeeStarted() {
        this.server = new net.Server();
        this.server.on('connection', (client) => {
            readline.createInterface({input: client}).on('line', async (json) => {
                if (!json.trim().length) return;
                let request;
                try {
                    request = JSON.parse(json);
                } catch (e) {
                    return this.api.logError('command_failed', `Failed to parse TCP json: ${json}`);
                }

                const response = await this.api.call(request);
                if (request.requestId != null) {
                    response.requestId = request.requestId;
                    client.write(JSON.stringify(response)+'\n');
                }
            });

            client.on('close', () => {
                this.clients.delete(this);
            });

            this.clients.add(client);
            client.write(JSON.stringify({command: 'set', path: [], data: this.api.getTree()})+'\n');
        });
        this.server.listen(this.port, () => {
            logger.info(`TCP server listening on port ${this.port}`);
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            delete this.server;
        }
    }
}

module.exports = TCP;
