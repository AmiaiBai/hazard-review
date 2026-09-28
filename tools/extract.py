# -*- coding: utf-8 -*-
"""从「识别记录」xlsx 提取隐患数据 + 现场图片，输出前端可直接用的 JSON。"""
import os, re, json, zipfile, io, sys, time
import xml.etree.ElementTree as ET
from PIL import Image
import openpyxl

SRC = r"D:\Project\AI眼镜\识别记录_178962387532239299.xlsx"
OUT = r"D:\Project\AI眼镜\hazard-review\data"
IMG_DIR = os.path.join(OUT, "images")
os.makedirs(IMG_DIR, exist_ok=True)

NS = {
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

# ---------- 1. 图片锚点：Excel 行(1-based) -> media 路径 ----------
def parse_anchors(z):
    names = set(z.namelist())
    if "xl/drawings/drawing1.xml" not in names:
        return {}                       # 没有浮动图片的表（例如只导数据的批次）
    drawing = z.read("xl/drawings/drawing1.xml")
    rels_name = "xl/drawings/_rels/drawing1.xml.rels"
    rels = z.read(rels_name).decode("utf-8") if rels_name in names else ""
    rid2target = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
    root = ET.fromstring(drawing)
    out = {}
    for anchor in root:
        frm = anchor.find("xdr:from", NS)
        blip = anchor.find(".//a:blip", NS)
        if frm is None or blip is None:
            continue
        row = int(frm.find("xdr:row", NS).text) + 1        # 0-based -> 1-based
        rid = blip.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed")
        tgt = rid2target.get(rid)
        if not tgt:
            continue
        media = "xl/" + tgt.replace("../", "")
        out[row] = media
    return out

# ---------- 2. 识别清单文本 -> 隐患列表 ----------
def parse_hazards(text):
    if not text or not str(text).strip():
        return []
    text = str(text).replace("\r\n", "\n").replace("\r", "\n").strip()
    parts = re.split(r"(?m)^\s*(\d+)\s*[\.、]\s*隐患名称\s*[:：]\s*", text)
    hazards = []
    if len(parts) > 1:
        for i in range(1, len(parts), 2):
            no, body = parts[i], parts[i + 1]
            hazards.append(_parse_one(body, no))
    else:
        # 无编号的兜底：整段当一条
        hazards.append(_parse_one(text, "1"))
    return [h for h in hazards if h["name"] or h["desc"]]

def _parse_one(body, no):
    lines = body.split("\n")
    name = lines[0].strip() if lines else ""
    name = re.sub(r"^[:：]\s*", "", name)
    rest = "\n".join(lines[1:])
    def grab(label, stop_labels):
        stop = "|".join(stop_labels) if stop_labels else "$"
        m = re.search(label + r"\s*[:：]\s*(.*?)(?=\n\s*(?:" + stop + r")\s*[:：]|$)", rest, re.S)
        return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
    desc = grab("隐患描述", ["整改建议", "法规依据"])
    advice = grab("整改建议", ["法规依据"])
    basis = grab("法规依据", [])
    return {"no": int(no) if str(no).isdigit() else no, "name": name,
            "desc": desc, "advice": advice, "basis": basis, "std": extract_std(basis)}

def extract_std(basis):
    """从法规依据里抽出标准名 + 标准号 + 条款号，方便前端小标签展示。"""
    if not basis:
        return ""
    m = re.search(r"(《[^》]{2,60}》\s*[A-Za-z]{1,6}\s*/?\s*[A-Za-z0-9]{0,6}\s*[\d]{2,5}(?:[\.\-—]\d{2,4})?)", basis)
    if m:
        s = re.sub(r"\s+", " ", m.group(1)).strip()
        tail = basis[m.end():]
        t = re.match(r"\s*([\d]+(?:[\.\-]\d+)*)", tail)
        if t:
            s += " " + t.group(1)
        return s
    m2 = re.search(r"(《[^》]{2,60}》)", basis)
    return m2.group(1) if m2 else ""

# ---------- 3. 主流程 ----------
def main():
    t0 = time.time()
    z = zipfile.ZipFile(SRC)
    anchors = parse_anchors(z)
    print(f"锚点图片数: {len(anchors)}")

    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb["数据"]
    rows = list(ws.iter_rows(values_only=True))
    hdr = [str(h).strip() if h is not None else "" for h in rows[0]]
    idx = {h: i for i, h in enumerate(hdr)}
    print("表头:", hdr)

    records, img_jobs = [], []
    for rno, row in enumerate(rows[1:], start=2):     # Excel 行号
        g = lambda k: (row[idx[k]] if k in idx and row[idx[k]] is not None else "")
        rid = str(g("隐患编号")).strip()
        if not rid:
            continue
        hazards = parse_hazards(g("识别清单"))
        rec = {
            "id": rid,
            "dept": str(g("部门")).strip(),
            "inspector": str(g("检查人员")).strip(),
            "device": str(g("设备编号")).strip(),
            "scene": str(g("场景名称")).strip(),
            "time": str(g("识别时间")).strip()[:19],
            "summary": str(g("描述")).strip(),
            "image": "",
            "hazards": hazards,
        }
        media = anchors.get(rno)
        if media:
            fname = f"{rid}.jpg"
            rec["image"] = "images/" + fname
            img_jobs.append((media, fname))
        records.append(rec)

    wb.close()

    # 导出图片并压缩
    done = 0
    for media, fname in img_jobs:
        dst = os.path.join(IMG_DIR, fname)
        if os.path.exists(dst):
            done += 1
            continue
        try:
            raw = z.read(media)
            im = Image.open(io.BytesIO(raw))
            im = im.convert("RGB")
            w = 900
            if im.width > w:
                im = im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
            im.save(dst, "JPEG", quality=76, optimize=True, progressive=True)
            done += 1
        except Exception as e:
            print("图片失败", media, e)
    print(f"图片完成 {done}/{len(img_jobs)}  {time.time()-t0:.1f}s")

    n_hz = sum(len(r["hazards"]) for r in records)
    meta = {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "recordCount": len(records),
        "hazardCount": n_hz,
        "depts": sorted({r["dept"] for r in records if r["dept"]}),
    }
    with open(os.path.join(OUT, "hazards.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "records": records}, f, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps(meta, ensure_ascii=False, indent=2))

    # 抽样打印，人工核对解析质量
    for r in records[:3]:
        print("-" * 60)
        print(r["id"], r["dept"], r["inspector"], r["time"], r["image"])
        for h in r["hazards"]:
            print(f"  [{h['no']}] {h['name']} | std={h['std']}")
            print(f"      desc: {h['desc'][:70]}")
            print(f"      advice: {h['advice'][:50]}")
            print(f"      basis: {h['basis'][:70]}")
    empty = [r["id"] for r in records if not r["hazards"]]
    print("无隐患记录数:", len(empty), empty[:10])
    noimg = [r["id"] for r in records if not r["image"]]
    print("无图片记录数:", len(noimg), noimg[:10])

if __name__ == "__main__":
    main()
