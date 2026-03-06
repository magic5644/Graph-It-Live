; Rust Tree-sitter query for call graph extraction
; Capture names:
;   @def.function  — free function definitions
;   @def.class     — struct definitions (analogous to class)
;   @def.method    — impl method definitions
;   @def.type      — type alias declarations
;   @def.interface — trait definitions
;   @call          — CALLS relation (function/method invocations)
;   @impl          — IMPLEMENTS relation (trait impl)
;   @uses          — USES relation (type path references)

; --------------------------------------------------------------------------
; DEFINITIONS
; --------------------------------------------------------------------------

; Free function
(function_item
  name: (identifier) @def.function)

; Struct (treated as class-like entity)
(struct_item
  name: (type_identifier) @def.class)

; Enum
(enum_item
  name: (type_identifier) @def.class)

; Trait definition (interface-like)
(trait_item
  name: (type_identifier) @def.interface)

; Type alias
(type_item
  name: (type_identifier) @def.type)

; Methods inside impl blocks
(impl_item
  body: (declaration_list
    (function_item
      name: (identifier) @def.method)))

; --------------------------------------------------------------------------
; CALLS
; --------------------------------------------------------------------------

; Direct function call: foo()
(call_expression
  function: (identifier) @call)

; Method call: self.method()
(call_expression
  function: (field_expression
    field: (field_identifier) @call))

; Scoped/path call: Foo::bar() or std::collections::HashMap::new()
(call_expression
  function: (scoped_identifier
    name: (identifier) @call))

; --------------------------------------------------------------------------
; IMPLEMENTS (trait impl)
; --------------------------------------------------------------------------

; impl Trait for Type { ... }
(impl_item
  trait: (type_identifier) @impl)

; impl crate::module::Trait for Type { ... }
(impl_item
  trait: (scoped_type_identifier
    name: (type_identifier) @impl))

; --------------------------------------------------------------------------
; USES (type references)
; --------------------------------------------------------------------------

; Simple type identifier in signatures/fields
(type_identifier) @uses

; Scoped type path (e.g. std::sync::Arc, crate::services::MyService)
(scoped_type_identifier
  name: (type_identifier) @uses)
