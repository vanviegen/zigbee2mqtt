const assert = require('assert');
const settings = require('../util/settings');
const Extension = require('./extension');
const logger = require('../util/logger');
const {SubTree} = require('../util/utils');

class NewMQTT extends Extension {
    onMQTTConnected() {
        // Subscribe to requests
        this.baseTopic = settings.get().mqtt.new_api_base_topic;
        this.requestTopic = this.baseTopic + '/request';
        this.requestPrefix = this.requestTopic + '/';
        this.responseTopic = this.baseTopic + '/response';
        this.mqtt.subscribe(this.requestTopic + '/#');

        this.eventBus.on('pathChange', this.onPathChange.bind(this));

        const result = {};
        this.setInitial([], this.api.getTree(), result);
        for (const [path, json] of Object.entries(result)) {
            this.mqtt.publish(path, json, {retain: true}, this.baseTopic);
        }
        // TODO: delete stale retained topics within our baseTopic
    }

    setInitial(path, obj, result) {
        for (const [key, val] of Object.entries(obj)) {
            if (val && typeof val === 'object' && !(val instanceof Array)) {
                const subPath = path.concat([key]);
                this.setInitial(subPath, val, result);
                if (val instanceof SubTree) {
                    delete obj[key];
                    result[subPath.join('/')] = JSON.stringify(val);
                }
            }
        }
    }

    onPathChange({command, path, data}) {
        assert(command === 'set' || command === 'publish' || command === 'delete');
        const json = command === 'delete' ? '' : JSON.stringify(data);
        const retain = command !== 'publish';
        this.mqtt.publish(path.join('/'), json, {retain}, this.baseTopic);
    }

    async onMQTTMessage(topic, json) {
        assert(topic.startsWith(this.requestPrefix));
        const requestId = topic.substr(this.requestPrefix.length);

        let request;
        try {
            request = JSON.parse(json);
        } catch (e) {
            return this.api.logError('command_failed', `Failed to parse WebSocket json: ${json}`);
        }

        const response = await this.api.call(request);
        delete response.command;
        this.mqtt.publish(requestId, JSON.stringify(response), {}, this.responseTopic);
    }
}

module.exports = NewMQTT;
