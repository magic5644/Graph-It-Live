; Go Tree-sitter query for call graph extraction
; Capture names:
;   @def.function  — top-level function definitions
;   @def.method    — method definitions on types
;   @def.class     — struct type definitions
;   @def.interface — interface type definitions
;   @def.type      — type alias declarations
;   @call          — CALLS relation (function/method invocations)
;   @inherit       — INHERITS relation (embedded types)
;   @impl          — IMPLEMENTS relation (interface satisfaction via method sets)
;   @uses          — USES relation (type references)

; --------------------------------------------------------------------------
; DEFINITIONS
; --------------------------------------------------------------------------

; Top-level function declaration
(function_declaration
  name: (identifier) @def.function)

; Method declaration (with receiver)
(method_declaration
  name: (field_identifier) @def.method)

; Struct type declaration
(type_declaration
  (type_spec
    name: (type_identifier) @def.class
    type: (struct_type)))

; Interface type declaration
(type_declaration
  (type_spec
    name: (type_identifier) @def.interface
    type: (interface_type)))

; Other type alias declarations
(type_declaration
  (type_spec
    name: (type_identifier) @def.type))

; --------------------------------------------------------------------------
; CALLS
; --------------------------------------------------------------------------

; Direct function call: foo()
(call_expression
  function: (identifier) @call)

; Method/selector call: obj.Method()
(call_expression
  function: (selector_expression
    field: (field_identifier) @call))

; --------------------------------------------------------------------------
; INHERITS (embedded struct fields)
; --------------------------------------------------------------------------

; Struct embedding (anonymous field): type Foo struct { Bar }
(struct_type
  (field_declaration_list
    (field_declaration
      type: (type_identifier) @inherit)))

; --------------------------------------------------------------------------
; USES (type references)
; --------------------------------------------------------------------------

; Type identifiers used in declarations, parameters, variables
(type_identifier) @uses
