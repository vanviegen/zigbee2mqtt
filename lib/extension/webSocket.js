const settings = require('../util/settings');
const logger = require('../util/logger');
const Extension = require('./extension');
const ws = require('ws');
const BridgeLegacy = require('./legacy/bridgeLegacy');


/**
* This extension creates a network map
*/
class WebSocket extends Extension {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus) {
        super(zigbee, mqtt, state, publishEntityState, eventBus);

        this.port = settings.get().advanced.websocket_port;

        this.clients = new Set();

        this.eventBus.on('deviceRenamed', this.onDeviceRenamed.bind(this));
        this.eventBus.on('deviceRemoved', this.onDeviceRemoved.bind(this));

        this.eventBus.on('groupAdded', this.onGroupModified.bind(this));
        this.eventBus.on('groupRenamed', this.onGroupModified.bind(this));
        this.eventBus.on('groupDeviceAdded', this.onGroupModified.bind(this));
        this.eventBus.on('groupDeviceRemoved', this.onGroupModified.bind(this));

        this.eventBus.on('groupRemoved', this.onGroupRemoved.bind(this));

        this.eventBus.on('publishEntityState', this.onPublishEntityState.bind(this));
        this.eventBus.on('stateChange', this.onStateChange.bind(this));

        // In the same spirit, we're creating our own instance of BridgeLegacy.
        this.bridgeLegacy = new BridgeLegacy(zigbee, mqtt, state, publishEntityState, eventBus);
    }

    onDeviceRenamed({device}) {
        logger.warn('xxx dev ren');
        const resolvedEntity = this.zigbee.resolveEntity(device);
        this.broadcast('set', ['devices', device.ieeeAddr, 'name'], resolvedEntity.name);
    }

    onDeviceRemoved({device}) {
        logger.warn('xxx dev rem');
        this.broadcast('set', ['devices', device.ieeeAddr], undefined);
    }

    onGroupModified({group}) {
        logger.warn('xxx group modified');
        this.broadcast('set', ['groups', group.groupID], this.getGroupInfo(group));
    }

    onGroupRemoved({group}) {
        logger.warn('xxx group ren');
        this.broadcast('set', ['groups', group.groupID], undefined);
    }

    onStateChange({ID, from, to, reason}) {
        logger.warn('xxx stat change', ID, from, to);
        this.broadcast('set', ['devices', ID, 'state'], to);
    }

    onPublishEntityState(arg) {
        logger.warn('xxx pub entity state', arg);
    }

    broadcast(...args) {
        const json = JSON.stringify(args);
        this.clients.forEach((client) => {
            client.send(json);
        });
    }

    onZigbeeStarted() {
        this.wss = new ws.Server({port: this.port});
        this.wss.on('connection', (client) => {
            client.on('message', (json) => {
                let path;
                let argObj;
                try {
                    [path, argObj] = JSON.parse(json);
                } catch (e) {
                    /* Nothing */
                }
                if (typeof path !== 'string') {
                    logger.error(`Invalid WebSocket request: ${json}`)
                    return;
                }

                // TODO: add a way to send the return value back to the originator. One way would
                // be to have the request contain an optional third argument, which is used as an
                // identifier for the reply.
                this.commands.call(path, argObj);
            });

            client.on('close', () => {
                this.clients.delete(this);
            });

            this.clients.add(client);
            client.send(JSON.stringify(['set', [], this.getAllInfo()]));
        });
        logger.info(`WebSocket listening on port ${this.port}`);
    }

    getDeviceInfo(device) {
        const resolvedEntity = this.zigbee.resolveEntity(device);

        const supports = {};
        let modelParts;

        if (resolvedEntity.definition) {
            for (const converter of resolvedEntity.definition.toZigbee) {
                for (const key of converter.key) {
                    supports[key] = true;
                }
            }
            modelParts = [resolvedEntity.definition.vendor, resolvedEntity.definition.description];
        } else {
            modelParts = ['[Unsupported]', device.manufacturerName, device.modelID];
        }

        const state = this.state.get(device.ieeeAddr) || {};

        return {
            supports,
            state,
            name: resolvedEntity.name,
            model: modelParts.filter((s) => s).join(' '),
            powerSource: device.powerSource,
        };
    }

    getGroupInfo(group) {
        const resolvedEntity = this.zigbee.resolveEntity(group.groupID);
        return {
            name: resolvedEntity.name,
            members: resolvedEntity.settings.devices,
        };
    }

    getAllInfo() {
        const result = {
            devices: {},
            groups: {},
        };
        for (const device of this.zigbee.getDevices()) {
            if (device.type !== 'Coordinator') {
                result.devices[device.ieeeAddr] = this.getDeviceInfo(device);
            }
        }
        for (const group of this.zigbee.getGroups()) {
            result.groups[group.groupID] = this.getGroupInfo(group);
        }
        return result;
    }

    stop() {
        if (this.wss) {
            this.wss.close();
            delete this.wss;
        }
    }
}

module.exports = WebSocket;
