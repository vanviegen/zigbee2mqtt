const zigbeeHerdsmanConverters = require('zigbee-herdsman-converters');
const assert = require('assert');
const utils = require('../util/utils');
const logger = require('../util/logger');
const settings = require('../util/settings');
const DeviceCommands = require('./device');
const GroupCommands = require('./group');


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

/**
 * This class and its compositional classes (DeviceCommands, GroupCommands) handle requests
 * coming in through MQTT or WebSocket (or in the future possibly other protocols like HTTP).
 * The `call` method will resolve a `path` like 'device/remove' to invoke the `this.$device.$remove()`
 * method. The dollar signs are there to indicate these methods and objects are part of the
 * public interface.
 * From within every `Extension`, an instance of `Commands` can be accessed using `this.commands`,
 * making it easy for the legacy API to invoke new style commands.
 */
class Commands {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;
        this.publishEntityState = publishEntityState;
        this.eventBus = eventBus;

        this.$device = new DeviceCommands(zigbee, mqtt, state, publishEntityState, eventBus);
        this.$group = new GroupCommands(zigbee, mqtt, state, publishEntityState, eventBus);
    }

    call(path, argObj) {
        const parts = path.split('/');
        let current = this;
        let thisObject;

        while (parts.length) {
            thisObject = current;

            // Prefix a $ and convert snake_case to camelCase
            const name = '$'+parts[0].replace(/_(.)/g, (all, char) => char.toUpperCase());

            current = current[name];
            if (!current) break;
            parts.shift();
        }

        let response;
        try {
            if (typeof current === 'function') {
                response = current.call(thisObject, argObj);
            } else if (current && current.handleIndex) {
                response = current.handleIndex(argObj);
            } else if (thisObject.handlePath) {
                response = thisObject.handlePath(parts, argObj);
            } else {
                response = {status: 'failed', error: `No such command: ${path}`};
            }
        } catch (e) {
            response = {status: 'failed', error: e.toString()};
        }

        if (!response || typeof response !== 'object') {
            response = response==null ? {status: 'successful'} : {status: 'successful', data: response};
        }
        return response;
    }

    $rename({id, newName}) {
        try {
            const isGroup = settings.getGroup(id) !== null;
            settings.changeFriendlyName(id, newName);
            logger.info(`Successfully renamed - ${id} to ${newName} `);
            const entity = this.zigbee.resolveEntity(newName);
            const eventData = isGroup ? {group: entity.group} : {device: entity.device};
            this.eventBus.emit(`${isGroup ? 'group' : 'device'}Renamed`, eventData);

            this.mqtt.publish(
                'bridge/log',
                JSON.stringify({type: `${isGroup ? 'group' : 'device'}_renamed`, message: {from: id, to: newName}}),
            );
        } catch (error) {
            logger.error(`Failed to rename - ${id} to ${newName}`);
        }
    }


    /**
     * Set attributes for the device/group identified by `id` (either a device ieee address,
     * a group ID or a friendly name for either), as specified by the `attributes` object
     * (i.e. `{brightness: 120, state: "ON"}`).
     * @return {Promise}
     */
    $setState({id, payload}) {
        return this.getSetState({operation: 'set', id, payload});
    }

    /**
     * Ask the device/group identified by `id` (either a device ieee address, a group ID or a
     * friendly name for either), to report its current status on the specified `attributes`
     * (i.e. `["color", "state", "brightness"]`). Instead of `attributes`, `payload` may be
     * given an object with the attribute names as keys, and nothing in particular as values
     * (i.e. `{color: "", state: "", brightness: ""}`)
     * @return {Promise}
     */
    $requestState({id, payload={}, attributes}) {
        if (attributes instanceof Array) {
            for (const attr of attributes) {
                payload[attr] = '';
            }
        }
        return this.getSetState({operation: 'get', id, payload});
    }

    async getSetState({operation, id, payload}) {
        const resolvedEntity = this.zigbee.resolveEntity(id);

        // Get entity details
        let converters = null;
        let target = null;
        let options = {};
        let device = null;
        let definition = null;
        let endpointName = null;

        assert(resolvedEntity.type === 'device' || resolvedEntity.type === 'group');
        if (resolvedEntity.type === 'device') {
            if (!resolvedEntity.definition) {
                logger.warn(`Device with modelID '${resolvedEntity.device.modelID}' is not supported.`);
                logger.warn(`Please see: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_devices.html`);
                return;
            }

            device = resolvedEntity.device;
            definition = resolvedEntity.definition;
            target = resolvedEntity.endpoint;
            converters = resolvedEntity.definition.toZigbee;
            options = resolvedEntity.settings;

            // If the definition knows about multiple endpoints, we'll need to pass the endpoint name to the 
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
            target = resolvedEntity.group;
            options = resolvedEntity.settings;
            definition = resolvedEntity.group.members.map((e) => zigbeeHerdsmanConverters.findByDevice(e.getDevice()));
        }

        const deviceState = this.state.get(resolvedEntity.settings.ID) || {};

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
            if (resolvedEntity.type === 'device' && key.includes('_')) {
                const underscoreIndex = key.lastIndexOf('_');
                const possibleEndpointName = key.substring(underscoreIndex + 1, key.length);
                if (utils.getEndpointNames().includes(possibleEndpointName)) {
                    actualEndpointName = possibleEndpointName;
                    key = key.substring(0, underscoreIndex);
                    const device = target.getDevice();
                    actualTarget = device.getEndpoint(definition.endpoint(device)[actualEndpointName]);

                    if (!actualTarget) {
                        logger.error(`Device '${resolvedEntity.name}' has no endpoint '${endpointName}'`);
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
                    logger.debug(`Publishing '${operation}' '${key}' to '${resolvedEntity.name}'`);
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

                        this.publishEntityState(resolvedEntity.settings.ID, msg);
                    }

                    // It's possible for devices to get out of sync when writing an attribute that's not reportable.
                    // So here we re-read the value after a specified timeout, this timeout could for example be the
                    // transition time of a color change or for forcing a state read for devices that don't
                    // automatically report a new state when set.
                    // When reporting is requested for a device (report: true in device-specific settings) we won't
                    // ever issue a read here, as we assume the device will properly report changes.
                    // Only do this when the retrieve_state option is enabled for this device.
                    if (
                        resolvedEntity.type === 'device' && result && result.hasOwnProperty('readAfterWriteTime') &&
                        resolvedEntity.settings.retrieve_state
                    ) {
                        setTimeout(() => converter.convertGet(actualTarget, key, meta), result.readAfterWriteTime);
                    }
                } else if (operation === 'get' && converter.convertGet) {
                    logger.debug(`Publishing get '${operation}' '${key}' to '${resolvedEntity.name}'`);
                    await converter.convertGet(actualTarget, key, meta);
                } else {
                    logger.error(`No converter available for '${operation}' '${key}' (${payload[key]})`);
                    continue;
                }
            } catch (error) {
                const logMsg =
                    `Publish '${operation}' '${key}' to '${resolvedEntity.name}' failed: '${error}'`;
                logger.error(logMsg);
                logger.debug(error.stack);

                /* istanbul ignore else */
                if (settings.get().advanced.legacy_api) {
                    const meta = {friendly_name: resolvedEntity.name};
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


module.exports = Commands;
