# Release history

## Major changes since Demo 4

* USB stack by fittestbits
* Improved overall file system support by fittestbits
* EXT2/3/4 support has been implemented by Bruno Cichon (ebrasca)
* GMA950 modesetting display driver
* Hardware accelerated 3D support via qemu's Virgl device
* Multicore/SMP support
* Improved atomic operations
* Async APIs: wait-for-objects, dispatch, and thread pools
* Networking improvements: Server support, DHCP, TCP retransmit
* Source locations are tracked for many kinds of definitions
* Weak hash tables and other weak objects
* Cleanup of object representation and unification of standard-object/structure-object
* Unboxed structure slots
* Short floats implemented using IEEE half floats
* Unboxed (unsigned-byte 64) arithmetic
* Stack overflows and memory faults are trapped and can be recovered from
* Support for building on Windows
* Major improvements to CLOS and MOP conformance
* Keymap picker

## Major changes since Demo 3

* FAT32 support has been implemented by Bruno Cichon (ebrasca).
* McCLIM has been ported by fittestbits.
* Quicklisp has been ported by Peter S. Housel.
* Improved introspection tools: DISASSEMBLE and ED have been implemented.
* Generational collection has been added to the garbage collector.
* New SSA-based compiler backend, supporting unboxed value representations.
* Gray streams support has been overhauled.

## Major changes since Demo 2

* Trentino, a media player, has been implemented by Eugene Zaikonnikov.
* Further improvements to conformance, stability and performance.
* The CLOS implementation follows the MOP much more closely.
* More traditional window management.
* Booting from CD/USB on real hardware is now possible.
* Driver support for Intel HDA audio devices.
* VirtualBox guest (mouse & display) integration.

## Major changes since Demo 1

* Many improvements to conformance, stability and performance.
* The editor has been greatly improved, thanks to Burton Samograd.
* The system now functions correctly on computers with more than 1GB of RAM.
* The allocator and garbage collector now make much better use of available memory, with far fewer GC cycles occurring.
* (ROOM T) prints more detailed information about allocated objects.
* Transparency and premultiplied alpha support in the GUI.

