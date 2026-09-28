# -*- coding: utf-8 -*-
"""增量导入「识别记录」xlsx —— 新批次追加，历史数据与已有评分绝不被覆盖。

用法
----
  # 导入一个新批次（最常用）
  python tools/import_batch.py "D:\\...\\识别记录_xxxx.xlsx"

  # 指定批次名（前端筛选里显示的名字）
  python tools/import_batch.py "识别记录_xxxx.xlsx" --batch "第2批-如皋"

  # 一次导入多个文件（合并成一个批次）
  python tools/import_batch.py a.xlsx b.xlsx --batch "第2批"

  # 只看会怎么变，不写盘（强烈建议先跑一次）
  python tools/import_batch.py "识别记录_xxxx.xlsx" --check

  # 允许用新文件里的内容覆盖同名记录（默认是保留旧数据）
  python tools/import_batch.py "识别记录_xxxx.xlsx" --replace

  # 查看已导入的批次 / 给历史数据补批次标记
  python tools/import_batch.py --list
  python tools/import_batch.py --tag-existing "第1批"

行为
----
* 按「隐患编号」去重合并：新编号追加，已有编号默认保留原样（不动、不覆盖）。
* 已存在但内容有差异的记录会列出来提醒，只有加 --replace 才会用新内容覆盖。
* 图片按 记录编号.jpg 命名，只导出缺失的，不重复处理。
* 导入前会检查 submissions.json 里有没有「孤儿评分」（记录已不在数据里）并报警。
* 每次导入写入 data/sources.json 留痕，可随时回溯是谁、什么时候、导了多少。
"""
import os, sys, io, re, json, time, zipfile, hashlib, argparse

import openpyxl
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
IMG_DIR = os.path.join(DATA, "images")
THUMB_DIR = os.path.join(DATA, "thumbs")       # 缩略图：供 Excel 导出内嵌，控制文件体积
HZ_FILE = os.path.join(DATA, "hazards.json")
SUB_FILE = os.path.join(DATA, "submissions.json")
SRC_FILE = os.path.join(DATA, "sources.json")

sys.path.insert(0, HERE)
from extract import parse_anchors, parse_hazards   # 复用已验证的解析逻辑

IMG_MAX_W = 720        # 与 tools/recompress_images.py 保持一致
IMG_QUALITY = 72
THUMB_MAX_W = 320      # 缩略图尺寸
THUMB_QUALITY = 70


# ---------------------------------------------------------------- 读写
def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def dump_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def sha1_of(path, buf=1 << 20):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            b = f.read(buf)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


# ---------------------------------------------------------------- 解析单个 xlsx
def parse_xlsx(src):
    """返回 (records, image_jobs, zipfile)；zip 需调用方 close。"""
    z = zipfile.ZipFile(src)
    anchors = parse_anchors(z)

    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    if "数据" not in wb.sheetnames:
        wb.close(); z.close()
        raise SystemExit(f"❌ {os.path.basename(src)} 里没有「数据」工作表，表名有：{wb.sheetnames}")
    ws = wb["数据"]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        wb.close(); z.close()
        raise SystemExit(f"❌ {os.path.basename(src)} 的「数据」表是空的")

    hdr = [str(h).strip() if h is not None else "" for h in rows[0]]
    idx = {h: i for i, h in enumerate(hdr)}
    for need in ("隐患编号", "识别清单"):
        if need not in idx:
            wb.close(); z.close()
            raise SystemExit(f"❌ {os.path.basename(src)} 缺少必需列「{need}」，实际表头：{hdr}")

    records, jobs = [], []
    for rno, row in enumerate(rows[1:], start=2):        # rno = Excel 行号
        g = lambda k: (row[idx[k]] if k in idx and row[idx[k]] is not None else "")
        rid = str(g("隐患编号")).strip()
        if not rid:
            continue
        rec = {
            "id": rid,
            "dept": str(g("部门")).strip(),
            "inspector": str(g("检查人员")).strip(),
            "device": str(g("设备编号")).strip(),
            "scene": str(g("场景名称")).strip(),
            "time": str(g("识别时间")).strip()[:19],
            "summary": str(g("描述")).strip(),
            "image": "",
            "hazards": parse_hazards(g("识别清单")),
        }
        media = anchors.get(rno)
        if media:
            fname = rid + ".jpg"
            rec["image"] = "images/" + fname
            jobs.append((media, fname))
        records.append(rec)

    wb.close()
    return records, jobs, z


def save_sized(im, dst, max_w, quality):
    if im.width > max_w:
        im = im.resize((max_w, max(1, int(im.height * max_w / im.width))), Image.LANCZOS)
    im.save(dst, "JPEG", quality=quality, optimize=True, progressive=True)


