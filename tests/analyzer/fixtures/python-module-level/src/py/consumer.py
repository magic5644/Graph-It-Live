from .used import f_toplevel, f_main_guard, f_class_body, f_in_fn, f_decorator_arg, f_default_arg, f_comp, f_imported_unused, f_value_only
from . import used


def deco(value):
    return lambda fn: fn


class K:
    v = f_class_body()


def run():
    return f_in_fn()


@deco(f_decorator_arg())
def decorated(): pass


def with_default(x=f_default_arg()): pass


f_toplevel()
used.f_modattr()
squares = [f_comp(i) for i in range(3)]
# f_string_only() is only mentioned in a comment and in "f_string_only()"
if __name__ == '__main__':
    f_main_guard()
handlers = [f_value_only]
