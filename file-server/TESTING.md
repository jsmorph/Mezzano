# Host file-server tests

The fixture runs in a fresh SBCL process and uses automatically assigned loopback ports.  It does not connect to a running file server or guest.  The build directory must contain the existing Quicklisp installation.

From the build directory:

```sh
cd Mezzano/file-server
sbcl --non-interactive --load ../../quicklisp/setup.lisp \
  --eval '(push (truename ".") asdf:*central-registry*)' \
  --eval '(asdf:load-system "lispos-file")' \
  --eval '(multiple-value-bind (file warnings failure)
              (compile-file "test-concurrent-clients.lisp")
            (assert (and file (not warnings) (not failure)))
            (load file))' \
  --eval '(file-server-concurrency-test:run)'
```

The tests cover concurrent clients with independent file handles and data, protocol errors and QUIT, configured idle expiration, shutdown with idle clients, worker creation failure, shutdown during worker startup, disconnected clients, unexpected worker errors, and cleanup failures.  Unexpected-error cases check the original condition objects.  Cleanup checks cover accepted sockets, worker threads, and opened files.

The fixture targets the SBCL backend.  It does not establish concurrent service for the non-SBCL backend.
