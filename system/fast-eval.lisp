;;;; The fast evaluator, passes most forms to the compiler

(in-package :mezzano.fast-eval)

(defparameter *lazy-lambda-evaluation* nil)

;; Rather than immediately compiling lambda forms, we can defer compilation
;; until the form is called, and compile then.
(defclass lazy-eval-function ()
  ((form :initarg :form :reader lazy-eval-function-form)
   (env :initarg :env :reader lazy-eval-function-env)
   (pathname :initarg :pathname :reader lazy-eval-function-pathname)
   (tlf :initarg :tlf :reader lazy-eval-function-tlf)
   (function :initform nil))
  (:metaclass mezzano.clos:funcallable-standard-class))

(defun lazy-eval-function-function (lazy-eval-function)
  (with-slots (function) lazy-eval-function
    (cond ((eql function :in-progress)
           ;; This function is being compiled but the compiler is being invoked
           ;; recursively on it, fall back to full-eval to avoid a recursive
           ;; call into the compiler.
           (mezzano.full-eval:eval-in-lexenv
            (lazy-eval-function-form lazy-eval-function)
            (lazy-eval-function-env lazy-eval-function)))
          (function
           ;; Already compiled.
           function)
          (t
           (setf function :in-progress)
           (let ((new-function
                   (let ((*compile-file-pathname*
                           (lazy-eval-function-pathname lazy-eval-function))
                         (mezzano.internals::*top-level-form-number*
                           (lazy-eval-function-tlf lazy-eval-function)))
                     (eval-compile (lazy-eval-function-form lazy-eval-function)
                                   (lazy-eval-function-env lazy-eval-function)))))
             (mezzano.clos:set-funcallable-instance-function
              lazy-eval-function new-function)
             (setf function new-function))))))

