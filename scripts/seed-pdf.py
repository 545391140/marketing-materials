"""Build distributable, original sample PDFs with selectable Chinese text."""
import sys, json, io, base64, textwrap
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase import pdfmetrics
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
files = {}
for material in json.load(sys.stdin):
    for f in material['files']:
        if f['ext'] != 'pdf': continue
        b=io.BytesIO(); c=Canvas(b,pagesize=A4,invariant=1); c.setTitle(material['title'])
        for page,lines in enumerate([f['preview'].splitlines()[:5], f['preview'].splitlines()[5:]]):
            c.setFillColorRGB(.04,.15,.25); c.rect(0,700,600,145,fill=1,stroke=0)
            c.setFillColorRGB(1,1,1); c.setFont('Helvetica',11); c.drawString(48,792,'PARTNER CENTER   /   FIELD NOTES')
            c.setFont('STSong-Light',24); c.drawString(48,735,material['title']); y=640
            for para in lines:
                for line in textwrap.wrap(para,32):
                    c.setFillColorRGB(.12,.19,.23); c.setFont('STSong-Light',15); c.drawString(48,y,line); y-=28
                y-=12
            c.setFont('Helvetica',10); c.drawString(48,45,'Partner Center   |   Sample edition'); c.drawRightString(550,45,str(page+1)); c.showPage()
        c.save(); files[f['id']]=base64.b64encode(b.getvalue()).decode()
print(json.dumps(files))
