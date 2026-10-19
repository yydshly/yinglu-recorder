"""Generate small geometric app icons without external image dependencies."""
import struct
import zlib
from pathlib import Path

root = Path(__file__).resolve().parent.parent / 'icons'
root.mkdir(exist_ok=True)
def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
for size in (16, 48, 128):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            nx, ny = x / size, y / size
            color = (33, 92, 72, 255)
            if .20 < nx < .80 and .24 < ny < .76 and (nx < .27 or nx > .73 or ny < .31 or ny > .69):
                color = (245, 245, 239, 255)
            if (nx - .50) ** 2 + (ny - .50) ** 2 < .012:
                color = (239, 144, 115, 255)
            row.extend(color)
        rows.append(b'\0' + row)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')
    (root / f'{size}.png').write_bytes(data)
