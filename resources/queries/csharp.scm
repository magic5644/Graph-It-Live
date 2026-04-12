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

; Primary constructor base type: record Foo(int X) : Bar(X)
(base_list
  (primary_constructor_base_type
    (identifier) @inherit))

; Simple base class / interface: class Foo : Bar, IFoo
; In tree-sitter-c-sharp 0.20.x base_list directly contains _type nodes —
; there is no 'simple_base_type' wrapper in this grammar version.
(base_list (identifier) @inherit)
(base_list (qualified_name) @inherit)

; --------------------------------------------------------------------------
; IMPLEMENTS
; --------------------------------------------------------------------------

; C# does not distinguish base-class from interface at the AST level.
; Both appear as the same _type nodes directly under base_list.
(base_list (identifier) @impl)
(base_list (qualified_name) @impl)

; --------------------------------------------------------------------------
; USES (type references in fields, parameters, locals)
; --------------------------------------------------------------------------

; Named type references (e.g. MyService, List<T>)
(identifier) @uses
