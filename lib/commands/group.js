const assert = require('assert');
const logger = require('../util/logger');
const settings = require('../util/settings');


class GroupCommands {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;
        this.publishEntityState = publishEntityState;
        this.eventBus = eventBus;
    }

    $add({name, id}) {
        const settingsGroup = settings.addGroup(name, id);
        const group = this.zigbee.createGroup(settingsGroup.ID);
        this.eventBus.emit(`groupAdded`, {group});
        this.mqtt.publish('bridge/log', JSON.stringify({type: `group_added`, message: name}));
        logger.info(`Added group '${name}'`);
        return {id: settingsGroup.ID};
    }

    $remove({id}) {
        const entity = this.zigbee.resolveEntity(id);
        assert(entity && entity.type === 'group', `Group '${id}' does not exist`);
        settings.removeGroup(entity.ID);
        entity.group.removeFromDatabase();
        this.eventBus.emit('groupRemoved', {group: entity.group});
        this.mqtt.publish('bridge/log', JSON.stringify({type: `group_removed`, message: entity.ID}));
        logger.info(`Removed group '${entity.ID}'`);
    }

    $addDevice({groupId, deviceId}) {
        
    }
}


module.exports = GroupCommands;
