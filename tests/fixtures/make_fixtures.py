#!/usr/bin/env python3
"""Regenerate the small test images in this folder (needs Pillow >= 11).

    python3 tests/fixtures/make_fixtures.py

All personal-looking data here is fake. The GPS position is the Eiffel Tower.
"""
import struct
from pathlib import Path

from PIL import Image, ImageDraw
from PIL.PngImagePlugin import PngInfo

HERE = Path(__file__).resolve().parent

LAT = (48.0, 51.0, 29.13)   # 48.858092 N
LON = (2.0, 17.0, 40.2)     # 2.294500 E

XMP = (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"'
    ' xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"'
    ' photoshop:City="Paris" xmp:CreatorTool="Fixture Maker 1.0">'
    '<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>'
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
)


def picture(w=120, h=80):
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for x in range(w):
        d.line([(x, 0), (x, h)], fill=((x * 2) % 256, 120, 255 - (x * 2) % 256))
    d.ellipse([w // 3, h // 4, w // 3 + h // 2, h // 4 + h // 2], fill=(250, 220, 60))
    return img


def exif(orientation=None):
    ex = Image.Exif()
    ex[0x010F] = 'Apple'
    ex[0x0110] = 'iPhone 15 Pro'
    ex[0x0131] = '18.1'
    ex[0x0132] = '2026:11:07 18:30:12'
    ex[0x013B] = 'Jane Doe'
    if orientation:
        ex[0x0112] = orientation
    ex[0x8769] = {
        0x9003: '2026:11:07 18:30:12',
        0x9011: '+01:00',
        0xA431: 'SN-0042-TEST',
        0xA434: 'iPhone 15 Pro back camera 6.86mm f/1.78',
        0x829A: 0.01,
        0x8827: 100,
    }
    ex[0x8825] = {
        0x0001: 'N', 0x0002: LAT,
        0x0003: 'E', 0x0004: LON,
        0x0006: 35.0,
    }
    return ex


def iptc_app13():
    def ds(num, text):
        data = text.encode()
        return bytes([0x1C, 2, num]) + struct.pack('>H', len(data)) + data
    iptc = ds(90, 'Paris') + ds(80, 'Jane Doe')
    if len(iptc) % 2:
        iptc += b'\0'
    res = b'8BIM' + struct.pack('>H', 0x0404) + b'\0\0' + struct.pack('>I', len(iptc)) + iptc
    body = b'Photoshop 3.0\0' + res
    return b'\xFF\xED' + struct.pack('>H', len(body) + 2) + body


def insert_after_soi(jpeg, segment):
    return jpeg[:2] + segment + jpeg[2:]


def main():
    # JPEG with EXIF + GPS, XMP, comment, IPTC and a fake motion-photo video at the end
    picture().save(HERE / 'gps.jpg', 'JPEG', quality=90, exif=exif(), xmp=XMP.encode(), comment=b'Taken at home')
    data = (HERE / 'gps.jpg').read_bytes()
    data = insert_after_soi(data, iptc_app13())
    data += b'\0\0\0\x18ftypmp42\0\0\0\0mp42isom' + bytes(range(256)) * 4
    (HERE / 'gps.jpg').write_bytes(data)

    # JPEG stored sideways (120x60) with Orientation=6: should display as 60x120
    img = Image.new('RGB', (120, 60), (220, 30, 30))
    ImageDraw.Draw(img).rectangle([60, 0, 120, 60], fill=(30, 30, 220))
    img.save(HERE / 'rotated.jpg', 'JPEG', quality=92, exif=exif(orientation=6))

    # PNG with text chunks, eXIf (GPS), XMP and a modification time
    info = PngInfo()
    info.add_text('Author', 'Jane Doe')
    info.add_text('Comment', 'Kitchen window')
    info.add_itxt('XML:com.adobe.xmp', XMP)
    info.add(b'tIME', struct.pack('>HBBBBB', 2026, 11, 7, 18, 30, 12))
    picture().save(HERE / 'text.png', 'PNG', pnginfo=info, exif=exif())

    # WebP with EXIF + XMP
    picture().save(HERE / 'exif.webp', 'WEBP', quality=80, exif=exif(), xmp=XMP.encode())

    # A photo with no metadata at all
    picture().save(HERE / 'plain.jpg', 'JPEG', quality=90)

    for p in sorted(HERE.glob('*.*')):
        if p.suffix != '.py':
            print(f'{p.name:12} {p.stat().st_size:6} bytes')


if __name__ == '__main__':
    main()
