const settings = require('../../util/settings');
const logger = require('../../util/logger');
const zigbeeHerdsmanConverters = require('zigbee-herdsman-converters');
const utils = require('../../util/utils');
const assert = require('assert');
const Extension = require('../extension');

const configRegex =
    new RegExp(`${settings.get().mqtt.base_topic}/bridge/config/((?:\\w+/get)|(?:\\w+/factory_reset)|(?:\\w+))`);
const allowedLogLevels = ['error', 'warn', 'info', 'debug'];

class BridgeLegacy extends Extension {
    constructor(...args) {
        super(...args);

        // Bind functions
        this.permitJoin = this.permitJoin.bind(this);
        this.lastSeen = this.lastSeen.bind(this);
        this.elapsed = this.elapsed.bind(this);
        this.reset = this.reset.bind(this);
        this.logLevel = this.logLevel.bind(this);
        this.devices = this.devices.bind(this);
        this.groups = this.groups.bind(this);
        this.rename = this.rename.bind(this);
        this.renameLast = this.renameLast.bind(this);
        this.remove = this.remove.bind(this);
        this.forceRemove = this.forceRemove.bind(this);
        this.ban = this.ban.bind(this);
        this.deviceOptions = this.deviceOptions.bind(this);
        this.addGroup = this.addGroup.bind(this);
        this.removeGroup = this.removeGroup.bind(this);
        this.whitelist = this.whitelist.bind(this);
        this.touchlinkFactoryReset = this.touchlinkFactoryReset.bind(this);

        this.lastJoinedDeviceName = null;

        // Set supported options
        this.supportedOptions = {
            'permit_join': this.permitJoin,
            'last_seen': this.lastSeen,
            'elapsed': this.elapsed,
            'reset': this.reset,
            'log_level': this.logLevel,
            'devices': this.devices, // Replaced by Commands API
            'groups': this.groups, // Replaced by Commands API
            'devices/get': this.devices, // Replaced by Commands API
            'rename': this.rename, // Replaced by Commands API
            'rename_last': this.renameLast, // Can we do without this in the new API?
            'remove': this.remove, // Replaced by Commands API
            'force_remove': this.forceRemove, // Replaced by Commands API
            'ban': this.ban, // Replaced by Commands API
            'device_options': this.deviceOptions, // Makes little sense for new Commands API?
            'add_group': this.addGroup, // Replaced by Commands API
            'remove_group': this.removeGroup, // Replaced by Commands API
            'whitelist': this.whitelist, // Replaced by Commands API
            'touchlink/factory_reset': this.touchlinkFactoryReset,
        };
    }

    async whitelist(topic, message) {
        return await this.api.call({
            command: 'set',
            path: ['devices', message],
            data: {whitelist: true},
        });
    }

    deviceOptions(topic, message) {
        let json = null;
        try {
            json = JSON.parse(message);
        } catch (e) {
            logger.error('Failed to parse message as JSON');
            return;
        }

        if (!json.hasOwnProperty('friendly_name') || !json.hasOwnProperty('options')) {
            logger.error('Invalid JSON message, should contain "friendly_name" and "options"');
            return;
        }

        const entity = settings.getEntity(json.friendly_name);
        assert(entity, `Entity '${json.friendly_name}' does not exist`);
        settings.changeDeviceOptions(entity.ID, json.options);
        logger.info(`Changed device specific options of '${json.friendly_name}' (${JSON.stringify(json.options)})`);
    }

    async permitJoin(topic, message) {
        await this.zigbee.permitJoin(message.toLowerCase() === 'true');
        this.publish();
    }

    async reset(topic, message) {
        try {
            await this.zigbee.reset('soft');
            logger.info('Soft resetted ZNP');
        } catch (error) {
            logger.error('Soft reset failed');
        }
    }

    lastSeen(topic, message) {
        const allowed = ['disable', 'ISO_8601', 'epoch', 'ISO_8601_local'];
        if (!allowed.includes(message)) {
            logger.error(`${message} is not an allowed value, possible: ${allowed}`);
            return;
        }

        settings.set(['advanced', 'last_seen'], message);
        logger.info(`Set last_seen to ${message}`);
    }

