# Document Examiner

The Document Examiner displays the documentation catalog in named browser viewers.  Lisp reads the documentation, resolves topics, and performs searches.  The browser displays topics and keeps each viewer's bookmarks and reading history.

## Topics and reading

The catalog covers installation, system use, the Lisp language, remote evaluation, debugging, Listener commands, and the Web interface.  The [user guide](project-guide.md) provides an entry point to these subjects.

Each source document is a book.  Its Markdown headings define subordinate topics.  A topic ID is the source path followed by its heading anchor, for example `doc/debugger.md#compiler-guarantees`.  The root topic uses the source path alone.  Repeated titles remain distinct and can be selected through their IDs.  The catalog preserves source order and heading hierarchy.

Lisp reads paragraphs, lists, tables, fenced code, inline code, emphasis, and links.  Links to registered documentation topics become topic references.  Source-file and external links retain their destinations.  Unsupported markup remains text.  Source-read errors prevent a replacement catalog from being published.  `MEZZANO.DOCUMENT-EXAMINER:LOAD-CATALOG` rebuilds the catalog after documentation changes.

## Panes and commands

The Viewer occupies the left pane.  Current Candidates and Bookmarks occupy the upper and lower right panes.  Commands appear below.  A named viewer owns its displayed topics, bookmarks, and candidate-list history.  Viewing a topic appends its sections and records a viewed bookmark.  Selecting an already displayed section returns to it.  Deferred bookmarks follow viewed bookmarks on a gray background.

| Command | Behavior |
|---|---|
| Help | Displays the command summary. |
| Document Examiner Documentation | Displays this guide. |
| Show Documentation topic | Displays a topic and its subordinate sections. |
| Show Candidates terms | Searches topic titles and keywords and replaces Current Candidates. |
| Show Table of Contents topic | Lists the topic and its descendants with hierarchy indentation. |
| Show Overview topic | Displays its parent, ancestors, siblings, children, keywords, source, and references. |
| Reselect Candidates | Selects a prior candidate list for the current viewer. |
| Select Viewer name | Selects an existing viewer or creates one. |
| Remove Viewer name | Removes a viewer and its reading history. |
| Save Private Document pathname | Saves the current viewer's bookmarks in their displayed order. |
| Read Private Document pathname | Displays the referenced topics. |
| Load Private Document pathname | Adds new references as deferred bookmarks. |
| Hardcopy Private Document pathname | Opens the browser print dialog for the referenced sections without changing the viewer. |
| Hardcopy Viewer | Opens the browser print dialog for the displayed topics. |

SPACE completes a command word, Tab completes a name, and F12 requests HELP.  Topic names, search terms, and viewer names may contain spaces.  Quoting the complete argument also works.  Commands and topic lookup ignore case.  Topic IDs identify repeated titles without ambiguity.

Topic names are mouse-sensitive.  Mouse-Left displays documentation.  Mouse-Middle displays an overview.  Mouse-Right opens topic operations.  Shift-Middle adds a deferred bookmark when used on a topic and discards a bookmark when used in the Bookmarks pane.  The browser stores topic references and viewer history in tab sessionStorage and fetches documentation bodies from Lisp on reload.

## Searching

Search operates on topic titles and catalog keywords.  Exact matches complete indexed words.  Initial matches word prefixes.  Substring matches within indexed words.  Multiple terms require all terms.  Adjacent search also requires their order and adjacency within one title or keyword phrase.  The interface records the selected mode and adjacency with each candidate list.  Alt-F11 (Meta-COMPLETE) or Mouse-Right on Show Candidates opens the search-options menu.  The choices and initial defaults come from Lisp.

The initial default is Substring.  Search uses indexed titles and keywords, without stemming or full-text body search.

## Private documents

Load defers fetching topic bodies until viewing.  Hardcopy includes each referenced section once in the print document.  Mouse-Right on Read Private Document opens Save, Load, and Hardcopy choices.

A private document stores ordered topic references in a guest file.  Its format is a Mezzano Lisp record:

```lisp
(:mezzano-document 1 :topics ("doc/project-guide.md" "doc/debugger.md#compiler-guarantees"))
```

The reader requires one complete record, a finite proper list of string references, and topics present in the current catalog.  It disables reader evaluation and rejects trailing forms.  References preserve their order, including repeated IDs.  Topic IDs refer to the current catalog.  Displaying them retrieves the current topic text.  The reader accepts this Mezzano format.  Symbolics PSB files are unsupported.

An empty pathname uses `SYS:HOME;PRIVATE.PSB`.  Nonempty names follow guest pathname rules.  A logical pathname beginning with a semicolon, such as `;MY-NOTES.PSB`, is relative to the default HOME directory.  The pathname prompt shows its default, and a second SPACE accepts that default.

Save uses a retained evaluation job.  Repeating its original request after a lost reply returns the same job within the same boot.  Request identity includes the job name, canonical pathname, and original ordered reference strings.  Replay uses those recorded strings even after the catalog changes.  The writer resolves them before opening the file.  Changing the pathname or ordered reference strings under that name reports a conflict.  The browser retains the original request and typed command through reload and replays the original name.  File I/O errors enter the retained debugger.  Save opens with `:if-exists :supersede`.  An I/O error or machine failure during writing can leave an incomplete file.

## Lisp and remote APIs

The `MEZZANO.DOCUMENT-EXAMINER` package exports `LOAD-CATALOG`, `QUERY`, `ASSISTANCE`, `SAVE-PRIVATE-DOCUMENT`, `READ-PRIVATE-DOCUMENT`, and `START-SAVE-PRIVATE-DOCUMENT`.  `QUERY` accepts `:catalog`, `:topic`, `:search`, `:contents`, or `:overview`.  Keyword arguments are `:topic`, `:query`, `:mode`, and `:adjacent`.  Search modes are `:exact`, `:initial`, and `:substring`.  `ASSISTANCE` accepts source text, a character cursor offset, and `:inspect`, `:space`, `:complete`, `:help`, or `:parse`.

SWANK exposes `:document-query`, `:document-assistance`, `:save-private-document`, and `:read-private-document`.  Save takes a retained job name, pathname, and ordered topic list.  Read takes a pathname and returns its canonical namestring and ordered topic summaries.  The HTTP operations use the same names without the colon and JSON strings for actions and modes.  Lisp returns structured topic, block, inline-reference, search, and command-plan records.  Python validates request types and transports them.  The browser renders the records.

The [SWANK API reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md#document-examiner-operations) describes request arguments and returned records.  The [Web interface guide](../tools/swank/web/README.md) describes connecting to the browser interface.

## Compatibility

Documentation comes from the catalog's source documents.  Automatic Lisp-object documentation, Concordia authoring, Listener-to-Background-viewer integration, and full Symbolics keyboard compatibility are unavailable.  Hardcopy uses the browser's print dialog and page layout.
