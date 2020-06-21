const assert = require('assert');
const logger = require('../util/logger');
const settings = require('../util/settings');
const {SubTree, setProperties} = require('../util/utils');
const Extension = require('./extension');

class GroupsAPI extends Extension {
    constructor(...args) {
        super(...args);
        this.api.delegates.groups = this;
    }

    getTree() {
        // TODO: group state (set, get, update)
        const result = {};
        for (const group of this.zigbee.getGroups()) {
            const entity = this.zigbee.resolveEntity(group.groupID);
            result[group.groupID] = new SubTree(this.getGroupInfo(entity));
        }
        return result;
    }

    getGroupInfo(entity) {
        return {
            name: entity.name,
            devices: this.getDevices(entity),
            scenes: entity.settings.scenes || {},
            // TODO: add some group state. The challenge is to come up with something that
            // makes sense, and to keep it up-to-date.
        };
    }

    getDevices(entity) {
        // Strip the endpoint id of the ieees:
        const devices = (entity.settings.devices || []).map((key) => key.split('/')[0]);
        // Remove duplicates:
        return [...new Set(devices)];
    }

    emitGroup(entity) {
        this.eventBus.emit('pathChange', {
            command: 'set',
            path: ['groups', entity.settings.ID],
            data: this.getGroupInfo(entity),
        });
    }

    emitScene(entity, sceneId) {
        this.eventBus.emit('pathChange', {
            command: 'set',
            path: ['groups', entity.settings.ID, 'scenes', sceneId],
            data: entity.settings.scenes[sceneId],
        });
    }

    async call({command, path, data}) {
        if (!path.length) {
            if (command==='create') {
                return this.create(data);
            }
            if (command==='get') {
                return this.getTree();
            }
            throw new Error(`No such groups command`);
        }

        const groupId = path.shift();
        const entity = this.zigbee.resolveEntity(groupId);

        if (!entity || entity.type !== 'group') {
            throw new Error(`Group '${groupId}' does not exist`);
        }

        if (!path.length) {
            if (command==='set') {
                return await setProperties(this, '$set_', [entity], data);
            }
            if (command==='delete') {
                return this.delete(entity);
            }
            if (command==='get') {
                return this.getGroupInfo(entity);
            }
        } else if (path.length===1 && path[0]==='state') {
            if (command==='set') {
                return this.$setState(entity, data);
            }
        } else if (path[0]==='scenes') {
            if (command==='create' && path.length===1) {
                return this.createScene(entity, data.name);
            }
            if (path.length===2) {
                return await setProperties(this, '$set_scene_', [entity, path[1]], data);
            }
        }


        throw new Error(`No such groups command`);
    }

    create(data) {
        let {name, id} = data;
        delete data.name;
        delete data.id;

        const settingsGroup = settings.addGroup(name, id);
        id = settingsGroup.ID;

        this.mqtt.publish('bridge/log', JSON.stringify({type: `group_added`, message: name}));
        logger.info(`Added group '${name}'`);

        const entity = this.zigbee.resolveEntity(id);
        this.emitGroup(entity);

        setProperties(this, '$set_', [entity], data);

        return {id};
    }

    delete(entity) {
        settings.removeGroup(entity.settings.ID);
        entity.group.removeFromDatabase();
        this.mqtt.publish('bridge/log', JSON.stringify({type: `group_removed`, message: entity.settings.ID}));
        logger.info(`Removed group '${entity.settings.ID}'`);

        this.eventBus.emit('pathChange', {
            command: 'delete',
            path: ['groups', entity.settings.ID],
        });
    }

    $setName(entity, newName) {
        const oldName = entity.name;
        settings.changeFriendlyName(entity.settings.ID, newName);
        logger.info(`Successfully renamed - ${oldName} to ${newName} `);

        this.mqtt.publish(
            'bridge/log',
            JSON.stringify({type: `group_renamed`, message: {from: oldName, to: newName}}),
        );

        this.emitGroup(entity);
    }

    $setState(entity, state) {
        if (state.scene) {
            this.recallScene(entity, state.scene);
            state = {...state};
            delete state.scene;
        }
        return this.api.getSetState('set', entity, state);
    }

