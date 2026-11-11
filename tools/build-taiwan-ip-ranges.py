"""Prepare DB-IP City Lite Taiwan ranges for the private order lookup table."""

import argparse
import csv
import gzip
import ipaddress
from pathlib import Path


# Map source labels to county/city. Ambiguous labels remain Taiwan-only.
COUNTIES = {
    "臺北市": ("Taipei", "Taipei City", "Neihu District", "Dazhi", "Muzha", "Ximen"),
    "新北市": ("New Taipei City", "Banqiao District", "Danshui", "Xindian District",
             "Yingge District", "Shulin District", "Xizhi District", "Sanxia District",
             "Shimen District", "Shiding District", "Sanzhi District", "Pinglin District",
             "Wulai District", "Sanzhong", "Jiufen", "Cailiao", "Erbazhang"),
    "基隆市": ("Keelung",),
    "桃園市": ("Taoyuan", "Bade District", "Daxi", "Neili", "Zhongli District",
             "Yangmei District", "Longtan District"),
    "新竹市": ("Hsinchu",),
    "新竹縣": ("Zhubei", "Zhudong", "Emei"),
    "苗栗縣": ("Miaoli", "Toufen Township", "Gongguan"),
    "臺中市": ("Taichung", "Fengyuan", "Wufeng District", "Dali", "Zhongshan (Dajia)"),
    "彰化縣": ("Changhua", "Yuanlin", "Erlin", "Beidou", "Dacun", "Ershui", "Pitou",
             "Shetou", "Tianwei", "Tianzhong", "Xianxi", "Xihu", "Xizhou", "Yongjing"),
    "南投縣": ("Nantou City", "Caotun", "Puli", "Lugu", "Zhongliao", "Zhongxing New Village", "Zhushan"),
    "雲林縣": ("Douliu", "Dounan", "Beigang", "Citong", "Erlun", "Linnei", "Xiluo"),
    "嘉義市": ("Chiayi City",),
    "嘉義縣": ("Taibao", "Budai", "Fenjihu", "Minxiong", "Puzi", "Xingang"),
    "臺南市": ("Tainan", "Tainan City", "Yongkang District", "Xinying District", "Yujing"),
    "高雄市": ("Kaohsiung City", "Fongshan District", "Sanmin (Zhengxing)"),
    "屏東縣": ("Pingtung City", "Chaozhou", "Donggang", "Fangshan", "Hengchun"),
    "宜蘭縣": ("Yilan", "Luodong"),
    "花蓮縣": ("Hualien City", "Fengbin", "Xiulin"),
    "臺東縣": ("Taitung", "Chishang", "Guanshan"),
    "澎湖縣": ("Magong",),
    "金門縣": ("Jincheng", "Jinhu"),
    "連江縣": ("Jieshoucun", "Xikou Village"),
}
COUNTY_BY_LABEL = {label: county for county, labels in COUNTIES.items() for label in labels}


def taiwan_ranges(source):
    """Yield the Taiwan ranges, coalescing adjacent blocks with the same label."""
    previous = None
    with gzip.open(source, "rt", encoding="utf-8", newline="") as stream:
        for line in stream:
            if ",TW," not in line:
                continue
            start, end, _, country, region, city, *_ = next(csv.reader([line]))
            if country != "TW":
                continue
            start = ipaddress.ip_address(start)
            end = ipaddress.ip_address(end)
            county = COUNTY_BY_LABEL.get(city, "")
            if not county and region == "Kaohsiung":
                county = "高雄市"
            if previous:
                old_start, old_end, old_county = previous
                if start.version == old_end.version:
                    if start <= old_end:
                        raise ValueError("Overlapping or unordered Taiwan IP blocks")
                    if int(start) == int(old_end) + 1 and old_county == county:
                        previous = old_start, end, county
                        continue
                yield previous
            previous = start, end, county
    if previous:
        yield previous


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Official DB-IP City Lite CSV gzip")
    parser.add_argument("target", type=Path, help="Output UTF-8 CSV")
    args = parser.parse_args()
    ranges = list(taiwan_ranges(args.source))
    if not ranges:
        raise ValueError("No Taiwan ranges were found")
    with args.target.open("w", encoding="utf-8", newline="") as output:
        csv.writer(output, lineterminator="\n").writerows(ranges)
    print(f"{len(ranges)} coalesced Taiwan ranges from {args.source.name}")


if __name__ == "__main__":
    main()
