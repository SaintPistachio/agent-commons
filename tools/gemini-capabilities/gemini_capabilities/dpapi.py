"""Windows DPAPI (CurrentUser) protection for the Gemini API key. Fails closed elsewhere."""
import ctypes
import sys
from ctypes import wintypes

CRYPTPROTECT_UI_FORBIDDEN = 0x1


class HelperError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data):
    buffer = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))), buffer


def _call(name, data):
    if sys.platform != "win32":
        raise HelperError("dpapi_unavailable", "Protected key storage requires Windows DPAPI")
    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    source, _keep = _blob(data)
    out = _Blob()
    if name == "protect":
        ok = crypt32.CryptProtectData(ctypes.byref(source), "agent-commons-gemini", None, None, None,
                                      CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out))
    else:
        ok = crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None,
                                        CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out))
    if not ok:
        raise HelperError("dpapi_failed", "Windows could not " + ("protect" if name == "protect" else "unprotect") + " the key")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def protect(data: bytes) -> bytes:
    return _call("protect", data)


def unprotect(data: bytes) -> bytes:
    return _call("unprotect", data)