(defmethod make-load-form ((function lazy-eval-function) &optional environment)
  (declare (ignore environment))
  (list 'quote (lazy-eval-function-function function)))

(defmethod mezzano.internals::funcallable-instance-lambda-expression ((function lazy-eval-function))
  (function-lambda-expression
   (lazy-eval-function-function function)))

(defmethod mezzano.internals::funcallable-instance-debug-info ((function lazy-eval-function))
  (mezzano.internals::function-debug-info
   (lazy-eval-function-function function)))

(defmethod mezzano.internals::funcallable-instance-compiled-function-p ((function lazy-eval-function))
  t)

(defmethod mezzano.debug:function-lambda-list ((function lazy-eval-function))
  (mezzano.debug:function-lambda-list
   (lazy-eval-function-function function)))

(defmethod mezzano.debug:function-source-location ((function lazy-eval-function) &key offset)
  (mezzano.debug:function-source-location
   (lazy-eval-function-function function)
   :offset offset))

(defun eval-compile (form env)
  (let ((mezzano.compiler::*load-time-value-hook* 'mezzano.compiler::eval-load-time-value)
        (*compile-file-pathname* (or *compile-file-pathname*
                                     *load-pathname*)))
    (funcall
     (handler-case
         (mezzano.compiler::compile-lambda
          `(lambda () (progn ,form))
          env)
       (error ()
         ;; If we fail to compile, then fall back on the interpreter
         (mezzano.full-eval:eval-in-lexenv
          `(lambda () (progn ,form))
          env))))))

(defun eval-progn-body (forms env)
  (do ((itr forms (cdr itr)))
      ((null (cdr itr))
       (eval-in-lexenv (car itr) env))
    (eval-in-lexenv (car itr) env)))

(defun eval-one-setq (var val env)
  (check-type var symbol)
  (multiple-value-bind (expansion expandedp)
      (macroexpand-1 var)
    (declare (ignore expansion))
    (cond (expandedp
           (eval-in-lexenv `(setf ,var ,val) env))
          (t (setf (symbol-value var) (eval-in-lexenv val env))))))

(defun eval-setq (pairs env)
  (destructuring-bind (var val &rest rest)
      pairs
    (cond (rest
           (eval-one-setq var val env)
           (eval-setq rest env))
          (t (eval-one-setq var val env)))))

(defun invoke-lazy-function (instance args)
  (apply (lazy-eval-function-function instance) args))

(defun eval-cons (form env)
  (case (first form)
    ((if)
     (destructuring-bind (test-form then-form &optional else-form)
         (rest form)
       (if (eval-in-lexenv test-form env)
           (eval-in-lexenv then-form env)
           (eval-in-lexenv else-form env))))
    ((quote)
     (destructuring-bind (value)
         (rest form)
       value))
    ((function)
     (destructuring-bind (name)
         (rest form)
       (cond ((and (consp name)
                   (eql (first name) 'lambda))
              (if *lazy-lambda-evaluation*
                  (let ((instance (make-instance 'lazy-eval-function
                                                 :form name
                                                 :env env
                                                 :pathname (or *compile-file-pathname*
                                                               *load-pathname*)
                                                 :tlf mezzano.internals::*top-level-form-number*)))
                    (mezzano.clos:set-funcallable-instance-function
                     instance (lambda (&rest args)
                                (invoke-lazy-function instance args)))
                    instance)
                  (eval-compile form env)))
             (t (fdefinition name)))))
    ((progn)
     (eval-progn-body (rest form) env))
    ((eval-when)
     (destructuring-bind (situations &body body)
         (rest form)
       (multiple-value-bind (compile load eval)
           (mezzano.internals::parse-eval-when-situation situations)
         (declare (ignore compile load))
         (when eval
           (eval-progn-body body env)))))
    ((multiple-value-call)
     (destructuring-bind (function-form &rest forms)
         (rest form)
       (apply (eval-in-lexenv function-form env)
              (apply #'append
                     (mapcar (lambda (f)
                               (multiple-value-list (eval-in-lexenv f env)))
                             forms)))))
    ((multiple-value-prog1)
     (destructuring-bind (first-form &rest forms)
         (rest form)
       (multiple-value-prog1
           (eval-in-lexenv first-form env)
         (eval-progn-body forms env))))
    ((catch)
     (destructuring-bind (tag &body body)
         (rest form)
       (catch (eval-in-lexenv tag env)
         (eval-progn-body body env))))
    ((throw)
     (destructuring-bind (tag result-form)
         (rest form)
       (throw (eval-in-lexenv tag env)
         (eval-in-lexenv result-form env))))
    ((progv)
     (destructuring-bind (symbols values &body body)
         (rest form)
       (progv (eval-in-lexenv symbols env) (eval-in-lexenv values env)
         (eval-progn-body body env))))
    ;;((macrolet))
    ;;((symbol-macrolet))
    ((setq)
     (when (rest form)
       (eval-setq (rest form) env)))
    ((unwind-protect)
     (destructuring-bind (protected-form &rest cleanup-forms)
         (rest form)
       (unwind-protect
            (eval-in-lexenv protected-form env)
         (eval-progn-body cleanup-forms env))))
    ((load-time-value)
     (destructuring-bind (form &optional read-only-p)
         (rest form)
       (declare (ignore read-only-p))
       (eval-in-lexenv form env)))
    (t (cond ((or (not (symbolp (first form)))
                  (special-operator-p (first form)))
              (eval-compile form env))
             (t (multiple-value-bind (expansion expanded-p)
                    (macroexpand form env)
                  (cond (expanded-p
                         (eval-in-lexenv expansion env))
                        (t
                         (eval-call form env)))))))))

(defun eval-call (form env)
  ;; Don't use FDEFINITION, poke directly in the fref to stop trace wrappers
  ;; from being hidden.
  (let ((fn (mezzano.internals::function-reference-function
             (mezzano.internals::function-reference (first form)))))
    (cond (fn
           (apply fn
                  (mapcar (lambda (f) (eval-in-lexenv f env))
                          (rest form))))
          (t
           ;; Punt if the function is not bound, take advantage
           ;; of the restarts set up by the runtime.
           (eval-compile form env)))))

(defun eval-symbol (form env)
  (let ((expanded (macroexpand form env)))
    (cond ((symbolp expanded)
           (restart-case (symbol-value expanded)
             (use-value (v)
               :interactive (lambda ()
                              (format t "Enter a new value (evaluated): ")
                              (list (eval (read))))
               :report (lambda (s) (format s "Input a value to be used in place of ~S." form))
               v)
             (store-value (v)
               :interactive (lambda ()
                              (format t "Enter a new value (evaluated): ")
                              (list (eval (read))))
               :report (lambda (s) (format s "Input a new value for ~S." form))
               (setf (symbol-value form) v))))
          (t (eval-in-lexenv expanded env)))))

(defun eval-in-lexenv (form env)
  (typecase form
    (cons (eval-cons form env))
    (symbol (eval-symbol form env))
    (t form)))
