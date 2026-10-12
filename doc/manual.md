# Networking

Mezzano's network initialization requests an IPv4 address through DHCP for each interface by default.  QEMU's user network supplies DHCP and outbound connectivity.  The [installation guide](installation.md) uses a virtio-net device and forwards a host TCP port to the guest's SWANK port.

## QEMU addresses and ports

With QEMU's default user network, the guest reaches the host at `10.0.2.2`.  The image configuration uses that address for its source file server.  The file server listens on host loopback port 2599 under SBCL.  Its REMOTE pathnames refer to files on that host.

The guest SWANK service listens on TCP port 4005.  QEMU port forwarding determines the host address and port through which a client connects.  Multiple guests require distinct host forwarding ports.  A Web server's SWANK settings refer to the endpoint reachable from the Web server.

## Network inspection

The native desktop's Peek application includes a Network view.  It displays network interfaces and addresses, routes, DNS servers, DHCP leases, and TCP and UDP connections.  Interface and connection state can change while the display is being read.

The current [network initialization](../net/network-setup.lisp) and [DHCP implementation](../net/dhcp.lisp) define interface configuration.  The QEMU procedure uses the default DHCP configuration.  Bare-metal network configuration depends on the installed adapter and its driver.