    elapsed(topic, message) {
        const allowed = ['true', 'false'];
        if (!allowed.includes(message)) {
            logger.error(`${message} is not an allowed value, possible: ${allowed}`);
            return;
        }

        settings.set(['advanced', 'elapsed'], message === 'true');
        logger.info(`Set elapsed to ${message}`);
    }

    logLevel(topic, message) {
        const level = message.toLowerCase();
        if (allowedLogLevels.includes(level)) {
            logger.info(`Switching log level to '${level}'`);
            logger.setLevel(level);
        } else {
            logger.error(`Could not set log level to '${level}'. Allowed level: '${allowedLogLevels.join(',')}'`);
        }

        this.publish();
    }

    async devices(topic, message) {
        const coordinator = await this.zigbee.getCoordinatorVersion();
        const devices = this.zigbee.getDevices().map((device) => {
            const payload = {
                ieeeAddr: device.ieeeAddr,
                type: device.type,
                networkAddress: device.networkAddress,
            };

            if (device.type !== 'Coordinator') {
                const definition = zigbeeHerdsmanConverters.findByDevice(device);
                const friendlyDevice = settings.getDevice(device.ieeeAddr);
                payload.model = definition ? definition.model : device.modelID;
                payload.vendor = definition ? definition.vendor : '-';
                payload.description = definition ? definition.description : '-';
                payload.friendly_name = friendlyDevice ? friendlyDevice.friendly_name : device.ieeeAddr;
                payload.manufacturerID = device.manufacturerID;
                payload.manufacturerName = device.manufacturerName;
                payload.powerSource = device.powerSource;
                payload.modelID = device.modelID;
                payload.hardwareVersion = device.hardwareVersion;
                payload.softwareBuildID = device.softwareBuildID;
                payload.dateCode = device.dateCode;
                payload.lastSeen = device.lastSeen;
            } else {
                payload.friendly_name = 'Coordinator';
                payload.softwareBuildID = coordinator.type;
                payload.dateCode = coordinator.meta.revision.toString();
                payload.lastSeen = Date.now();
            }

            return payload;
        });

        if (topic.split('/').pop() == 'get') {
            this.mqtt.publish(`bridge/config/devices`, JSON.stringify(devices), {});
        } else {
            this.mqtt.publish('bridge/log', JSON.stringify({type: 'devices', message: devices}));
        }
    }

    groups(topic, message) {
        const payload = settings.getGroups().map((g) => {
            const group = {...g};
            delete group.friendlyName;
            return group;
        });

        this.mqtt.publish('bridge/log', JSON.stringify({type: 'groups', message: payload}));
    }

    rename(topic, message) {
        const invalid =
            `Invalid rename message format expected {"old": "friendly_name", "new": "new_name"} got ${message}`;

        let json = null;
        try {
            json = JSON.parse(message);
        } catch (e) {
            logger.error(invalid);
            return;
        }

        const entity = this.zigbee.resolvedEntity(json.old);

        // Validate message
        if (!json.new || !entity) {
            logger.error(invalid);
            return;
        }

        this.api.call({
            command: 'set',
            path: [entity.type==='device' ? 'devices' : 'groups', json.old],
            data: {name: json.new},
        });
    }

    renameLast(topic, name) {
        if (!this.lastJoinedDeviceName) {
            logger.error(`Cannot rename last joined device, no device has joined during this session`);
            return;
        }

        this.api.call({
            command: 'set',
            path: ['devices', this.lastJoinedDeviceName],
            data: {name},
        });
    }

    addGroup(topic, message) {
        let id = null;
        let name = null;
        try {
            // json payload with id and friendly_name
            const json = JSON.parse(message);
            if (json.hasOwnProperty('id')) {
                id = json.id;
                name = `group_${id}`;
            }
            if (json.hasOwnProperty('friendly_name')) {
                name = json.friendly_name;
            }
        } catch (e) {
            // just friendly_name
            name = message;
        }

        if (name == null) {
            logger.error('Failed to add group, missing friendly_name!');
            return;
        }
        this.api.call({
            command: 'create',
            path: ['groups'],
            data: {name, id},
        });
    }

    removeGroup(topic, message) {
        return this.api.call({
            command: 'delete',
            path: ['groups', message],
        });
    }

    forceRemove(topic, message) {
        return this.api.call({
            command: 'delete',
            path: ['devices', message],
            data: {mode: 'force_remove'},
        });
    }

    remove(topic, message) {
        return this.api.call({
            command: 'delete',
            path: ['devices', message],
        });
    }

