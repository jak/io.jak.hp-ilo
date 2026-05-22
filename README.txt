Monitor and control your HPE servers from Homey through their iLO (Integrated Lights-Out) interface, using the modern Redfish API.

Each device is one server. See at a glance whether it is on, how much power it is drawing, its inlet and CPU temperatures, fan speed, and overall health (OK / Warning / Critical).

Control power right from Homey: the on/off toggle powers the server on or performs a graceful OS shutdown. Flows can turn it on, gracefully shut it down, force it off, warm-restart, or cold-boot it — and react when the server's health changes or becomes critical.

Supported: iLO 5 (ProLiant Gen10/Gen10 Plus) and iLO 6 (ProLiant Gen11).

Pairing is simple: enter your iLO host/IP, username and password. iLO's default self-signed certificate is accepted out of the box (you can require a trusted certificate instead). The poll interval is configurable per device.
