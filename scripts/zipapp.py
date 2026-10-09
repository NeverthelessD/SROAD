#!/usr/bin/env python3
"""Zip a .app bundle keeping Unix permissions (executables stay executable after unzip on macOS).
usage: zipapp.py <base dir> <SROAD.app> <out.zip>"""
import os
import stat
import sys
import zipfile

base, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
root = os.path.join(base, name)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for dp, dn, fn in os.walk(root):
        dn.sort()
        rel = os.path.relpath(dp, base)
        info = zipfile.ZipInfo(rel + "/")
        info.create_system = 3
        info.external_attr = ((stat.S_IFDIR | 0o755) << 16) | 0x10
        z.writestr(info, b"")
        for f in sorted(fn):
            p = os.path.join(dp, f)
            info = zipfile.ZipInfo.from_file(p, os.path.relpath(p, base))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            mode = 0o755 if os.access(p, os.X_OK) else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            with open(p, "rb") as fh:
                z.writestr(info, fh.read())
