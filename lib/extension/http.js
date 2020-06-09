const settings = require('../util/settings');
const logger = require('../util/logger');
const Extension = require('./extension');
const http = require('http');

class HTTP extends Extension {
    constructor(...args) {
        super(...args);
        this.port = settings.get().http.port;
    }

    onZigbeeStarted() {
        this.server = http.createServer(async (request, response) => {
            response.setHeader('Content-Type', 'application/json');

            const method = request.method.toLowerCase();
            const command = {put: 'set', post: 'create'}[method] || method;
            const path = request.url;

            let json = '';
            for await (const chunk of request) {
                json += chunk;
            }

            let data;
            try {
                data = JSON.parse(json || '{}');
            } catch (e) {
                const msg = `Failed to parse HTTP body json: ${json}`;
                response.statusCode = 400;
                response.end(JSON.stringify({error: msg}));
                this.api.logError('command_failed', msg);
                return;
            }

            const rsp = await this.api.call({command, path, data});
            if (rsp.error) {
                response.statusCode = 400;
                response.end(JSON.stringify({error: rsp.error}));
            } else {
                response.end(JSON.stringify(rsp.data || {}));
            }
        });
        this.server.listen(this.port, () => {
            logger.info(`HTTP server listening on port ${this.port}`);
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            delete this.server;
        }
    }
}

module.exports = HTTP;