    async $setDevices(groupEntity, deviceIds) {
        assert(deviceIds instanceof Array);
        const oldIds = groupEntity.settings.devices || [];

        const keys = new Set();

        for (const deviceId of deviceIds) {
            const deviceEntity = this.zigbee.resolveEntity(deviceId);
            if (!deviceEntity || deviceEntity.type !== 'device') {
                throw new Error(`Device '${deviceId}' does not exist`);
            }

            // We'll subscribe all endpoints for a device, except 'system'.
            let endpoints = {default: deviceEntity.endpoint.ID};
            if (deviceEntity.defition && deviceEntity.definition.endpoint) {
                endpoints = deviceEntity.definition.endpoint(deviceEntity.device);
            }

            for (const endpointName in endpoints) {
                if (endpointName === 'system') continue;
                const endpointId = endpoints[endpointName];
                const key = `${deviceEntity.device.ieeeAddr}/${endpointId}`;
                keys.add(key);

                if (oldIds.includes(key)) continue;

                deviceEntity.endpoint = deviceEntity.device.getEndpoint(endpointId);
                await this.addDevice(groupEntity, deviceEntity);
            }
        }

        for (const key of oldIds) {
            if (!keys.has(key)) {
                const deviceEntity = this.zigbee.resolveEntity(key);
                await this.removeDevice(groupEntity, deviceEntity);
            }
        }
    }

    async addDevice(groupEntity, deviceEntity) {
        logger.info(`Adding '${deviceEntity.name}' to '${groupEntity.name}'`);
        await deviceEntity.endpoint.addToGroup(groupEntity.group);

        const key = `${deviceEntity.device.ieeeAddr}/${deviceEntity.endpoint.ID}`;
        settings.addDeviceToGroup(groupEntity.settings.ID, [key]);

        /* istanbul ignore else */
        if (settings.get().advanced.legacy_api) {
            const payload = {friendly_name: deviceEntity.name, group: groupEntity.name};
            this.mqtt.publish(
                'bridge/log',
                JSON.stringify({type: `device_group_add`, message: payload}),
            );
        }

        this.emitGroup(groupEntity);
    }

    async removeDevice(groupEntity, deviceEntity, settingsOnly) {
        if (settingsOnly !== true) {
            logger.info(`Removing '${deviceEntity.name}' from '${groupEntity.name}'`);
            await deviceEntity.endpoint.removeFromGroup(groupEntity.group);
        }

        const key = `${deviceEntity.device.ieeeAddr}/${deviceEntity.endpoint.ID}`;
        settings.removeDeviceFromGroup(groupEntity.settings.ID, [key]);

        /* istanbul ignore else */
        if (settings.get().advanced.legacy_api) {
            const payload = {friendly_name: deviceEntity.name, group: groupEntity.name};
            this.mqtt.publish(
                'bridge/log',
                JSON.stringify({type: `device_group_remove`, message: payload}),
            );
        }

        this.emitGroup(groupEntity);
    }

    createScene(entity, name) {
        let newSceneId = 1;
        const scenes = entity.settings.scenes || {};
        for (const sceneId in scenes) {
            if (sceneId >= newSceneId) newSceneId = 1 + (0|sceneId);
        }

        settings.set(['groups', entity.settings.ID, 'scenes', newSceneId], {name: name || '#'+newSceneId});

        this.$setSceneStates(entity, newSceneId, 'current');
    }

    $setSceneName(entity, sceneId, name) {
        settings.set(['groups', entity.settings.ID, 'scenes', sceneId, 'name'], name);
        entity = this.zigbee.resolveEntity(entity.settings.ID);
        this.emitScene(entity, sceneId);
    }

    $setSceneStates(entity, sceneId, states) {
        const devices = this.getDevices(entity);
        if (states === 'current') {
            states = {};
            for (const ieee of devices) {
                const state = states[ieee] = this.state.get(ieee) || {};
                delete state.last_seen;
                delete state.update_available;
                delete state.linkquality;
            }
        } else if (typeof states !== 'object') {
            throw new Error(`'states' should be an object or the string "current"`);
        } else {
            for (const ieee in states) {
                if (!devices.includes(ieee)) {
                    throw new Error(`Trying to set scene state for device ${ieee} that is not part of the group`);
                }
            }
        }

        settings.set(['groups', entity.settings.ID, 'scenes', sceneId, 'states'], states);
        entity = this.zigbee.resolveEntity(entity.settings.ID);
        this.emitScene(entity, sceneId);
    }

    recallScene(entity, sceneId) {
        const states = entity.settings.scenes[sceneId].states || {};
        logger.warn('recall: '+sceneId+' '+JSON.stringify(entity.settings));
        for (const [ieee, state] of Object.entries(states)) {
            const deviceEntity = this.zigbee.resolveEntity(ieee);
            this.api.getSetState('set', deviceEntity, state);
        }
    }
}


module.exports = GroupsAPI;
