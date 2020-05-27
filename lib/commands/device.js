const logger = require('../util/logger');
const settings = require('../util/settings');


class DeviceCommands {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;
        this.publishEntityState = publishEntityState;
        this.eventBus = eventBus;
    }
    
    async $remove({id, action='remove'}) {
        const entity = this.zigbee.resolveEntity(id.trim());
        const lookup = {
            ban: ['banned', 'Banning', 'ban'],
            force_remove: ['force_removed', 'Force removing', 'force remove'],
            remove: ['removed', 'Removing', 'remove'],
        };

        if (!entity) {
            logger.error(`Cannot ${lookup[action][2]}, device '${id}' does not exist`);

            this.mqtt.publish('bridge/log', JSON.stringify({type: `device_${lookup[action][0]}_failed`, message: id}));
            return;
        }

        const cleanup = () => {
            // Fire event
            this.eventBus.emit('deviceRemoved', {device: entity.device});

            // Remove from configuration.yaml
            settings.removeDevice(entity.settings.ID);

            // Remove from state
            this.state.remove(entity.settings.ID);

            logger.info(`Successfully ${lookup[action][0]} ${entity.settings.friendlyName}`);
            this.mqtt.publish('bridge/log', JSON.stringify({type: `device_${lookup[action][0]}`, message: id}));
        };

        try {
            logger.info(`${lookup[action][1]} '${entity.settings.friendlyName}'`);
            if (action === 'force_remove') {
                await entity.device.removeFromDatabase();
            } else {
                await entity.device.removeFromNetwork();
            }

            cleanup();
        } catch (error) {
            logger.error(`Failed to ${lookup[action][2]} ${entity.settings.friendlyName} (${error})`);
            // eslint-disable-next-line
            logger.error(`See https://www.zigbee2mqtt.io/information/mqtt_topics_and_message_structure.html#zigbee2mqttbridgeconfigremove for more info`);

            this.mqtt.publish('bridge/log', JSON.stringify({type: `device_${lookup[action][0]}_failed`, message: id}));
        }

        if (action === 'ban') {
            settings.banDevice(entity.settings.ID);
        }
    }
}


module.exports = DeviceCommands;