def export_images(z, jobs):
    """只导出缺失的原图与缩略图，返回新增张数。"""
    os.makedirs(THUMB_DIR, exist_ok=True)
    added = 0
    for media, fname in jobs:
        dst = os.path.join(IMG_DIR, fname)
        thumb = os.path.join(THUMB_DIR, fname)
        need_full = not os.path.exists(dst)
        need_thumb = not os.path.exists(thumb)
        if not need_full and not need_thumb:
            continue
        try:
            raw = z.read(media)
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            if need_full:
                save_sized(im, dst, IMG_MAX_W, IMG_QUALITY)
            if need_thumb:
                save_sized(im, thumb, THUMB_MAX_W, THUMB_QUALITY)
            added += 1
        except Exception as e:
            print(f"   ⚠️ 图片导出失败 {media}: {e}")
    return added


def backfill_thumbs():
    """给已有的原图补齐缩略图（不依赖 xlsx）。"""
    os.makedirs(THUMB_DIR, exist_ok=True)
    files = [f for f in os.listdir(IMG_DIR) if f.lower().endswith((".jpg", ".jpeg", ".png"))] if os.path.isdir(IMG_DIR) else []
    done = 0
    for f in files:
        dst = os.path.join(THUMB_DIR, os.path.splitext(f)[0] + ".jpg")
        if os.path.exists(dst):
            continue
        try:
            im = Image.open(os.path.join(IMG_DIR, f)).convert("RGB")
            save_sized(im, dst, THUMB_MAX_W, THUMB_QUALITY)
            done += 1
        except Exception as e:
            print(f"   ⚠️ 缩略图失败 {f}: {e}")
    print(f"缩略图：{len(files)} 张原图，本次新增 {done} 张")
    total = len([f for f in os.listdir(THUMB_DIR) if f.endswith('.jpg')]) if os.path.isdir(THUMB_DIR) else 0
    size = sum(os.path.getsize(os.path.join(THUMB_DIR, f)) for f in os.listdir(THUMB_DIR)) if total else 0
    print(f"缩略图目录共 {total} 张，合计 {size / 1024 / 1024:.1f}MB")


# ---------------------------------------------------------------- 合并
def content_key(r):
    return json.dumps({
        "dept": r.get("dept", ""), "inspector": r.get("inspector", ""),
        "device": r.get("device", ""), "scene": r.get("scene", ""),
        "time": r.get("time", ""), "summary": r.get("summary", ""),
        "hazards": r.get("hazards", []),
    }, ensure_ascii=False, sort_keys=True)


def diff_note(old, new):
    bits = []
    if len(old.get("hazards", [])) != len(new.get("hazards", [])):
        bits.append(f"隐患条数 {len(old.get('hazards', []))} → {len(new.get('hazards', []))}")
    for f, lab in (("dept", "部门"), ("inspector", "检查人"), ("time", "时间")):
        if old.get(f, "") != new.get(f, ""):
            bits.append(f"{lab} {old.get(f, '') or '空'} → {new.get(f, '') or '空'}")
    if not bits:
        for i, (a, b) in enumerate(zip(old.get("hazards", []), new.get("hazards", [])), 1):
            if a.get("name") != b.get("name"):
                bits.append(f"第{i}条名称变更")
                break
    return "；".join(bits[:3]) or "内容有细微差异"


def merge_records(old_records, new_records, batch, replace):
    by_id = {r["id"]: r for r in old_records}
    order = [r["id"] for r in old_records]
    added, updated, skipped, conflicts = [], [], [], []

    for nr in new_records:
        rid = nr["id"]
        prev = by_id.get(rid)
        if prev is None:
            nr["batch"] = batch
            by_id[rid] = nr
            order.append(rid)
            added.append(rid)
            continue

        if content_key(prev) == content_key(nr):
            if not prev.get("batch"):
                prev["batch"] = batch
            skipped.append(rid)
            continue

        conflicts.append((rid, diff_note(prev, nr)))
        if replace:
            nr["batch"] = prev.get("batch") or batch
            by_id[rid] = nr
            updated.append(rid)
        elif not prev.get("batch"):
            prev["batch"] = batch

    return [by_id[i] for i in order], added, updated, skipped, conflicts


