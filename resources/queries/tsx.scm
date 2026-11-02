; TSX/JSX additions for call graph extraction (.tsx and .jsx files).
; GraphExtractor appends this file to typescript.scm and compiles both
; against the tsx grammar: only the JSX rules live here.
; Capture names:
;   @jsx — USES relation from the enclosing symbol to a JSX component

; <Card /> and <Card>…</Card>: a lowercase first letter is an intrinsic element
; (<main>, <my-element>), as in React, so it gets no edge.
(jsx_opening_element
  name: (identifier) @jsx
  (#not-match? @jsx "^[a-z]"))

(jsx_self_closing_element
  name: (identifier) @jsx
  (#not-match? @jsx "^[a-z]"))

; <UI.Card /> and <UI.Card>…</UI.Card>: a member expression is always a component.
(jsx_opening_element
  name: (member_expression
    property: (property_identifier) @jsx))

(jsx_self_closing_element
  name: (member_expression
    property: (property_identifier) @jsx))
