const zigbeeHerdsmanConverters = require('zigbee-herdsman-converters');
const assert = require('assert');
const utils = require('../util/utils');
const logger = require('../util/logger');
const settings = require('../util/settings');
const Extension = require('./extension');


const groupConverters = [
    zigbeeHerdsmanConverters.toZigbeeConverters.light_onoff_brightness,
    zigbeeHerdsmanConverters.toZigbeeConverters.light_colortemp,
    zigbeeHerdsmanConverters.toZigbeeConverters.light_color,
    zigbeeHerdsmanConverters.toZigbeeConverters.light_alert,
    zigbeeHerdsmanConverters.toZigbeeConverters.ignore_transition,
    zigbeeHerdsmanConverters.toZigbeeConverters.cover_position_tilt,
    zigbeeHerdsmanConverters.toZigbeeConverters.thermostat_occupied_heating_setpoint,
    zigbeeHerdsmanConverters.toZigbeeConverters.tint_scene,
    zigbeeHerdsmanConverters.toZigbeeConverters.light_brightness_move,
];


class API extends Extension {
    constructor(...args) {
        super(...args);
        this.delegates = {};
    }

    getTree() {
        const result = {};
        for (const [key, value] of Object.entries(this.delegates)) {
            result[key] = value.getTree();
        }
        return result;
    }

    logError(type, message, stack) {
        logger.error(message + (stack ? ` (${stack})` : ''));
        this.mqtt.publish('bridge/log', JSON.stringify({type, message}));
    }

    async call({command, path, data}) {
        const emitResponse = (data, error) => {
            if (error) {
                const stack = (error instanceof Error) ? error.stack : null;
                const pathStr = (path instanceof Array) ? path.join('/') : path;
                const errorStr = (error instanceof Error) ? error.message : error;
                const errorCtx = `${errorStr} for command=${command} path=${pathStr} data=${JSON.stringify(data)}`;
                this.logError('command_failed', errorCtx, stack);
                return {command: 'response', status: 'failed', error: errorStr};
            }
            return {command: 'response', status: 'successful', data: data || {}};
        };

        if (typeof command !== 'string') {
            return emitResponse(null, `Command is not a string`);
        }
        command = command.toLowerCase();

        if (typeof path === 'string') {
            path = path.split('/');
            if (path[0] === '') path.shift();
            if (path.length === 1 && path[0] === '') path = [];
        } else if (!(path instanceof Array)) {
            return emitResponse(null, `Path is not a string nor an array`);
        }

        if (!path.length) {
            if (command==='get') {
                return this.getTree();
            }
        }

        const delegateName = path[0];
        if (!this.delegates.hasOwnProperty(delegateName)) {
            return emitResponse(null, `No such command`);
        }

        try {
            const dataCopy = data ? {...data} : {};
            const response = await this.delegates[delegateName].call({command, path: path.slice(1), data: dataCopy});
            return emitResponse(response || {});
        } catch (e) {
            return emitResponse(null, e);
        }
    }

