; Java Tree-sitter query for call graph extraction
; Capture names:
;   @def.function  — method definitions
;   @def.class     — class declarations
;   @def.interface — interface declarations
;   @def.type      — enum declarations
;   @call          — CALLS relation (method invocations)
;   @inherit       — INHERITS relation (extends)
;   @impl          — IMPLEMENTS relation (implements)
;   @uses          — USES relation (type references)

; --------------------------------------------------------------------------
; DEFINITIONS
; --------------------------------------------------------------------------

; Class declaration
(class_declaration
  name: (identifier) @def.class)

; Interface declaration
(interface_declaration
  name: (identifier) @def.interface)

; Enum declaration
(enum_declaration
  name: (identifier) @def.type)

; Method declaration
(method_declaration
  name: (identifier) @def.function)

; Constructor declaration
(constructor_declaration
  name: (identifier) @def.function)

; --------------------------------------------------------------------------
; CALLS
; --------------------------------------------------------------------------

; Direct method invocation: foo()
(method_invocation
  name: (identifier) @call)

; Object method invocation: obj.method() — captures method name
(method_invocation
  object: (_)
  name: (identifier) @call)

; --------------------------------------------------------------------------
; INHERITS (extends)
; --------------------------------------------------------------------------

; class Foo extends Bar
(superclass
  (type_identifier) @inherit)

; --------------------------------------------------------------------------
; IMPLEMENTS
; --------------------------------------------------------------------------

; class Foo implements IBar, IBaz
(super_interfaces
  (type_list
    (type_identifier) @impl))

; --------------------------------------------------------------------------
; USES (type references)
; --------------------------------------------------------------------------

; Generic type identifiers used in declarations, parameters, fields
(type_identifier) @uses
