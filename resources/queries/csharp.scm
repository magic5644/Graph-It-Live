; C# Tree-sitter query for call graph extraction
; Capture names:
;   @def.function  — method definitions (static or instance)
;   @def.class     — class, struct, record definitions
;   @def.method    — additional method style
;   @def.interface — interface definitions
;   @def.type      — delegate / enum declarations
;   @call          — CALLS relation (method/function invocations)
;   @inherit       — INHERITS relation (base class)
;   @impl          — IMPLEMENTS relation (interfaces)
;   @uses          — USES relation (type references)

; --------------------------------------------------------------------------
; DEFINITIONS
; --------------------------------------------------------------------------

; Class declaration
(class_declaration
  name: (identifier) @def.class)

; Struct declaration  
(struct_declaration
  name: (identifier) @def.class)

; Record declaration
(record_declaration
  name: (identifier) @def.class)

; Interface declaration
(interface_declaration
  name: (identifier) @def.interface)

; Enum declaration
(enum_declaration
  name: (identifier) @def.type)

; Delegate declaration
(delegate_declaration
  name: (identifier) @def.type)

; Method declaration (instance and static)
(method_declaration
  name: (identifier) @def.function)

; Constructor
(constructor_declaration
  name: (identifier) @def.function)

; Property (get/set accessor methods)
(property_declaration
  name: (identifier) @def.variable)

; --------------------------------------------------------------------------
; CALLS
; --------------------------------------------------------------------------

; Direct invocation: Foo()
(invocation_expression
  function: (identifier) @call)

; Member access invocation: obj.Method() — captures method name
(invocation_expression
  function: (member_access_expression
    name: (identifier) @call))

; --------------------------------------------------------------------------
; INHERITS
; --------------------------------------------------------------------------

; Base class in class_declaration: class Foo : Bar
(base_list
  (primary_constructor_base_type
    (identifier) @inherit))

(base_list
  (simple_base_type
    (identifier) @inherit))

; --------------------------------------------------------------------------
; IMPLEMENTS
; --------------------------------------------------------------------------

; Interface in base list — tree-sitter C# does not distinguish base-class from
; interface in base_list, so we capture all base types as @impl if they start
; with a capital letter convention (best-effort for C#)
(base_list
  (simple_base_type
    (identifier) @impl))

; --------------------------------------------------------------------------
; USES (type references in fields, parameters, locals)
; --------------------------------------------------------------------------

; Named type references (e.g. MyService, List<T>)
(identifier) @uses
