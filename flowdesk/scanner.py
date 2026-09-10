"""Static Python binding analysis. This module never imports analysed code.

The service launches this file with Python's isolated flag. A parser failure is
therefore bounded to a disposable child process rather than the web server.
"""
from __future__ import annotations

import ast
from collections import Counter
from dataclasses import dataclass
import io
import json
import symtable
import sys
import tokenize


class UnsupportedSyntax(ValueError):
    """A valid construct whose binding semantics this analyser cannot report."""


@dataclass(eq=False)
class Scope:
    name: str
    kind: str
    parent: Scope | None
    table: object | None
    line: int = 1
    anonymous: bool = False

    @property
    def qualified(self):
        if self.parent is None:
            return "<module>"
        prefix = "" if self.parent.parent is None else self.parent.qualified + "."
        return prefix + self.name


class BindingVisitor(ast.NodeVisitor):
    def __init__(self, source, file, table):
        self.source, self.file = source, file
        self.root = Scope("<module>", "module", None, table)
        self.scope = self.root
        self.scopes = [self.root]
        self.bindings = {}

    def table_for(self, node, kind, name):
        if self.scope.table is None:
            return None
        children = self.scope.table.get_children()
        candidates = [t for t in children if t.get_name() == name and t.get_lineno() == node.lineno]
        for table in candidates:
            if table.get_type().value == kind:
                return table
        return None

    def enter(self, node, kind, name, anonymous=False):
        scope = Scope(name, kind, self.scope, self.table_for(node, kind, name), node.lineno, anonymous)
        self.scopes.append(scope)
        self.scope = scope

    def target_scope(self, name, scope=None):
        scope = scope or self.scope
        if scope.kind == "comprehension":
            return scope
        if scope.table is not None:
            try:
                symbol = scope.table.lookup(name)
            except KeyError:
                return scope
            if scope is not self.root and symbol.is_global():
                return self.root
            if symbol.is_nonlocal():
                outer = scope.parent
                while outer and outer is not self.root:
                    if outer.kind in ("function", "lambda") and outer.table is not None:
                        try:
                            candidate = outer.table.lookup(name)
                            if candidate.is_local() or candidate.is_parameter():
                                return outer
                        except KeyError:
                            pass
                    outer = outer.parent
        return scope

    def binding(self, name, node, kind="variable", annotation=None, scope=None, heuristic=False):
        owner = scope or self.target_scope(name)
        if kind == "variable" and owner.kind == "class":
            kind = "class attribute"
        key = (owner, name)
        if key not in self.bindings and len(self.bindings) >= 10000:
            raise ValueError("File exceeds 10,000 detected binding limit.")
        record = self.bindings.setdefault(key, {
            "name": name, "kind": kind, "file": self.file,
            "scope": owner.qualified, "scopeKind": owner.kind,
            "annotation": "unknown", "locations": [], "declarations": [],
        })
        if node is not None:
            location = {"line": node.lineno, "column": node.col_offset}
            if location not in record["locations"]:
                record["locations"].append(location)
        if kind != "variable":
            record["kind"] = kind
        if annotation is not None:
            record["annotation"] = (ast.get_source_segment(self.source, annotation) or ast.unparse(annotation))[:2000]
        if heuristic:
            record["heuristic"] = True
        return record

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Store):
            self.binding(node.id, node)

    def visit_Attribute(self, node):
        if isinstance(node.ctx, ast.Store) and isinstance(node.value, ast.Name) and node.value.id in ("self", "cls"):
            owner = self.scope
            while owner and owner.kind != "class":
                owner = owner.parent
            if owner is not None:
                self.binding(node.value.id + "." + node.attr, node,
                             "instance attribute" if node.value.id == "self" else "class attribute",
                             scope=owner, heuristic=True)
        self.visit(node.value)

    def visit_AnnAssign(self, node):
        if isinstance(node.target, ast.Name):
            self.binding(node.target.id, node.target, annotation=node.annotation)
        else:
            self.visit(node.target)
            if isinstance(node.target, ast.Attribute) and isinstance(node.target.value, ast.Name):
                owner = self.scope
                while owner and owner.kind != "class":
                    owner = owner.parent
                key = (owner, node.target.value.id + "." + node.target.attr)
                if key in self.bindings:
                    self.bindings[key]["annotation"] = (ast.get_source_segment(self.source, node.annotation) or ast.unparse(node.annotation))[:2000]
        if node.value:
            self.visit(node.value)

    def function(self, node):
        if getattr(node, "type_params", []):
            raise UnsupportedSyntax("Generic type-parameter scopes are not supported yet.")
        self.binding(node.name, node, "function")
        for expression in [*node.decorator_list, *node.args.defaults, *node.args.kw_defaults]:
            if expression is not None:
                self.visit(expression)
        self.enter(node, "function", node.name)
        self.parameters(node.args)
        for statement in node.body:
            self.visit(statement)
        self.scope = self.scope.parent

    visit_FunctionDef = function
    visit_AsyncFunctionDef = function

    def parameters(self, args):
        for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg]:
            if arg:
                self.binding(arg.arg, arg, "parameter", arg.annotation)

    def visit_Lambda(self, node):
        for expression in [*node.args.defaults, *node.args.kw_defaults]:
            if expression is not None:
                self.visit(expression)
        self.enter(node, "function", "lambda", anonymous=True)
        self.scope.kind = "lambda"
        self.parameters(node.args)
        self.visit(node.body)
        self.scope = self.scope.parent

    def visit_ClassDef(self, node):
        if getattr(node, "type_params", []):
            raise UnsupportedSyntax("Generic type-parameter scopes are not supported yet.")
        self.binding(node.name, node, "class")
        for expression in [*node.decorator_list, *node.bases, *(kw.value for kw in node.keywords)]:
            self.visit(expression)
        self.enter(node, "class", node.name)
        for statement in node.body:
            self.visit(statement)
        self.scope = self.scope.parent

    def visit_Import(self, node):
        for alias in node.names:
            record = self.binding(alias.asname or alias.name.split(".")[0], alias, "import")
            record["importedFrom"] = alias.name

    def visit_ImportFrom(self, node):
        for alias in node.names:
            if alias.name == "*":
                raise UnsupportedSyntax("Wildcard imports have unresolved bindings; explicit aliases are supported.")
            record = self.binding(alias.asname or alias.name, alias, "import")
            record["importedFrom"] = "." * node.level + (node.module or "") + "." + alias.name

    def declaration(self, node, kind):
        for name in node.names:
            record = self.binding(name, None)
            declaration = {"kind": kind, "scope": self.scope.qualified, "line": node.lineno}
            if declaration not in record["declarations"]:
                record["declarations"].append(declaration)

    def visit_Global(self, node):
        self.declaration(node, "global")

    def visit_Nonlocal(self, node):
        self.declaration(node, "nonlocal")

    def visit_ExceptHandler(self, node):
        if node.name:
            self.binding(node.name, node)
        if node.type:
            self.visit(node.type)
        for statement in node.body:
            self.visit(statement)

    def comprehension(self, node):
        # Even when CPython inlines a comprehension, its iteration bindings do
        # not leak into the containing lexical scope. Model this explicitly.
        self.visit(node.generators[0].iter)
        self.enter(node, "comprehension", "<" + type(node).__name__.lower() + ">", anonymous=True)
        for index, generator in enumerate(node.generators):
            if index:
                self.visit(generator.iter)
            self.visit(generator.target)
            for condition in generator.ifs:
                self.visit(condition)
        if isinstance(node, ast.DictComp):
            self.visit(node.key)
            self.visit(node.value)
        else:
            self.visit(node.elt)
        self.scope = self.scope.parent

    visit_ListComp = comprehension
    visit_SetComp = comprehension
    visit_DictComp = comprehension
    visit_GeneratorExp = comprehension

    def visit_NamedExpr(self, node):
        self.visit(node.value)
        scope = self.scope
        while scope.kind == "comprehension":
            scope = scope.parent
        self.binding(node.target.id, node.target, scope=self.target_scope(node.target.id, scope))

    def visit_MatchAs(self, node):
        if node.name:
            self.binding(node.name, node)
        if node.pattern:
            self.visit(node.pattern)

    def visit_MatchStar(self, node):
        if node.name:
            self.binding(node.name, node)

    def visit_MatchMapping(self, node):
        if node.rest:
            self.binding(node.rest, node)
        self.generic_visit(node)

    def visit_TypeAlias(self, node):
        raise UnsupportedSyntax("Type-alias annotation scopes are not supported yet.")

    def results(self):
        counts = Counter(scope.qualified for scope in self.scopes)
        results = []
        for (owner, name), record in self.bindings.items():
            ancestor = owner
            ambiguous = False
            while ancestor:
                ambiguous |= counts[ancestor.qualified] > 1 or ancestor.anonymous
                ancestor = ancestor.parent
            record["identity"] = json.dumps([self.file, owner.qualified, name], ensure_ascii=True, separators=(",", ":"))
            if ambiguous:
                record["ambiguousIdentity"] = True
                record["identityNote"] = "Anonymous or repeated scope; confirm identity after each scan."
            record["locations"].sort(key=lambda item: (item["line"], item["column"]))
            results.append(record)
        return sorted(results, key=lambda item: (item["scope"], item["name"], item["locations"][0]["line"] if item["locations"] else 0))


def analyze_source(source: str, file: str = "example.py") -> list[dict]:
    """Return lexical binding facts, without evaluating or importing source."""
    tree = ast.parse(source, filename=file, type_comments=True)
    table = symtable.symtable(source, file, "exec")
    visitor = BindingVisitor(source, file, table)
    visitor.visit(tree)
    return visitor.results()


def decode_source(raw: bytes) -> str:
    encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
    return raw.decode(encoding)


def worker():
    try:
        # The supervising process already bounds bytes; this also limits direct
        # invocation of the worker. File contents arrive through stdin only.
        raw = sys.stdin.buffer.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Source exceeds worker input limit.")
        symbols = analyze_source(decode_source(raw), sys.argv[2] if len(sys.argv) > 2 else "source.py")
        result = {"ok": True, "symbols": symbols}
    except (SyntaxError, UnicodeError, ValueError, RecursionError, MemoryError) as exc:
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:2000]}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__" and "--worker" in sys.argv:
    worker()
