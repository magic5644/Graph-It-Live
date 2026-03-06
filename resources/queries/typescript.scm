; TypeScript/JavaScript Tree-sitter query for call graph extraction
; Capture names:
;   @def.function  — top-level function declarations
;   @def.method    — class method definitions
;   @def.class     — class declarations
;   @def.interface — interface declarations
;   @def.type      — type alias declarations
;   @def.variable  — exported const/let/var declarations
;   @call          — CALLS relation (function/method invocations)
;   @inherit       — INHERITS relation (extends clause)
;   @impl          — IMPLEMENTS relation (implements clause)
;   @uses          — USES relation (type references)

; --------------------------------------------------------------------------
; DEFINITIONS
; --------------------------------------------------------------------------

; Top-level function declarations
(function_declaration
  name: (identifier) @def.function)

; Arrow function assigned to a const (exported or not)
(lexical_declaration
  (variable_declarator
    name: (identifier) @def.variable
    value: (arrow_function)))

(variable_declaration
  (variable_declarator
    name: (identifier) @def.variable
    value: (arrow_function)))

; Class declarations
(class_declaration
  name: (type_identifier) @def.class)

; Method definitions inside classes
(method_definition
  name: (property_identifier) @def.method)

; Interface declarations
(interface_declaration
  name: (type_identifier) @def.interface)

; Type alias declarations
(type_alias_declaration
  name: (type_identifier) @def.type)

; --------------------------------------------------------------------------
; CALLS
; --------------------------------------------------------------------------

; Simple function call: foo()
(call_expression
  function: (identifier) @call)

; Method call: obj.method()
(call_expression
  function: (member_expression
    property: (property_identifier) @call))

; Constructor call: new Foo()
(new_expression
  constructor: (identifier) @call)

; Constructor call: new ns.Foo()
(new_expression
  constructor: (member_expression
    property: (property_identifier) @call))

; --------------------------------------------------------------------------
; INHERITS (class extends)
; --------------------------------------------------------------------------

; class Foo extends Bar
(class_heritage
  (extends_clause
    value: (identifier) @inherit))

; class Foo extends ns.Bar
(class_heritage
  (extends_clause
    value: (member_expression
      property: (property_identifier) @inherit)))

; --------------------------------------------------------------------------
; IMPLEMENTS (TypeScript class implements)
; --------------------------------------------------------------------------

; class Foo implements IFoo
(class_heritage
  (implements_clause
    (type_identifier) @impl))

; --------------------------------------------------------------------------
; USES (type references)
; --------------------------------------------------------------------------

; Type identifiers in annotations (e.g. param: MyType, return: MyType)
(type_identifier) @uses

; Generic type params: Array<MyType>
(generic_type
  name: (type_identifier) @uses)
