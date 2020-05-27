const events = require('events');
const assert = require('assert');

const allowedEvents = [
    'deviceRemoved', // Device has been removed
    'deviceRenamed', // Device has been renamed
    'groupAdded', // Group has been added
    'groupRenamed', // Group has been renamed
    'groupRemoved', // Group has been removed
    'groupDeviceAdded', // A device has been added to a group
    'groupDeviceRemoved', // A device has been removed from a group
    'publishEntityState', // Entity state will be published
    'stateChange', // Entity changes its state
];

class EventBus extends events.EventEmitter {
    emit(event, data) {
        assert(allowedEvents.includes(event), `Event '${event}' not supported`);
        super.emit(event, data);
    }

    on(event, callback) {
        assert(allowedEvents.includes(event), `Event '${event}' not supported`);
        super.on(event, callback);
    }
}

module.exports = EventBus;
