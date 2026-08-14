import ctypes
from ctypes import wintypes as wt
class F(ctypes.Structure):
    _fields_=[("a",wt.DWORD),("b",wt.FILETIME),("c",wt.FILETIME),("d",wt.FILETIME),("e",wt.DWORD),("f",wt.DWORD),("g",wt.DWORD),("h",wt.DWORD),("n",wt.WCHAR*260),("x",wt.WCHAR*14)]
k=ctypes.windll.kernel32
k.FindFirstFileW.restype=ctypes.c_void_p
k.FindFirstFileW.argtypes=[ctypes.c_wchar_p,ctypes.POINTER(F)]
k.FindNextFileW.restype=wt.BOOL
k.FindNextFileW.argtypes=[ctypes.c_void_p,ctypes.POINTER(F)]
k.FindClose.argtypes=[ctypes.c_void_p]
INVALID=ctypes.c_void_p(-1).value
fd=F(); h=k.FindFirstFileW(r"\\.\pipe\*",ctypes.byref(fd))
names=[]
if h!=INVALID:
    names.append(fd.n)
    while True:
        if not k.FindNextFileW(h,ctypes.byref(fd)): break
        names.append(fd.n)
    k.FindClose(h)
print(','.join(n for n in names if n.startswith('codex-browser-use')))
