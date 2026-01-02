# Classes with inheritance
from typing import List

class Animal:
    """Base animal class"""
    def __init__(self, name: str):
        self.name = name
    
    def speak(self) -> str:
        """Make a sound"""
        return "Some sound"
    
    def _private_method(self):
        """Private method"""
        pass

class Dog(Animal):
    """Dog class inheriting from Animal"""
    def __init__(self, name: str, breed: str):
        super().__init__(name)
        self.breed = breed
    
    def speak(self) -> str:
        """Override speak method"""
        result = self._format_sound("Woof")
        return result
    
    def _format_sound(self, sound: str) -> str:
        """Private helper method"""
        return f"{self.name} says {sound}"

def create_dog(name: str) -> Dog:
    """Factory function for creating dogs"""
    dog = Dog(name, "Unknown")
    return dog
