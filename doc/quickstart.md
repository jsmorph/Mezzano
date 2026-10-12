# Desktop reference

This reference covers the native Mezzano desktop.  The [Web guide](../tools/swank/web/README.md) describes browser controls.  The [installation guide](installation.md) covers QEMU and SWANK access.

## Keyboard notation

| Key or indicator | Meaning |
|---|---|
| `C-<key>` | Hold the control key while typing `<key>`. |
| `M-<key>` | Hold the Alt or Meta key while typing `<key>`. |

Alphabetic keys typed with control or meta ignore case.  `C-A` and `C-a` are the same key, while `C-!` and `C-1` are different.

The default keymap is En-GB.  Use M-F12 to switch between the registered keymaps, including En-GB, En-US, No-BK, PanCyr, German, ES-ESP, dvorak-writer, and dvorak-programmer.
Windows can be moved by dragging their title bar or by holding the Alt key and dragging.

## Global shortcuts

| Key or indicator | Meaning |
|---|---|
| `M-F12` | Switch to the next keymap. |
| `C-M-F12` | Switch to the previous keymap. |
| `Left-Alt-F11` | Print debugging information to the serial port. |
| `M-F10` | Open a REPL. |
| `C-M-F10` | Open a less featureful REPL. |
| `M-Esc` | Attempt to interrupt the thread associated with the current window. |
| `C-M-Esc` | Like `M-Esc`, but use `CERROR` instead of `BREAK`. |
| `M-F1` | Force the compositor to redraw the whole screen. |
| `M-F4` | Quit the current application. |
| `C-M-F4` | Forcibly close the current window. |

## Line editing

The line editor supports most standard line navigation and editing commands.

| Key or indicator | Meaning |
|---|---|
| `C-F` | Move forward (right) one character, also bound to Right-Arrow. |
| `C-B` | Move backward (left) one character, also bound to Left-Arrow. |
| `C-A` | Move to beginning of line, also bound to Home. |
| `C-E` | Move to end of line, also bound to End. |
| `M-F` | Move forward one word. |
| `M-B` | Move backward one word. |
| `M-P` | Find previous (older) matching history item, also bound to Up-Arrow. |
| `M-N` | Find next (newer) matching history item, also bound to Down-Arrow. |
| `C-D` | Delete the next character, also bound to Delete. |
| `Backspace` | Delete the previous character. |
| `M-D` | Delete the next word. |
| `M-Backspace` | Delete the previous word. |
| `C-K` | Delete from the cursor to the end of the line. |
| `C-C` | Enter the debugger using BREAK. |
| `C-G` | Invoke the most recent ABORT restart.  This usually clears input and returns to a prompt. |
| `Tab` | Cycle through completions for the current symbol. |

## Editor commands

The editor mostly follows Emacs conventions.

| Key or indicator | Meaning |
|---|---|
| `C-F` | Move forward (right) one character, also bound to Right-Arrow. |
| `C-B` | Move backward (left) one character, also bound to Left-Arrow. |
| `C-N` | Move to the next line (down), also bound to Down-Arrow. |
| `C-P` | Move to the previous line (up), also bound to Up-Arrow. |
| `C-A` | Move to beginning of line. |
| `C-E` | Move to end of line. |
| `M-<` | Move to the beginning of the buffer, also bound to Home. |
| `M->` | Move to the end of the buffer, also bound to End. |
| `C-V` | Move the point to the bottom of the screen and recenter, also bound to Page-Down. |
| `M-V` | Move the point to the top of the screen and recenter, also bound to Page-Up. |
| `M-F` | Move forward one word. |
| `M-B` | Move backward one word. |
| `C-M-F` | Move forward one s-expression. |
| `C-M-B` | Move backward one s-expression. |
| `C-D` | Delete the next character, also bound to Delete. |
| `Backspace` | Delete the previous character. |
| `M-D` | Kill the next word. |
| `M-Backspace` | Kill the previous word. |
| `C-K` | Kill characters from the point to the end of the line, or kill the newline if the point is at the end of the line. |
| `C-M-K` | Kill the next s-expression forward. |
| `C-W` | Kill the area between the point and the mark. |
| `C-Y` | Yank the last killed text back into the buffer at the point. |
| `C-L` | Recenter the display on the point. |
| `M-L` | Redraw the screen. |
| `C-Q` | Insert the next key typed without interpreting it as a command. |
| `C-Space` | If the point is at the mark and the mark is active, deactivate the mark.  Otherwise, activate the mark and move it to the point. |
| `C-X C-X` | Swap the point and the mark. |
| `C-X C-F` | Open or create a file. |
| `C-X C-S` | Save the current buffer.  If the buffer has no path, you will be prompted for a location to save it. |
| `C-X C-W` | Save the current buffer with a new path. |
| `C-X b` | Switch to a different buffer. |
| `C-X C-B` | List buffers. |
| `C-X k` | Close an open buffer. |
| `C-G` | Abort the current command. |
| `C-C C-C` | Evaluate the current top-level form. |
| `C-C C-A` | Move to the start of the current top-level form. |
| `M-x repl` | Create an editor-based REPL. |

## Snapshots

A snapshot saves the current machine state to disk.  The next boot restores that state.  Evaluate both forms and wait for completion before stopping the VM:

```lisp
(mezzano.supervisor:snapshot)
(mezzano.supervisor:wait-for-snapshot-completion)
```

The [installation guide](installation.md#snapshots-and-restarts) describes persistence and remote reference lifetimes.

## Status lights

A number of status lights are displayed at the top left of the screen.
From left to right:

| Key or indicator | Meaning |
|---|---|
| `Green` | Disk read in progress. |
| `Red` | Disk write in progress. |
| `Magenta` | GC in progress. |
| `Cyan` | Activity, system is not idle. |
| `Yellow` | Snapshot in progress. |
| `Orange` | Page fault being serviced. |
| `Light Green` | Network activity. |

The top line turns red if the system panics.

## Memory monitor

The memory monitor has two modes.  The first mode displays a graph of virtual
memory usage.  The second mode displays a bitmap indicating how each page
of physical memory is used, with colours indicating type.

### Virtual memory graph

| Key or indicator | Meaning |
|---|---|
| `Dark Blue` | General area % usage. |
| `Light blue` | General area bytes allocated. |
| `Purple` | General area bytes committed. |
| `Green` | Cons area % usage. |
| `Light green` | Cons area bytes allocated. |
| `Lime green` | Cons area bytes committed. |
| `Red` | Pinned area % usage. |
| `Hot Pink` | Wired area % usage. |
| `Brown` | Function area % usage. |
| `Lilac` | Wired Function area % usage. |

### Physical memory

| Key or indicator | Meaning |
|---|---|
| `Blue` | Free memory. |
| `Red` | Wired memory. |
| `Brown` | Wired backing memory, used during a snapshot. |
| `Green` | Active in-use memory. |
| `Dark green` | Active in-use memory ready to be written to disk. |
| `Purple` | Inactive memory ready to be written to disk. |
| `Pink` | Page tables. |
| `Grey` | Other. |
| `White` | Mixture. |
| `Black` | Unused or not present. |

## Remote access

The guest SWANK service listens on TCP port 4005.  A VM requires a forwarded host port for connections from the host.  The [installation guide](installation.md) supplies the QEMU configuration.  The [remote evaluation guide](../tools/swank/README.md) documents the Lisp clients.
