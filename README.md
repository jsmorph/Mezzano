# Mezzano

Mezzano is an operating system written in Common Lisp.  It includes a native compiler, garbage collector, scheduler, networking, filesystem support, and a desktop.  Lisp programs share the system's object memory.  A snapshot saves the running system to its disk image.

![Mezzano desktop](doc/screenshot1.png)

## Installation and use

The [installation and operation guide](doc/installation.md) describes building and running the x86-64 image with QEMU and connecting through SWANK or the Web interface.  The current startup initializes the guest desktop even when QEMU's display is hidden.  ARM64 support exists in the source, but this guide covers x86-64 QEMU.

The [user guide](doc/project-guide.md) links the product documentation.  The [Web Listener and Debugger](tools/swank/web/README.md) provides remote evaluation, debugger access, and the [Document Examiner](doc/document-examiner.md).  The [desktop reference](doc/quickstart.md) covers native keyboard commands and status displays.

The [debugger and evaluation reference](doc/debugger.md) specifies supported operations, compiler requirements, and recovery behavior.  The [remote evaluation guide](tools/swank/README.md) covers the Lisp clients.  The [Command Processor reference](doc/command-processor.md) lists Listener and debugger commands.

## Source and releases

This branch adds retained evaluation, remote debugging, and Web tools to Mezzano.  The installation guide selects the corresponding Mezzano and Slime branches.  Upstream [demo images](https://github.com/froggey/Mezzano/releases) and [release history](doc/release-history.md) describe separate releases and their features.

The upstream build environment is [MBuild](https://github.com/froggey/MBuild).  Development discussion takes place in #mezzano on Libera Chat.

## Credits

"Hypothymis azurea - Kaeng Krachan" by JJ Harrison (jjharrison89@facebook.com)
[CC BY-SA 3.0 (http://creativecommons.org/licenses/by-sa/3.0)], via Wikimedia Commons
https://commons.wikimedia.org/wiki/File:Hypothymis_azurea_-_Kaeng_Krachan.jpg

"Mandarin Pair" by © Francis C. Franklin / CC-BY-SA-3.0.
Licensed under CC BY-SA 3.0 via Wikimedia Commons - http://commons.wikimedia.org/wiki/File:Mandarin_Pair.jpg

"Handsome" by Andy Morffew - https://www.flickr.com/photos/andymorffew/19377769093/in/album-72157630893775092/
[CC BY 2.0 (http://creativecommons.org/licenses/by/2.0)]

Includes Dejavu Fonts 2.37 (https://dejavu-fonts.github.io/)

Some icons from Icojam (http://www.icojam.com)
