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
        // Strip the endpoint id of the ieees:
        let devices = (entity.settings.devices || []).map((key) => key.split('/')[0]);
        // Remove duplicates:
        devices = [...new Set(devices)];
        return {
            name: entity.name,
            devices,
        };
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
        }
        if (path.length===1 && path[0]==='state') {
            if (command==='set') {
                return this.$setState(entity, data);
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
        setProperties(this, '$set_', [entity], data);

        return {id};
    }

    delete(entity) {
        settings.removeGroup(entity.ID);
        entity.group.removeFromDatabase();
        this.mqtt.publish('bridge/log', JSON.stringify({type: `group_removed`, message: entity.ID}));
        logger.info(`Removed group '${entity.ID}'`);
    }

    $setName(entity, newName) {
        const oldName = entity.name;
        settings.changeFriendlyName(entity.settings.ID, newName);
        logger.info(`Successfully renamed - ${oldName} to ${newName} `);

        this.mqtt.publish(
            'bridge/log',
            JSON.stringify({type: `group_renamed`, message: {from: oldName, to: newName}}),
        );
    }

    async $setDevices(groupEntity, deviceIds) {
        assert(deviceIds instanceof Array);
        const oldIds = groupEntity.settings.devices;

        const keys = new Set();

        for (const deviceId of deviceIds) {
            const deviceEntity = this.zigbee.resolveEntity(deviceId);
            if (!deviceEntity || deviceEntity.type !== 'group') {
                throw new Error(`Device '${deviceId}' does not exist`);
            }

            // We'll subscribe all endpoints for a device, except 'system'.
            let endpoints = {default: deviceEntity.endpoint.ID};
            if (deviceEntity.defition && deviceEntity.definition.endpoint) {
                endpoints = deviceEntity.definition.endpoint(deviceEntity.device);
            }

            for (const endpointName of endpoints) {
                if (endpointName === 'system') continue;
                const endpointId = endpoints[endpointName];
                const key = `${deviceEntity.device.ieeeAddr}/${endpointId}`;
                keys.push(key);

                if (oldIds.contains(key)) continue;

                deviceEntity.endpoint = deviceEntity.device.getEndpoint(endpointId);
                await this.addDevice(groupEntity, deviceEntity);
            }
        }

        for (const key of oldIds) {
            if (!keys.contains(key)) {
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
    }
}


module.exports = GroupsAPI;
