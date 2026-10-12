# Document Examiner

The Document Examiner presents the checked-in project documentation through guest Lisp and the Web interface.  The implementation is under test.  The development journal records the tested revisions and outstanding failures.

## Topics and reading

The catalog includes the project guide, debugger design and capability status, remote evaluation guide, Lisp Command Processor, Web interface, SWANK protocol, build and VM operations, font research, development journals, and Mezzano's user and implementation documents.  [Project guide](project-guide.md) maps the work to its source documents.

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
| Hardcopy Viewer | Prints the displayed topics through the browser's print dialog. |

SPACE completes a command word, Tab completes a name, and F12 requests HELP.  Topic names, search terms, and viewer names may contain spaces.  Quoting the complete argument also works.  Commands and topic lookup ignore case.  Topic IDs identify repeated titles without ambiguity.

Topic names are mouse-sensitive.  Mouse-Left displays documentation.  Mouse-Middle displays an overview.  Mouse-Right opens topic operations.  Shift-Middle adds a deferred bookmark when used on a topic and discards a bookmark when used in the Bookmarks pane.  The browser stores topic references and viewer history in tab sessionStorage and fetches documentation bodies from Lisp on reload.

## Searching

Search operates on topic titles and catalog keywords.  Exact matches complete indexed words.  Initial matches word prefixes.  Substring matches within indexed words.  Multiple terms require all terms.  Adjacent search also requires their order and adjacency within one title or keyword phrase.  The interface records the selected mode and adjacency with each candidate list.

The initial default is Substring.  Genera's default uses heuristic stemming.  The original manual gives examples but does not specify the complete stemming algorithm.  That behavior remains unimplemented.  Full-text body search also remains unimplemented.

## APIs and tests

The Lisp package exports `LOAD-CATALOG`, `QUERY`, and `ASSISTANCE`.  `QUERY` accepts `:catalog`, `:topic`, `:search`, `:contents`, or `:overview`.  Keyword arguments are `:topic`, `:query`, `:mode`, and `:adjacent`.  Search modes are `:exact`, `:initial`, and `:substring`.  `ASSISTANCE` accepts source text, a character cursor offset, and `:inspect`, `:space`, `:complete`, `:help`, or `:parse`.

SWANK exposes `:document-query` and `:document-assistance`.  The HTTP operations use the same names without the colon and JSON strings for actions and modes.  Lisp returns structured topic, block, inline-reference, search, and command-plan records.  Python validates request types and transports them.  The browser renders the records.

The implementation must pass guest tests for catalog coverage, hierarchy, lookup ambiguity, search, cross-references, formatting records, and command assistance, followed by HTTP and Chromium tests for reading, search, bookmarks, named viewers, candidate recall, and reload.  Test results belong in the journals after execution.

## Symbolics references and remaining work

The [Genera User's Guide](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Genera-Users-Guide.pdf), Document Examiner chapter, printed pages 2906–2924 in that edition, specifies topic records, the four panes, lookup, candidate searches, overviews, tables of contents, bookmarks, named viewers, and private documents.  The [Genera Workbook](https://bitsavers.trailing-edge.com/pdf/symbolics/software/genera_8/Genera_Workbook.pdf) supplies the introductory walkthrough.  [Genera 8.3 MacIvory captures](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/docex/docex.html) provide the screen reference.

Original stemming, private-document files, Listener-to-Background-viewer integration, Concordia authoring, automatic Lisp-object documentation records, and full Symbolics keyboard compatibility remain unfinished.  Current topics come from the checked-in documents.  Exact visual fidelity requires original-font conversion and measured browser comparison.