# ---------------------------------------------------------------- 评分安全检查
def audit_submissions(records):
    """检查孤儿评分 + 越界隐患序号。返回 (orphans, out_of_range, total, people)。"""
    subs = load_json(SUB_FILE, {"items": []})
    items = subs.get("items", [])
    hz_max = {}
    ids = set()
    for r in records:
        ids.add(r["id"])
        hz_max[r["id"]] = max([h["no"] for h in r["hazards"] if isinstance(h.get("no"), int)] or [0])

    orphans, oor = {}, {}
    for it in items:
        rid = it.get("recordId")
        if rid not in ids:
            orphans[rid] = orphans.get(rid, 0) + 1
        else:
            no = it.get("hazardNo")
            if isinstance(no, int) and no > 0 and no > hz_max.get(rid, 0):
                oor.setdefault(rid, []).append(no)

    people = sorted({it.get("reviewer", "") for it in items if it.get("reviewer")})
    return orphans, oor, len(items), people


def print_audit(records):
    orphans, oor, total, people = audit_submissions(records)
    print(f"  已有评分：{total} 条，来自 {len(people)} 人" + (f"（{'、'.join(people)}）" if people else ""))
    if orphans:
        print(f"  ⚠️ 孤儿评分 {sum(orphans.values())} 条 —— 这些记录已不在隐患数据里：")
        for rid, n in sorted(orphans.items()):
            print(f"       {rid}  {n} 条")
        print("     统计页会把它们显示成空名称，建议核对后再决定是否清理。")
    if oor:
        print("  ⚠️ 隐患序号越界（该记录隐患条数变少了）：")
        for rid, nos in sorted(oor.items()):
            print(f"       {rid}  序号 {sorted(set(nos))}")
    if not orphans and not oor:
        print("  ✅ 评分数据全部能对上，没有孤儿记录")


# ---------------------------------------------------------------- meta
def build_meta(records):
    batches = {}
    for r in records:
        b = r.get("batch") or "未分批"
        o = batches.setdefault(b, {"name": b, "records": 0, "hazards": 0, "depts": set(), "firstTime": "", "lastTime": ""})
        o["records"] += 1
        o["hazards"] += len(r.get("hazards", []))
        if r.get("dept"):
            o["depts"].add(r["dept"])
        t = r.get("time") or ""
        if t:
            if not o["firstTime"] or t < o["firstTime"]:
                o["firstTime"] = t
            if not o["lastTime"] or t > o["lastTime"]:
                o["lastTime"] = t

    batch_list = []
    for o in batches.values():
        batch_list.append({
            "name": o["name"], "records": o["records"], "hazards": o["hazards"],
            "depts": sorted(o["depts"]), "firstTime": o["firstTime"], "lastTime": o["lastTime"],
        })
    batch_list.sort(key=lambda x: (x["name"] == "未分批", x["firstTime"] or x["name"]))

    return {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "recordCount": len(records),
        "hazardCount": sum(len(r.get("hazards", [])) for r in records),
        "emptyCount": sum(1 for r in records if not r.get("hazards")),
        "depts": sorted({r["dept"] for r in records if r.get("dept")}),
        "batches": batch_list,
    }


