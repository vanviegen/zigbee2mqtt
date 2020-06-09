const assert = require('assert');
const settings = require('../util/settings');
const logger = require('../util/logger');
const utils = require('../util/utils');
const Extension = require('./extension');

const topicRegex = new RegExp(`^(.+?)(?:/(${utils.getEndpointNames().join('|')}))?/(get|set)(?:/(.+))?`);


class EntityPublish extends Extension {
    onMQTTConnected() {
        // Subscribe to topics.
        const baseTopic = settings.get().mqtt.base_topic;
        for (let step = 1; step < 20; step++) {
            const topic = `${baseTopic}/${'+/'.repeat(step)}`;
            this.mqtt.subscribe(`${topic}set`);
            this.mqtt.subscribe(`${topic}set/+`);
            this.mqtt.subscribe(`${topic}get`);
            this.mqtt.subscribe(`${topic}get/+`);
        }
    }

    parseTopic(topic) {
        const match = topic.match(topicRegex);
        if (!match) {
            return null;
        }

        const ID = match[1].replace(`${settings.get().mqtt.base_topic}/`, '');
        // If we didn't replace base_topic we received something we don't care about
        if (ID === match[1] || ID.match(/bridge/)) {
            return null;
        }

        return {ID: ID, endpointName: match[2] || '', type: match[3], attribute: match[4]};
    }

    onMQTTMessage(topic, message) {
        topic = this.parseTopic(topic);
        if (!topic) {
            return false;
        }

        assert(topic.type === 'set' || topic.type === 'get');

        const entityKey = `${topic.ID}` + (topic.endpointName ? `/${topic.endpointName}` : '');
        const resolvedEntity = this.zigbee.resolveEntity(entityKey);

        if (!resolvedEntity) {
            /* istanbul ignore else */
            if (settings.get().advanced.legacy_api) {
                const message = {friendly_name: entityKey};
                this.mqtt.publish(
                    'bridge/log',
                    JSON.stringify({type: `entity_not_found`, message}),
                );
            }

            logger.error(`Entity '${entityKey}' is unknown`);
            return;
        }
        const id = resolvedEntity.settings.ID;

        // Convert the MQTT message to a Zigbee message.
        let payload = {};
        if (topic.hasOwnProperty('attribute') && topic.attribute) {
            payload[topic.attribute] = message;
        } else {
            try {
                payload = JSON.parse(message);
            } catch (e) {
                // Cannot be parsed to JSON, assume state message.
                payload = {state: message};
            }
        }

        /**
         * Home Assistant always publishes 'state', even when e.g. only setting
         * the color temperature. This would lead to 2 zigbee publishes, where the first one
         * (state) is probably unecessary.
         */
        const deviceState = this.state.get(id) || {};
        if (settings.get().homeassistant) {
            const hasColorTemp = payload.hasOwnProperty('color_temp');
            const hasColor = payload.hasOwnProperty('color');
            const hasBrightness = payload.hasOwnProperty('brightness');
            const isOn = deviceState && deviceState.state === 'ON' ? true : false;
            if (isOn && (hasColorTemp || hasColor) && !hasBrightness) {
                delete payload.state;
                logger.debug('Skipping state because of Home Assistant');
            }
        }

        if (topic.type==='set') {
            this.api.call({
                command: 'set',
                path: ['devices', id, 'state'],
                data: payload,
            });
        } else {
            this.api.call({
                command: 'set',
                path: ['devices', id],
                data: {force_update: true},
            });
        }
    }
}

module.exports = EntityPublish;
