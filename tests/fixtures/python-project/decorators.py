# Python decorators
from functools import wraps

def my_decorator(func):
    """Simple decorator"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        print("Before")
        result = func(*args, **kwargs)
        print("After")
        return result
    return wrapper

@my_decorator
def decorated_function():
    """Function with decorator"""
    return "result"

class MyClass:
    @property
    def my_property(self):
        """Property decorator"""
        return self._value
    
    @staticmethod
    def static_method():
        """Static method"""
        return "static"
    
    @classmethod
    def class_method(cls):
        """Class method"""
        return cls

@my_decorator
class DecoratedClass:
    """Class with decorator"""
    pass