    ban(topic, message) {
        return this.api.call({
            command: 'delete',
            path: ['devices', message],
            data: {mode: 'ban'},
        });
    }

    async onMQTTConnected() {
        this.mqtt.subscribe(`${settings.get().mqtt.base_topic}/bridge/config/+`);
        this.mqtt.subscribe(`${settings.get().mqtt.base_topic}/bridge/config/+/+`);
        await this.publish();
    }

    async onMQTTMessage(topic, message) {
        if (!topic.match(configRegex)) {
            return false;
        }

        const option = topic.match(configRegex)[1];

        if (!this.supportedOptions.hasOwnProperty(option)) {
            return false;
        }

        await this.supportedOptions[option](topic, message);

        return true;
    }

    async publish() {
        const info = await utils.getZigbee2mqttVersion();
        const coordinator = await this.zigbee.getCoordinatorVersion();
        const topic = `bridge/config`;
        const payload = {
            version: info.version,
            commit: info.commitHash,
            coordinator,
            log_level: logger.getLevel(),
            permit_join: await this.zigbee.getPermitJoin(),
        };

        await this.mqtt.publish(topic, JSON.stringify(payload), {retain: true, qos: 0});
    }

    onZigbeeEvent(type, data, resolvedEntity) {
        if (type === 'deviceJoined' && resolvedEntity) {
            this.lastJoinedDeviceName = resolvedEntity.name;
        }

        if (type === 'deviceJoined') {
            this.mqtt.publish(
                'bridge/log',
                JSON.stringify({type: `device_connected`, message: {friendly_name: resolvedEntity.name}}),
            );
        } else if (type === 'deviceInterview') {
            if (data.status === 'successful') {
                if (resolvedEntity.definition) {
                    const {vendor, description, model} = resolvedEntity.definition;
                    const log = {friendly_name: resolvedEntity.name, model, vendor, description, supported: true};
                    this.mqtt.publish(
                        'bridge/log',
                        JSON.stringify({type: `pairing`, message: 'interview_successful', meta: log}),
                    );
                } else {
                    const meta = {friendly_name: resolvedEntity.name, supported: false};
                    this.mqtt.publish(
                        'bridge/log',
                        JSON.stringify({type: `pairing`, message: 'interview_successful', meta}),
                    );
                }
            } else if (data.status === 'failed') {
                const meta = {friendly_name: resolvedEntity.name};
                this.mqtt.publish(
                    'bridge/log',
                    JSON.stringify({type: `pairing`, message: 'interview_failed', meta}),
                );
            } else {
                /* istanbul ignore else */
                if (data.status === 'started') {
                    const meta = {friendly_name: resolvedEntity.name};
                    this.mqtt.publish(
                        'bridge/log',
                        JSON.stringify({type: `pairing`, message: 'interview_started', meta}),
                    );
                }
            }
        } else if (type === 'deviceAnnounce') {
            const meta = {friendly_name: resolvedEntity.name};
            this.mqtt.publish('bridge/log', JSON.stringify({type: `device_announced`, message: 'announce', meta}));
        } else {
            /* istanbul ignore else */
            if (type === 'deviceLeave') {
                const name = resolvedEntity ? resolvedEntity.name : data.ieeeAddr;
                const meta = {friendly_name: name};
                this.mqtt.publish(
                    'bridge/log',
                    JSON.stringify({type: `device_removed`, message: 'left_network', meta}),
                );
            }
        }
    }

    async touchlinkFactoryReset() {
        logger.info('Starting touchlink factory reset...');
        this.mqtt.publish(
            'bridge/log',
            JSON.stringify({type: `touchlink`, message: 'reset_started', meta: {status: 'started'}}),
        );
        const result = await this.zigbee.touchlinkFactoryReset();

        if (result) {
            logger.info('Successfully factory reset device through Touchlink');
            this.mqtt.publish(
                'bridge/log',
                JSON.stringify({type: `touchlink`, message: 'reset_success', meta: {status: 'success'}}),
            );
        } else {
            logger.warn('Failed to factory reset device through Touchlink');
            this.mqtt.publish(
                'bridge/log',
                JSON.stringify({type: `touchlink`, message: 'reset_failed', meta: {status: 'failed'}}),
            );
        }
    }
}

module.exports = BridgeLegacy;
