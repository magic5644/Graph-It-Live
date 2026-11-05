; TypeScript/JavaScript Tree-sitter query for call graph extraction
; Capture names:
;   @def.function  — function declarations and function-valued const/let/var
;   @def.method    — class method definitions
;   @def.class     — class declarations
;   @def.interface — interface declarations
;   @def.type      — type alias declarations
;   @call          — CALLS relation (function/method invocations)
;   @ref           — REFERENCES relation (a function passed as an argument, not called there)
;   @lazy          — REFERENCES relation to the default export `lazy(() => import('./m'))` loads
;   @inherit       — INHERITS relation (extends clause)
;   @impl          — IMPLEMENTS relation (implements clause)
;   @uses          — USES relation (type references)

; --------------------------------------------------------------------------
; DEFINITIONS
; --------------------------------------------------------------------------

; Top-level function declarations
(function_declaration
  name: (identifier) @def.function)

; Arrow function or function expression assigned to a const/let/var
; (exported or not): a function, like the SymbolAnalyzer category
(lexical_declaration
  (variable_declarator
    name: (identifier) @def.function
    value: [(arrow_function) (function_expression)]))

(variable_declaration
  (variable_declarator
    name: (identifier) @def.function
    value: [(arrow_function) (function_expression)]))

; React component factories assigned to a const/let/var: `const Card = memo(...)`,
; `forwardRef(...)`, `lazy(...)`, bare or as `React.*`. The component is the variable.
(lexical_declaration
  (variable_declarator
    name: (identifier) @def.function
    value: (call_expression
      function: [(identifier) (member_expression)] @_factory))
  (#match? @_factory "^(React\\.)?(memo|forwardRef|lazy)$"))

(variable_declaration
  (variable_declarator
    name: (identifier) @def.function
    value: (call_expression
      function: [(identifier) (member_expression)] @_factory))
  (#match? @_factory "^(React\\.)?(memo|forwardRef|lazy)$"))

; Class declarations
(class_declaration
  name: (type_identifier) @def.class)

(abstract_class_declaration
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

; lazy(() => import('./Card')): the component is the module's default export.
; A non-literal specifier is not captured: it stays unresolved.
(call_expression
  function: [(identifier) (member_expression)] @_lazy
  arguments: (arguments
    (arrow_function
      body: (call_expression
        function: (import)
        arguments: (arguments (string (string_fragment) @lazy)))))
  (#match? @_lazy "^(React\\.)?lazy$"))

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

; register(save), items.map(format), new Worker(run), register(this.save): a function or
; value passed, not called there. A call written in the argument (register(save())) is a @call.
(arguments (identifier) @ref)

(arguments
  (member_expression
    property: (property_identifier) @ref))