    /*
     * Helper method for setting and requesting device/group state.
     * This is not a good place for this method -- but where *should* it be?
     */
    async getSetState(operation, entity, payload) {
        // Get entity details
        let converters = null;
        let target = null;
        let options = {};
        let device = null;
        let definition = null;
        let endpointName = null;

        assert(entity.type === 'device' || entity.type === 'group');
        if (entity.type === 'device') {
            if (!entity.definition) {
                logger.warn(`Device with modelID '${entity.device.modelID}' is not supported.`);
                logger.warn(`Please see: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_devices.html`);
                return;
            }

            device = entity.device;
            definition = entity.definition;
            target = entity.endpoint;
            converters = entity.definition.toZigbee;
            options = entity.settings;

            if (definition.endpoint) {
                const endpointMap = definition.endpoint(device);
                for (const name in endpointMap) {
                    if (endpointMap[name] === target.ID) {
                        endpointName = name;
                    }
                }
            }
        } else {
            converters = groupConverters;
            target = entity.group;
            options = entity.settings;
            definition = entity.group.members.map((e) => zigbeeHerdsmanConverters.findByDevice(e.getDevice()));
        }

        const deviceState = this.state.get(entity.settings.ID) || {};

        /**
         * Order state & brightness based on current bulb state
         *
         * Not all bulbs support setting the color/color_temp while it is off
         * this results in inconsistant behavior between different vendors.
         *
         * bulb on => move state & brightness to the back
         * bulb off => move state & brightness to the front
         */
        const entries = Object.entries(payload);
        const sorter = typeof payload.state === 'string' && payload.state.toLowerCase() === 'off' ? 1 : -1;
        entries.sort((a, b) => (['state', 'brightness', 'brightness_percent'].includes(a[0]) ? sorter : sorter * -1));

        // For each attribute call the corresponding converter
        const usedConverters = {};
        for (let [key, value] of entries) {
            let actualTarget = target;
            let actualEndpointName = endpointName;

            // When the key has a endpointName included (e.g. state_right), this will override the target.
            if (entity.type === 'device' && key.includes('_')) {
                const underscoreIndex = key.lastIndexOf('_');
                const possibleEndpointName = key.substring(underscoreIndex + 1, key.length);
                if (utils.getEndpointNames().includes(possibleEndpointName)) {
                    actualEndpointName = possibleEndpointName;
                    key = key.substring(0, underscoreIndex);
                    const device = target.getDevice();
                    actualTarget = device.getEndpoint(definition.endpoint(device)[actualEndpointName]);

                    if (!actualTarget) {
                        logger.error(`Device '${entity.name}' has no endpoint '${endpointName}'`);
                        continue;
                    }
                }
            }

            const endpointOrGroupID = actualTarget.constructor.name == 'Group' ? actualTarget.groupID : actualTarget.ID;
            if (!usedConverters.hasOwnProperty(endpointOrGroupID)) usedConverters[endpointOrGroupID] = [];
            const converter = converters.find((c) => c.key.includes(key));

            if (usedConverters[endpointOrGroupID].includes(converter)) {
                // Use a converter only once (e.g. light_onoff_brightness converters can convert state and brightness)
                continue;
            }

            if (!converter) {
                logger.error(`No converter available for '${key}' (${payload[key]})`);
                continue;
            }

            // Converter didn't return a result, skip
            const meta = {
                endpoint_name: actualEndpointName,
                options,
                message: payload,
                logger,
                device,
                state: deviceState,
                mapped: definition,
            };

            try {
                if (operation === 'set' && converter.convertSet) {
                    logger.debug(`Publishing '${operation}' '${key}' to '${entity.name}'`);
                    const result = await converter.convertSet(actualTarget, key, value, meta);
                    if (result && result.state) {
                        const msg = result.state;

                        if (actualEndpointName) {
                            for (const key of ['state', 'brightness', 'color', 'color_temp']) {
                                if (msg.hasOwnProperty(key)) {
                                    msg[`${key}_${actualEndpointName}`] = msg[key];
                                    delete msg[key];
                                }
                            }
                        }

                        this.publishEntityState(entity.settings.ID, msg);
                    }

                    // It's possible for devices to get out of sync when writing an attribute that's not reportable.
                    // So here we re-read the value after a specified timeout, this timeout could for example be the
                    // transition time of a color change or for forcing a state read for devices that don't
                    // automatically report a new state when set.
                    // When reporting is requested for a device (report: true in device-specific settings) we won't
                    // ever issue a read here, as we assume the device will properly report changes.
                    // Only do this when the retrieve_state option is enabled for this device.
                    if (
                        entity.type === 'device' && result && result.hasOwnProperty('readAfterWriteTime') &&
                        entity.settings.retrieve_state
                    ) {
                        setTimeout(() => converter.convertGet(actualTarget, key, meta), result.readAfterWriteTime);
                    }
                } else if (operation === 'get' && converter.convertGet) {
                    logger.debug(`Publishing get '${operation}' '${key}' to '${entity.name}'`);
                    await converter.convertGet(actualTarget, key, meta);
                } else {
                    logger.error(`No converter available for '${operation}' '${key}' (${payload[key]})`);
                    continue;
                }
            } catch (error) {
                const logMsg =
                    `Publish '${operation}' '${key}' to '${entity.name}' failed: '${error}'`;
                logger.error(logMsg);
                logger.debug(error.stack);

                /* istanbul ignore else */
                if (settings.get().advanced.legacy_api) {
                    const meta = {friendly_name: entity.name};
                    this.mqtt.publish(
                        'bridge/log',
                        JSON.stringify({type: `zigbee_publish_error`, message: logMsg, meta}),
                    );
                }
            }

            usedConverters[endpointOrGroupID].push(converter);
        }

        return true;
    }
}


module.exports = API;
