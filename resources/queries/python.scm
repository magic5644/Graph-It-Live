; Python Tree-sitter query for call graph extraction
; Capture names:
;   @def.function  — top-level function definitions
;   @def.class     — class definitions
;   @def.method    — method definitions inside classes
;   @call          — CALLS relation (function/method invocations)
;   @ref           — REFERENCES relation (a function passed as an argument, not called there)
;   @inherit       — INHERITS relation (class base classes)
;   @uses          — USES relation (attribute access as module/symbol reference)

; --------------------------------------------------------------------------
; DEFINITIONS
; --------------------------------------------------------------------------

; Top-level function definition
(function_definition
  name: (identifier) @def.function)

; Class definition
(class_definition
  name: (identifier) @def.class)

; Methods inside classes (indented function_definition under a block)
(class_definition
  body: (block
    (function_definition
      name: (identifier) @def.method)))

; --------------------------------------------------------------------------
; CALLS
; --------------------------------------------------------------------------

; Direct function call: foo()
(call
  function: (identifier) @call)

; Method/attribute call: obj.method()
(call
  function: (attribute
    attribute: (identifier) @call))

; --------------------------------------------------------------------------
; INHERITS (class bases)
; --------------------------------------------------------------------------

; class Foo(Base): — simple identifier base
; Note: field name omitted for cross-version grammar compatibility (some grammars
; use 'superclasses', others 'bases'). Matching argument_list as a direct child
; of class_definition is unambiguous.
(class_definition
  (argument_list
    (identifier) @inherit))

; class Foo(module.Base): — attribute access base
(class_definition
  (argument_list
    (attribute
      attribute: (identifier) @inherit)))

; --------------------------------------------------------------------------
; USES (attribute access as dependency reference)
; --------------------------------------------------------------------------

; module.symbol references (e.g. typing.Optional, collections.OrderedDict)
(attribute
  object: (identifier) @uses)

; register(save), register(mod.save), register(cb=save): a function passed, not called there.
(argument_list (identifier) @ref)

(argument_list
  (attribute
    attribute: (identifier) @ref))

(keyword_argument
  value: (identifier) @ref)

(keyword_argument
  value: (attribute
    attribute: (identifier) @ref))
