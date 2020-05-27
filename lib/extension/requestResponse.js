const assert = require('assert');
const settings = require('../util/settings');
const logger = require('../util/logger');
const utils = require('../util/utils');
const Extension = require('./extension');

const topicRegex = new RegExp(`^(.+?)(?:/(${utils.getEndpointNames().join('|')}))?/(get|set)(?:/(.+))?`);


class RequestResponse extends Extension {
    onMQTTConnected() {
        // Subscribe to requests
        const baseTopic = settings.get().mqtt.base_topic;
        this.requestRoot = `${baseTopic}/bridge/request/`;
        this.mqtt.subscribe(`${this.requestRoot}#`);
    }

    onMQTTMessage(topic, message) {
        assert(topic.startsWith(this.requestRoot));

        const command = topic.substr(this.requestRoot.length);

        let data;
        try {
            data = JSON.parse(message);
            if (!data || typeof data !== 'object')) throw new Error(`Object expected`);
        } catch(e) {
            logger.error(`Failed to parse request data (${e}): ${message}`)
        }

        let requestID = data.requestID;
        delete data.requestID;

        let resultObj = this.commands.call(command, data)

        if (requestID != null) resultObj.requestID = requestID;

        this.mqtt.publish('bridge/response/'+command, JSON.stringify(resultObj));
    }
}

module.exports = RequestResponse;
