import py_compile
import sys

files = [sys.argv[1]]
for f in files:
    try:
        py_compile.compile(f, doraise=True)
        print(f"OK: {f}")
    except py_compile.PyCompileError as e:
        print(f"FAIL: {f} -> {e}")
        sys.exit(1)
