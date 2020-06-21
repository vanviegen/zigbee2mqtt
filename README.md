## A Zigbee2Mqtt fork

This fork is a work-in-progress. In adds:
- An easier to use MQTT API (in addition to the existing API),
- A WebSocket API,
- A TCP API,
- An HTTP AI,
- Scenes (though just implemented in the server and not using the Zigbee scenes cluster, for now).

The APIs are designed to make it easy to implement clients that have real-time access to the full state of all devices and groups.

**Beware**: This is in alpha-stage. Things may change/break without notice.

I'm hoping this experiment can be merged back in to Zigbee2Mqtt proper at some point.

