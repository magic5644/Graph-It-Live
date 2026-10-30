from src.py.used import f_abs
import src.py.used

f_abs()
src.py.used.f_dotted()
from src.py import used as aliased_mod
import src.py.used as dotted_alias

aliased_mod.f_alias()
dotted_alias.f_dotted()