# ---------------------------------------------------------------- 批次名
def next_batch_name(hz):
    exist = {b["name"] for b in (hz.get("meta", {}).get("batches") or [])}
    for r in hz.get("records", []):
        if r.get("batch"):
            exist.add(r["batch"])
    n = 1
    while f"第{n}批" in exist:
        n += 1
    return f"第{n}批"


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(add_help=True, description="增量导入识别记录 xlsx（不覆盖历史数据）")
    ap.add_argument("files", nargs="*", help="一个或多个「识别记录」xlsx 路径")
    ap.add_argument("--batch", default="", help="批次名，前端筛选里显示的名字（默认「第N批」）")
    ap.add_argument("--replace", action="store_true", help="同名记录用新文件内容覆盖（默认保留旧数据）")
    ap.add_argument("--check", action="store_true", help="只检查不写盘")
    ap.add_argument("--list", action="store_true", help="列出已导入的批次")
    ap.add_argument("--tag-existing", metavar="批次名", default="", help="给还没有批次标记的历史记录统一打标")
    ap.add_argument("--thumbs", action="store_true", help="给已有原图补齐缩略图（Excel 导出内嵌用）")
    args = ap.parse_args()

    if args.thumbs:
        backfill_thumbs()
        return

    hz = load_json(HZ_FILE, {"meta": {}, "records": []})
    old_records = hz.get("records", [])

    # ---- --list ----
    if args.list:
        meta = hz.get("meta", {})
        print(f"隐患数据：{meta.get('recordCount', len(old_records))} 条记录 / "
              f"{meta.get('hazardCount', 0)} 条隐患 / {meta.get('emptyCount', 0)} 条空场景")
        print(f"生成时间：{meta.get('generatedAt', '—')}")
        print("\n批次：")
        for b in meta.get("batches", []):
            rng = f"{b['firstTime'][:10]} ~ {b['lastTime'][:10]}" if b.get("firstTime") else "—"
            print(f"  · {b['name']:<14} {b['records']:>4} 条记录 / {b['hazards']:>4} 条隐患 / {rng}  [{('、'.join(b['depts']) or '无部门')}]")
        srcs = load_json(SRC_FILE, {"sources": []}).get("sources", [])
        if srcs:
            print("\n导入记录：")
            for s in srcs:
                print(f"  · {s['importedAt']}  {s['batch']:<14} 新增 {s['added']:>4} 更新 {s['updated']:>3} 跳过 {s['skipped']:>4}  ← {os.path.basename(s['file'])}")
        print("\n评分数据检查：")
        print_audit(old_records)
        return

    # ---- --tag-existing ----
    if args.tag_existing:
        n = 0
        for r in old_records:
            if not r.get("batch"):
                r["batch"] = args.tag_existing
                n += 1
        if not n:
            print("所有记录都已有批次标记，无需处理。")
            return
        hz["records"] = old_records
        hz["meta"] = build_meta(old_records)
        dump_json(HZ_FILE, hz)
        print(f"✅ 已给 {n} 条历史记录打上批次「{args.tag_existing}」")
        return

    if not args.files:
        ap.print_help()
        return

    batch = args.batch or next_batch_name(hz)
    print(f"📦 批次名：{batch}" + ("（--check 只检查，不写盘）" if args.check else ""))
    print(f"📂 现有数据：{len(old_records)} 条记录 / {sum(len(r.get('hazards', [])) for r in old_records)} 条隐患\n")

    all_new, all_jobs, zips = [], [], []
    for src in args.files:
        if not os.path.exists(src):
            raise SystemExit(f"❌ 找不到文件：{src}")
        recs, jobs, z = parse_xlsx(src)
        hz_n = sum(len(r["hazards"]) for r in recs)
        print(f"📥 {os.path.basename(src)}  →  {len(recs)} 条记录 / {hz_n} 条隐患 / {len(jobs)} 张图")
        all_new.extend(recs)
        all_jobs.extend(jobs)
        zips.append((src, z))

    # 文件内部自检
    dup = {}
    for r in all_new:
        dup[r["id"]] = dup.get(r["id"], 0) + 1
    inner_dup = {k: v for k, v in dup.items() if v > 1}
    if inner_dup:
        print(f"\n⚠️ 待导入文件内部有重复编号 {len(inner_dup)} 个，已保留最后一条：{list(inner_dup)[:5]}")

    merged, added, updated, skipped, conflicts = merge_records(old_records, all_new, batch, args.replace)

    print(f"\n🔀 合并结果：新增 {len(added)} · 更新 {len(updated)} · 保留原样 {len(skipped)}")
    if conflicts:
        print(f"\n⚠️ 有 {len(conflicts)} 条同名记录内容不一致（默认保留旧数据，加 --replace 才覆盖）：")
        for rid, note in conflicts[:20]:
            print(f"     {rid}  {note}")
        if len(conflicts) > 20:
            print(f"     …… 还有 {len(conflicts) - 20} 条")

    if not added and not updated:
        print("\n没有新数据要写，历史数据原样保留。")
        if conflicts:
            print("（上面列出的差异需要你决定是否用 --replace 覆盖）")
    else:
        print(f"\n📊 合并后总量：{len(merged)} 条记录 / {sum(len(r.get('hazards', [])) for r in merged)} 条隐患")

    print("\n🔎 评分数据检查：")
    print_audit(merged)

    if args.check:
        for _, z in zips:
            z.close()
        print("\n（--check 模式，未写盘。确认无误后去掉 --check 再跑一次）")
        return

    # ---- 写盘 ----
    img_added = 0
    for _, z in zips:
        img_added += export_images(z, all_jobs)
        z.close()

    hz["records"] = merged
    hz["meta"] = build_meta(merged)
    dump_json(HZ_FILE, hz)

    srcs = load_json(SRC_FILE, {"sources": []})
    for src, _ in zips:
        srcs["sources"].append({
            "file": src, "sha1": sha1_of(src), "batch": batch,
            "importedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "records": len(all_new),
            "hazards": sum(len(r["hazards"]) for r in all_new),
            "added": len(added), "updated": len(updated), "skipped": len(skipped),
        })
    dump_json(SRC_FILE, srcs)

    print(f"\n✅ 已写入 data/hazards.json（图片新增 {img_added} 张）")
    print(f"   批次「{batch}」：记录 {len(added) + len(updated)} 条，历史 {len(old_records)} 条记录与全部评分保持不变。")
    print("\n下一步：确认前端没问题后再发布（发布前务必先跑 tools/sync_live.js 同步线上评分）。")


if __name__ == "__main__":
    main()
