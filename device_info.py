"""Read the active Windows display modes and physical panel sizes locally."""
import ctypes
from ctypes import wintypes
import math
import os


class DisplayDevice(ctypes.Structure):
    _fields_ = [
        ("size", wintypes.DWORD), ("name", wintypes.WCHAR * 32),
        ("description", wintypes.WCHAR * 128), ("flags", wintypes.DWORD),
        ("interface", wintypes.WCHAR * 128), ("key", wintypes.WCHAR * 128),
    ]


class DisplayMode(ctypes.Structure):
    # Display branch of the public DEVMODEW unions.
    _fields_ = [
        ("name", wintypes.WCHAR * 32), ("specVersion", wintypes.WORD),
        ("driverVersion", wintypes.WORD), ("size", wintypes.WORD),
        ("driverExtra", wintypes.WORD), ("fields", wintypes.DWORD),
        ("x", wintypes.LONG), ("y", wintypes.LONG),
        ("orientation", wintypes.DWORD), ("fixedOutput", wintypes.DWORD),
        ("color", ctypes.c_short), ("duplex", ctypes.c_short),
        ("yResolution", ctypes.c_short), ("ttOption", ctypes.c_short),
        ("collate", ctypes.c_short), ("formName", wintypes.WCHAR * 32),
        ("logPixels", wintypes.WORD), ("bitsPerPel", wintypes.DWORD),
        ("width", wintypes.DWORD), ("height", wintypes.DWORD),
        ("displayFlags", wintypes.DWORD), ("frequency", wintypes.DWORD),
        ("icmMethod", wintypes.DWORD), ("icmIntent", wintypes.DWORD),
        ("mediaType", wintypes.DWORD), ("ditherType", wintypes.DWORD),
        ("reserved1", wintypes.DWORD), ("reserved2", wintypes.DWORD),
        ("panningWidth", wintypes.DWORD), ("panningHeight", wintypes.DWORD),
    ]


def physical_size(interface):
    import winreg

    parts = interface.split("#")
    if len(parts) < 4 or not parts[1] or not parts[2]:
        return None, None
    path = rf"SYSTEM\CurrentControlSet\Enum\DISPLAY\{parts[1]}\{parts[2]}\Device Parameters"
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            edid, _ = winreg.QueryValueEx(key, "EDID")
    except OSError:
        return None, None
    if not isinstance(edid, bytes) or len(edid) < 128 or edid[:8] != bytes.fromhex("00ffffffffffff00"):
        return None, None
    width, height = edid[21:23]
    return (width, height) if width and height else (None, None)


def read_displays():
    if os.name != "nt":
        return []
    user32 = ctypes.windll.user32
    enum_devices = user32.EnumDisplayDevicesW
    enum_devices.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(DisplayDevice), wintypes.DWORD]
    enum_settings = user32.EnumDisplaySettingsW
    enum_settings.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(DisplayMode)]

    def devices(adapter, flags):
        index = 0
        while True:
            device = DisplayDevice(size=ctypes.sizeof(DisplayDevice))
            if not enum_devices(adapter, index, ctypes.byref(device), flags):
                break
            yield device
            index += 1

    displays = []
    attached, primary, interface_name = 1, 4, 1
    for adapter in devices(None, 0):
        if not adapter.flags & attached:
            continue
        mode = DisplayMode(size=ctypes.sizeof(DisplayMode))
        if not enum_settings(adapter.name, 0xFFFFFFFF, ctypes.byref(mode)):
            continue
        monitors = [monitor for monitor in devices(adapter.name, interface_name) if monitor.flags & attached]
        for monitor in monitors or [None]:
            width, height = physical_size(monitor.interface) if monitor else (None, None)
            if mode.orientation in (1, 3):
                width, height = height, width
            displays.append({
                "widthCm": width, "heightCm": height,
                "diagonalInches": round(math.hypot(width, height) / 2.54, 1) if width and height else None,
                "resolutionWidth": mode.width, "resolutionHeight": mode.height,
                "primary": bool(adapter.flags & primary),
            })
    return displays
