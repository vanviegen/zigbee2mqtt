const logger = require('../util/logger');
const settings = require('../util/settings');
const {SubTree, setProperties} = require('../util/utils');
const Extension = require('./extension');

class DevicesAPI extends Extension {
    constructor(...args) {
        super(...args);
        this.api.delegates.devices = this;

        this.eventBus.on('deviceRenamed', this.onDeviceChange.bind(this));
        this.eventBus.on('deviceRemoved', this.onDeviceChange.bind(this));
        this.eventBus.on('publishEntityState', this.onPublishEntityState.bind(this));
        this.eventBus.on('stateChange', this.onStateChange.bind(this));
    }

    async onMQTTConnected() {
        // Request a state update for all powered devices
        for (const device of this.zigbee.getDevices()) {
            if (device.type !== 'Coordinator' && device.powerSource !== 'Battery') {
                const entity = this.zigbee.resolveEntity(device);
                await this.$setForceUpdate(entity, true);
            }
        }
    }

    getTree() {
        const result = {};
        for (const device of this.zigbee.getDevices()) {
            if (device.type !== 'Coordinator') {
                const entity = this.zigbee.resolveEntity(device);
                result[device.ieeeAddr] = new SubTree(this.getDeviceInfo(entity));
            }
        }
        return result;
    }

    getDeviceInfo(entity) {
        const modelParts = entity.definition ?
            [entity.definition.vendor, entity.definition.description] :
            ['[Unsupported]', entity.device.manufacturerName, entity.device.modelID];

        return {
            writable: this.getDeviceAttributes(entity),
            readable: this.getDeviceAttributes(entity, true),
            state: new SubTree(this.getDeviceState(entity)),
            name: entity.name,
            model: modelParts.filter((s) => s).join(' '),
            powerSource: entity.device.powerSource,
        };
    }

    getDeviceState(entity) {
        return this.state.get(entity.device.ieeeAddr) || {};
    }

    onDeviceChange({device}) {
        this.emitDevice(this.zigbee.resolveEntity(device));
    }

    onStateChange({ID, from, to, reason}) {
        this.emitDeviceState(this.zigbee.resolveEntity(ID));
    }

    onPublishEntityState({entity, originalPayload}) {
        // If the original payload contains action, button or click keys (or variant suffixed by something like _left),
        // and if the contents is not an empty string (those are sent by the homeassistent extension), it's an event!
        if (Object.keys(originalPayload).find((k) => k.match(/^(action|button|click)(_|$)/) && originalPayload[k]!=='')) {
            // It's an event!
            delete originalPayload.linkquality;
            this.eventBus.emit('pathChange', {
                command: 'publish',
                path: ['devices', entity.device.ieeeAddr, 'event'],
                data: originalPayload,
            });
        }
    }

    emitDevice(entity) {
        this.eventBus.emit('pathChange', {
            command: 'set',
            path: ['devices', entity.device.ieeeAddr],
            data: this.getDeviceInfo(entity),
        });
    }

    emitDeviceState(entity) {
        const state = this.state.get(entity.device.ieeeAddr) || {};
        state.last_seen = entity.device.lastSeen;

        this.eventBus.emit('pathChange', {
            command: 'set',
            path: ['devices', entity.device.ieeeAddr, 'state'],
            data: state,
        });
    }

    getDeviceAttributes(entity, onlyGettable) {
        let attributes = [];
        if (entity.definition) {
            for (const converter of entity.definition.toZigbee) {
                if (!onlyGettable || converter.convertGet) {
                    attributes = attributes.concat(converter.key);
                }
            }
        }
        return attributes;
    }

    call({command, path, data}) {
        if (!path.length) {
            if (command==='get') {
                return this.getTree();
            }
            throw new Error(`No such devices command`);
        }

        const ieee = path.shift();
        const entity = this.zigbee.resolveEntity(ieee);

        if (!entity || entity.type !== 'device') {
            throw new Error(`Device '${ieee}' does not exist`);
        }

        if (!path.length) {
            if (command==='set') {
                return setProperties(this, '$set_', [entity], data);
            }
            if (command==='delete') {
                return this.delete(entity, data.mode || 'remove');
            }
            if (command==='get') {
                return this.getDeviceInfo(entity);
            }
        }
        if (path.length===1 && path[0]==='state') {
            if (command==='set') {
                return this.$setState(entity, data);
            }
            if (command==='get') {
                return this.getDeviceState(entity);
            }
        }

        throw new Error(`No such devices command`);
    }

    $setState(entity, attributes) {
        this.api.getSetState('set', entity, attributes);
    }

    $setForceUpdate(entity, attributes) {
        if (attributes===false) return;

        if (!attributes || typeof attributes !== 'object') {
            // attributes===true? Update all attributes!
            attributes = this.getDeviceAttributes(entity, true);
        }

        if (attributes instanceof Array) {
            const obj = {};
            for (const attr of attributes) {
                obj[attr] = '';
            }
            attributes = obj;
        }

        this.api.getSetState('get', entity, attributes);
    }

    $setName(entity, newName) {
        const oldName = entity.name;
        settings.changeFriendlyName(entity.settings.ID, newName);
        logger.info(`Successfully renamed - ${oldName} to ${newName}`);

        entity = this.zigbee.resolveEntity(newName);

        this.eventBus.emit('deviceRenamed', {device: entity.device});
        this.mqtt.publish(
            'bridge/log',
            JSON.stringify({type: `device_renamed`, message: {from: oldName, to: newName}}),
        );
    }

    $setWhitelist(entity, value) {
        settings.whitelistDevice(entity.ID, !value);
        if (value) {
            logger.info(`Whitelisted '${entity.friendlyName}'`);
            this.mqtt.publish(
                'bridge/log',
                JSON.stringify({type: 'device_whitelisted', message: {friendly_name: entity.friendlyName}}),
            );
        }
    }

    async delete(entity, action) {
        const logType = {
            ban: 'device_banned',
            force_remove: 'device_force_removed',
            remove: 'device_removed',
        }[action];

        const cleanup = () => {
            // Fire event
            this.eventBus.emit('deviceRemoved', {device: entity.device});

            // Remove from configuration.yaml
            settings.removeDevice(entity.settings.ID);

            // Remove from state
            this.state.remove(entity.settings.ID);

            logger.info(`Successfully removed device ${entity.settings.friendlyName}`);
            this.mqtt.publish('bridge/log', JSON.stringify({type: logType, message: entity.settings.ID}));
        };

        try {
            logger.info(`Removing '${entity.settings.friendlyName}' (${action})`);
            if (action === 'force_remove') {
                await entity.device.removeFromDatabase();
            } else {
                await entity.device.removeFromNetwork();
            }

            cleanup();
        } catch (error) {
            throw new Error(`Device remove (${action}) failed: ${error} -- See https://www.zigbee2mqtt.io/information/mqtt_topics_and_message_structure.html#zigbee2mqttbridgeconfigremove for more info`);
        }

        if (action === 'ban') {
            settings.banDevice(entity.settings.ID);
        }
    }
}


module.exports = DevicesAPI;
