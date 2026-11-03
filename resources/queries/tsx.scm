; TSX/JSX additions for call graph extraction (.tsx and .jsx files).
; GraphExtractor appends this file to typescript.scm and compiles both
; against the tsx grammar: only the JSX rules live here.
; Capture names:
;   @jsx — REFERENCES relation from the enclosing symbol to a JSX component
;   @ref — REFERENCES relation to a function or component passed as a JSX attribute value

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

; onClick={save}, render={Row}, as={UI.Link}: passed, not called there. A call written in
; the value (onClick={() => save()}) is a @call at its own line.
(jsx_attribute
  (jsx_expression (identifier) @ref))

(jsx_attribute
  (jsx_expression
    (member_expression
      property: (property_identifier) @ref)))
