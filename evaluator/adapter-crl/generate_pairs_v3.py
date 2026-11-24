#!/usr/bin/env python3
"""Training pairs for CORPORATE_REGISTRY_LOOKUP, version 3: LEI-register lookups.

Version 3 is version 2 with two changes. Each country has about 25 real
cities instead of six, so the adapter has to learn which city belongs to
which country rather than memorise a short list. The geography faults
(country_code, city, jurisdiction, address) are weighted up to about 60% of
pairs, because v2 scored 52-75% on them while dropped_field, which it
already orders at 97%, is weighted down.

Version 2's description follows.

Version 1 trained on company-registry extracts (Companies House, HRB entries
and so on). The node's public pairs for this intent turned out to be lookups
against the GLEIF LEI register instead: a company name, often an LEI, and a
short question about status, jurisdiction, city, address, registration
number or legal form, answered in a sentence or a JSON record. This
generator builds that shape from synthetic records it holds (the names,
LEIs and addresses are made up; LEIs carry valid ISO 17442 check digits).

The better answer reports the record; the worse answer is a copy of it with
one fault. Most faults can be judged from the question and the answer
alone, because a record has to hang together:

  country_code      the city kept, its country code changed (Kota, GB)
  jurisdiction      the jurisdiction changed against the legal form and city
  city              the city replaced with one in another country
  address           the address replaced with one in another country
  contradiction     the summary and a status field disagree
  dropped_field     a field the question asks for left out
  bad_lei           an LEI of the wrong length
  impossible_date   created after the lookup date
  flip_status       ACTIVE and INACTIVE reversed (judged against the evidence
                    when the question gives some, otherwise by the prior that
                    a record someone looks up is usually live)
  other_entity      the search results list a similarly named entity and the
                    worse answer reports that one's LEI, number or city

Both answers are rendered with the same random choices, so they differ only
in the fault. Output: JSONL rows {prompt, chosen, rejected, worse_kind,
evidence, style}, the same as version 1.
"""
import argparse
import datetime as dt
import json
import random
import string

# country: legal forms, LEI prefixes, cities (city, region code, postcode maker), registry, number maker, name
COUNTRIES = {
    "US": dict(name="the United States", forms=[("Inc.", "Corporation"), ("INC.", "Corporation"), ("Corporation", "Corporation"),
               ("LLC", "Limited Liability Company"), ("CORP.", "Corporation"), ("L.P.", "Limited Partnership")],
               lei=["5493", "2549", "5299"], jur=["US-DE", "US-DE", "US-NY", "US-CA", "US-NV"],
               cities=[("WILMINGTON", "US-DE", "19801"), ("DOVER", "US-DE", "19901"), ("NEW YORK", "US-NY", "10001"),
                       ("Glendale", "US-CA", "91203"), ("CARSON CITY", "US-NV", "89701"), ("LEWES", "US-DE", "19958")],
               streets=["C/O THE CORPORATION TRUST COMPANY, 1209 ORANGE STREET", "C/O CAPITOL SERVICES, INC., 108 LAKELAND AVE",
                        "C/O C T Corporation System, 330 N BRAND BLVD", "251 LITTLE FALLS DRIVE", "16192 COASTAL HIGHWAY",
                        "C/O REGISTERED AGENTS INC., 8 THE GREEN"],
               registry="Division of Corporations, Department of State", number=lambda r: str(r.randrange(2000000, 7999999))),
    "GB": dict(name="the United Kingdom", forms=[("LIMITED", "Private limited company"), ("LTD", "Private limited company"),
               ("PLC", "Public limited company"), ("LLP", "Limited liability partnership")],
               lei=["2138", "5493", "9845"], jur=["GB"],
               cities=[("LONDON", "GB-LND", "EC2A 4NE"), ("MANCHESTER", "GB-MAN", "M1 3HU"), ("BIRMINGHAM", "GB-BIR", "B3 2HJ"),
                       ("LEEDS", "GB-LDS", "LS1 4DY"), ("BRISTOL", "GB-BST", "BS1 6AA"), ("EDINBURGH", "GB-EDH", "EH2 4AN")],
               streets=["1 Bartholomew Lane", "20 Fenchurch Street", "Floor 4, 77 Mosley Street", "8 Park Place",
                        "Suite 3, 41 Corsham Street", "10 Queen Street Place"],
               registry="Companies House", number=lambda r: "%08d" % r.randrange(1000000, 15999999)),
    "DE": dict(name="Germany", forms=[("GmbH", "Gesellschaft mit beschränkter Haftung"), ("AG", "Aktiengesellschaft"),
               ("GmbH & Co. KG", "Kommanditgesellschaft"), ("UG (haftungsbeschränkt)", "Unternehmergesellschaft")],
               lei=["3912", "5299", "8156"], jur=["DE"],
               cities=[("Berlin", "DE-BE", "10247"), ("München", "DE-BY", "80331"), ("Hamburg", "DE-HH", "20095"),
                       ("Frankfurt am Main", "DE-HE", "60311"), ("Köln", "DE-NW", "50667"), ("Stuttgart", "DE-BW", "70173")],
               streets=["Zur Waage 10", "Leopoldstraße 130", "Mönckebergstraße 7", "Taunusanlage 12", "Hohe Straße 52",
                        "Königstraße 26"],
               registry="Handelsregister", number=lambda r: "HRB %d" % r.randrange(10000, 260000)),
    "IT": dict(name="Italy", forms=[("S.R.L.", "Società a responsabilità limitata"), ("S.P.A.", "Società per azioni"),
               ("S.R.L.S.", "Società a responsabilità limitata semplificata")],
               lei=["8156", "5299", "8150"], jur=["IT"],
               cities=[("Budrio", "IT-BO", "40054"), ("MILANO", "IT-MI", "20121"), ("ROMA", "IT-RM", "00187"),
                       ("Torino", "IT-TO", "10121"), ("NAPOLI", "IT-NA", "80133"), ("Bologna", "IT-BO", "40121")],
               streets=["VIA DELL'INDUSTRIA 14", "Via Monte Napoleone 8", "VIA DEL CORSO 262", "Corso Vittorio Emanuele II 71",
                        "Via Toledo 156", "Via Rizzoli 3"],
               registry="Registro delle Imprese", number=lambda r: "%s%06d" % (r.choice(["MI", "RM", "BO", "TO", "NA"]), r.randrange(100000, 999999))),
    "CH": dict(name="Switzerland", forms=[("AG", "Aktiengesellschaft"), ("S.A.", "Société anonyme"), ("GmbH", "Gesellschaft mit beschränkter Haftung"),
               ("Verein", "Verein"), ("SA", "Société anonyme")],
               lei=["5067", "5299", "5493"], jur=["CH"],
               cities=[("Zug", "CH-ZG", "6300"), ("Zürich", "CH-ZH", "8001"), ("VEVEY", "CH-VD", "1800"),
                       ("Genève", "CH-GE", "1204"), ("Basel", "CH-BS", "4051"), ("Lugano", "CH-TI", "6900")],
               streets=["Baarerstrasse 14", "Bahnhofstrasse 45", "Avenue Nestlé 55", "Rue du Rhône 30", "Aeschenvorstadt 4",
                        "Via Nassa 21"],
               registry="Commercial Register", number=lambda r: "CHE-%03d.%03d.%03d" % (r.randrange(100, 999), r.randrange(1000), r.randrange(1000))),
    "FR": dict(name="France", forms=[("SAS", "Société par actions simplifiée"), ("S.A.", "Société anonyme"), ("SARL", "Société à responsabilité limitée")],
               lei=["9695", "9845", "5299"], jur=["FR"],
               cities=[("PARIS", "FR-75", "75008"), ("LYON", "FR-69", "69002"), ("Marseille", "FR-13", "13001"),
                       ("Toulouse", "FR-31", "31000"), ("NANTES", "FR-44", "44000"), ("Lille", "FR-59", "59000")],
               streets=["12 RUE DE LA PAIX", "45 Avenue George V", "3 Quai Jules Courmont", "18 Rue Paradis", "7 Allée Jean Jaurès",
                        "21 Rue Nationale"],
               registry="Registre du commerce et des sociétés", number=lambda r: "%03d %03d %03d" % (r.randrange(300, 999), r.randrange(1000), r.randrange(1000))),
    "JP": dict(name="Japan", forms=[("株式会社", "Kabushiki Kaisha"), ("Co., Ltd.", "Kabushiki Kaisha"), ("合同会社", "Godo Kaisha")],
               lei=["3538", "5493", "2549"], jur=["JP"],
               cities=[("東京都 中央区", "JP-13", "104-0028"), ("東京都 港区", "JP-13", "105-0001"), ("大阪府 大阪市", "JP-27", "530-0001"),
                       ("Tokyo", "JP-13", "100-0005"), ("愛知県 名古屋市", "JP-23", "450-0002"), ("Osaka", "JP-27", "541-0041")],
               streets=["晴海一丁目8番12号", "浜松町二丁目11番3号", "梅田三丁目1番3号", "1-1-2 Marunouchi, Chiyoda-ku", "名駅四丁目7番1号",
                        "4-1-1 Kitahama, Chuo-ku"],
               registry="Legal Affairs Bureau", number=lambda r: "%013d" % r.randrange(10**12, 10**13)),
    "IN": dict(name="India", forms=[("PRIVATE LIMITED", "Private Limited Company"), ("LIMITED", "Public Limited Company"),
               ("LLP", "Limited Liability Partnership")],
               lei=["6488", "3358", "5493"], jur=["IN"],
               cities=[("MUMBAI", "IN-MH", "400001"), ("Kota", "IN-RJ", "324005"), ("BENGALURU", "IN-KA", "560001"),
                       ("NEW DELHI", "IN-DL", "110001"), ("Chennai", "IN-TN", "600002"), ("HYDERABAD", "IN-TG", "500081")],
               streets=["NARIMAN POINT, 14 MAKER CHAMBERS", "Plot 22, Indraprastha Industrial Area", "12 MG ROAD", "BARAKHAMBA ROAD, 3RD FLOOR",
                        "45 Anna Salai", "HITEC CITY, BLOCK B"],
               registry="Registrar of Companies", number=lambda r: "U%05d%s%d%s%06d" % (r.randrange(10000, 99999), r.choice(["MH", "RJ", "KA", "DL", "TN"]), r.randrange(1995, 2025), r.choice(["PTC", "PLC"]), r.randrange(100000, 999999))),
    "PL": dict(name="Poland", forms=[("SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ", "Spółka z ograniczoną odpowiedzialnością"),
               ("Sp. z o.o.", "Spółka z ograniczoną odpowiedzialnością"), ("SPÓŁKA AKCYJNA", "Spółka akcyjna")],
               lei=["2594", "2597", "5299"], jur=["PL"],
               cities=[("BYDGOSZCZ", "PL-04", "85-001"), ("WARSZAWA", "PL-14", "00-001"), ("Kraków", "PL-12", "30-001"),
                       ("GDAŃSK", "PL-22", "80-001"), ("Wrocław", "PL-02", "50-001"), ("POZNAŃ", "PL-30", "61-001")],
               streets=["UL. GDAŃSKA 21", "ul. Marszałkowska 126", "ul. Floriańska 15", "UL. DŁUGA 47", "ul. Świdnicka 8",
                        "UL. PÓŁWIEJSKA 42"],
               registry="Krajowy Rejestr Sądowy", number=lambda r: "%010d" % r.randrange(10**8, 10**9)),
    "NL": dict(name="the Netherlands", forms=[("B.V.", "Besloten vennootschap"), ("N.V.", "Naamloze vennootschap"), ("Stichting", "Stichting")],
               lei=["7245", "5493", "7245"], jur=["NL"],
               cities=[("AMSTERDAM", "NL-NH", "1012 JS"), ("Rotterdam", "NL-ZH", "3011 AD"), ("Utrecht", "NL-UT", "3511 AA"),
                       ("EINDHOVEN", "NL-NB", "5611 AB"), ("Den Haag", "NL-ZH", "2511 CV")],
               streets=["Herengracht 450", "Coolsingel 42", "Oudegracht 112", "Vestdijk 9", "Lange Voorhout 16"],
               registry="Kamer van Koophandel", number=lambda r: "%08d" % r.randrange(10**7, 10**8)),
    "CN": dict(name="China", forms=[("Co., Ltd.", "Limited liability company"), ("Ltd.", "Limited liability company"), ("有限公司", "Limited liability company")],
               lei=["3003", "5493", "8365"], jur=["CN"],
               cities=[("北京", "CN-BJ", "100022"), ("上海", "CN-SH", "200120"), ("Shenzhen", "CN-GD", "518000"),
                       ("Beijing", "CN-BJ", "100020"), ("Shanghai", "CN-SH", "200002"), ("广州", "CN-GD", "510000")],
               streets=["朝陽區東三環中路24號", "浦东新区世纪大道100号", "Futian District, Shennan Avenue 6008", "Chaoyang District, Jianguomen Wai Street 1",
                        "Huangpu District, Zhongshan East 1st Road 18", "天河区珠江新城华夏路10号"],
               registry="State Administration for Market Regulation", number=lambda r: "9111%04d%s" % (r.randrange(10000), "".join(r.choice(string.digits + "ABCDEFGHJKLMNPQRTUWXY") for _ in range(10)))),
    "IE": dict(name="Ireland", forms=[("DESIGNATED ACTIVITY COMPANY", "Designated activity company"), ("LIMITED", "Private company limited by shares"),
               ("PLC", "Public limited company"), ("UNLIMITED COMPANY", "Unlimited company")],
               lei=["6354", "635400", "2138"], jur=["IE"],
               cities=[("Dublin 6", "IE-D", "D06 RX46"), ("DUBLIN 2", "IE-D", "D02 X576"), ("CORK", "IE-CO", "T12 W8CV"),
                       ("Galway", "IE-G", "H91 E2K3"), ("LIMERICK", "IE-L", "V94 T9PX")],
               streets=["Westmoreland House, Wesmoreland Park, Ranelagh", "70 Sir John Rogerson's Quay", "1 South Mall", "Eyre Square House",
                        "Riverpoint, Lower Mallow Street"],
               registry="Companies Registration Office", number=lambda r: str(r.randrange(100000, 799999))),
    "ES": dict(name="Spain", forms=[("SOCIEDAD LIMITADA", "Sociedad limitada"), ("S.L.", "Sociedad limitada"), ("S.A.", "Sociedad anónima")],
               lei=["9598", "5493", "9845"], jur=["ES"],
               cities=[("MADRID", "ES-M", "28046"), ("Barcelona", "ES-B", "08007"), ("VALENCIA", "ES-V", "46002"),
                       ("Sevilla", "ES-SE", "41001"), ("BILBAO", "ES-BI", "48001")],
               streets=["PASEO DE LA CASTELLANA 89", "Passeig de Gràcia 21", "CALLE COLÓN 4", "Avenida de la Constitución 10", "GRAN VÍA 30"],
               registry="Registro Mercantil", number=lambda r: "B%08d" % r.randrange(10**7, 10**8)),
    "SE": dict(name="Sweden", forms=[("AB", "Aktiebolag"), ("Aktiebolag", "Aktiebolag"), ("HB", "Handelsbolag")],
               lei=["5493", "5299", "2138"], jur=["SE"],
               cities=[("STOCKHOLM", "SE-AB", "111 52"), ("Göteborg", "SE-O", "411 06"), ("MALMÖ", "SE-M", "211 20"), ("Uppsala", "SE-C", "753 20")],
               streets=["Kungsgatan 44", "Södra Hamngatan 37", "STORGATAN 12", "Drottninggatan 5"],
               registry="Bolagsverket", number=lambda r: "556%03d-%04d" % (r.randrange(1000), r.randrange(10000))),
    "IM": dict(name="the Isle of Man", forms=[("LIMITED", "Company limited by shares"), ("Ltd", "Company limited by shares")],
               lei=["2138", "5493"], jur=["IM"],
               cities=[("Ballasalla, Malew", "IM-X", "IM9 2AE"), ("DOUGLAS", "IM-X", "IM1 1EU"), ("Ramsey", "IM-X", "IM8 1AB")],
               streets=["Global House, Station Road", "1 ATHOL STREET", "Parliament Street 22"],
               registry="Isle of Man Companies Registry", number=lambda r: "%06dC" % r.randrange(100000, 199999)),
}
CODES = list(COUNTRIES)

MORE_CITIES = {
    "US": ["Boston", "CHICAGO", "Houston", "SAN FRANCISCO", "Seattle", "Atlanta", "DALLAS", "Miami", "Denver", "AUSTIN",
           "Philadelphia", "PHOENIX", "San Diego", "Minneapolis", "Charlotte", "Portland", "NASHVILLE", "Las Vegas", "Detroit", "Columbus"],
    "GB": ["Glasgow", "CARDIFF", "Liverpool", "Sheffield", "NOTTINGHAM", "Leicester", "Cambridge", "OXFORD", "Reading", "Southampton",
           "Newcastle upon Tyne", "BELFAST", "Brighton", "Milton Keynes", "Aberdeen", "York", "Coventry", "Norwich", "Bath", "Swindon"],
    "DE": ["Düsseldorf", "LEIPZIG", "Dresden", "Hannover", "Nürnberg", "BREMEN", "Essen", "Dortmund", "Bonn", "Mannheim",
           "Karlsruhe", "MÜNSTER", "Augsburg", "Wiesbaden", "Freiburg im Breisgau", "Mainz", "Kiel", "Heidelberg", "Regensburg", "Potsdam"],
    "IT": ["Firenze", "GENOVA", "Venezia", "Verona", "Palermo", "BARI", "Padova", "Trieste", "Brescia", "Parma",
           "Modena", "Bergamo", "CATANIA", "Perugia", "Pisa", "Lecce", "Rimini", "Cagliari", "Vicenza", "Treviso"],
    "CH": ["Bern", "LAUSANNE", "Luzern", "St. Gallen", "Winterthur", "Fribourg", "Neuchâtel", "SCHAFFHAUSEN", "Chur", "Sion",
           "Baar", "Cham", "Schwyz", "Aarau", "Solothurn", "Thun", "Montreux", "Nyon", "Locarno", "Biel/Bienne"],
    "FR": ["Bordeaux", "NICE", "Strasbourg", "Montpellier", "RENNES", "Grenoble", "Dijon", "Reims", "Le Havre", "Angers",
           "Clermont-Ferrand", "Tours", "LIMOGES", "Metz", "Rouen", "Nancy", "Brest", "Avignon", "Annecy", "Courbevoie"],
    "JP": ["横浜市", "Yokohama", "札幌市", "Sapporo", "福岡市", "Fukuoka", "京都市", "Kyoto", "神戸市", "Kobe",
           "仙台市", "Sendai", "広島市", "Hiroshima", "川崎市", "Kawasaki", "さいたま市", "千葉市", "静岡市", "東京都 千代田区"],
    "IN": ["PUNE", "Ahmedabad", "KOLKATA", "Jaipur", "Surat", "LUCKNOW", "Kanpur", "Nagpur", "Indore", "Bhopal",
           "GURUGRAM", "Noida", "Chandigarh", "Kochi", "Coimbatore", "Vadodara", "Visakhapatnam", "Thane", "Mysuru", "Ludhiana"],
    "PL": ["ŁÓDŹ", "Szczecin", "Lublin", "Katowice", "BIAŁYSTOK", "Gdynia", "Częstochowa", "Radom", "Toruń", "Rzeszów",
           "Kielce", "OLSZTYN", "Opole", "Gliwice", "Zabrze", "Bielsko-Biała", "Sopot", "Płock", "Elbląg", "Tarnów"],
    "NL": ["Groningen", "TILBURG", "Almere", "Breda", "Nijmegen", "Arnhem", "Haarlem", "Enschede", "Amersfoort", "Zwolle",
           "Maastricht", "Leiden", "DORDRECHT", "Delft", "Hilversum", "Apeldoorn", "Schiphol", "Hoofddorp", "Venlo", "Leeuwarden"],
    "CN": ["深圳", "杭州", "Hangzhou", "成都", "Chengdu", "南京", "Nanjing", "武汉", "Wuhan", "天津",
           "Tianjin", "苏州", "Suzhou", "重庆", "Chongqing", "西安", "Xi'an", "青岛", "Qingdao", "厦门"],
    "IE": ["Waterford", "KILKENNY", "Drogheda", "Dundalk", "Sligo", "Athlone", "Wexford", "Naas", "Swords", "Bray",
           "Navan", "Ennis", "Tralee", "Carlow", "Letterkenny", "Dún Laoghaire", "Shannon", "Mullingar", "Castlebar", "Portlaoise"],
    "ES": ["Málaga", "ZARAGOZA", "Murcia", "Palma", "Las Palmas de Gran Canaria", "Alicante", "Córdoba", "Valladolid", "Vigo", "Gijón",
           "A Coruña", "Granada", "VITORIA-GASTEIZ", "Pamplona", "Santander", "San Sebastián", "Salamanca", "Cádiz", "Tarragona", "Girona"],
    "SE": ["Västerås", "ÖREBRO", "Linköping", "Helsingborg", "Jönköping", "Norrköping", "Lund", "Umeå", "Gävle", "Borås",
           "Södertälje", "Eskilstuna", "Halmstad", "Växjö", "Karlstad", "Sundsvall", "Luleå", "Solna", "Kista", "Nacka"],
    "IM": ["Castletown", "Peel", "Onchan", "Port Erin", "Port St Mary", "Laxey", "Braddan", "Kirk Michael"],
}


def pick_city(rng, cc):
    c = COUNTRIES[cc]
    if cc != "US" and rng.random() < 0.7 and cc in MORE_CITIES:
        _, region, post = rng.choice(c["cities"])
        return rng.choice(MORE_CITIES[cc]), region, post
    return rng.choice(c["cities"])


STEMS = ["ADITYA", "GREEN VALLEY", "CEBA", "Patatino", "HORREUM", "CarbonX", "Northgate", "Brightwater", "Aster", "Corvane",
         "Delmar", "Fennick", "Halcyon", "Ironbridge", "Juniper", "Kestrel", "Larkspur", "Meridian", "Nimbus", "Orchard",
         "Pinecrest", "Quayside", "SILVERDALE", "Tamarind", "Umber", "Vantage", "Westmere", "Alder", "Cobalt", "Driftwood",
         "Emberly", "Foxglove", "Greyfriars", "Hollins", "Indigo", "Kingsmead", "Lumen", "Marlow", "Oakhurst", "Pellham",
         "Rosemont", "Thornbury", "Verity", "Wexford", "Yarrow", "SAPPHIRE", "Bellwether", "Calder", "Duneholm", "Everline",
         "Fairhaven", "Goldcrest", "Harrowgate", "Isarwerk", "Kronfeld", "Lindqvist", "Montebello", "Novaterra", "Ostrava",
         "Pradera", "Rheinblick", "Sakura", "Tianhe", "Valtellina", "Wolkenberg", "Zephyr", "Arcadia", "Bergström", "Castellano"]
TRADES = ["LANDCON", "LOGISTICS", "Holdings", "TECHNOLOGIES", "Foods", "Robotics", "MEDIA", "Energy", "Software", "Textiles",
          "Capital", "Labs", "Mining", "Retail", "Freight", "Pharma", "Builders", "Marine", "Payments", "Insurance", "Registry",
          "Hotels", "Ceramics", "Telecom", "Engineering", "Biotech", "TRADING", "Acquico", "Infra", "Ventures", "Partners", ""]
JP_NAMES = ["日本カストディ", "日本マスタートラスト", "東邦精機", "大和物産", "北斗電子", "瑞穂化学", "桜井建設", "青葉食品"]
JP_KINDS = ["銀行", "信託銀行", "工業", "商事", "ホールディングス", ""]
CN_NAMES = ["华夏", "长城", "东方", "金桥", "宏达", "天和"]


def lei_check(base18):
    n = int("".join(str(int(c, 36)) for c in base18 + "00"))
    return "%02d" % (98 - n % 97)


def make_lei(rng, prefix):
    prefix = prefix[:4]
    body = prefix + "00" + "".join(rng.choice(string.digits + string.ascii_uppercase) for _ in range(12))
    return body + lei_check(body)


def make_name(rng, cc, form):
    if cc == "JP" and form != "Co., Ltd.":
        nm = rng.choice(JP_NAMES) + rng.choice(JP_KINDS)
        return form + nm if rng.random() < 0.6 else nm + form
    if cc == "CN" and form == "有限公司":
        return rng.choice(CN_NAMES) + rng.choice(["科技", "物流", "贸易", "能源"]) + form
    stem = rng.choice(STEMS)
    trade = rng.choice(TRADES)
    base = (stem + " " + trade).strip()
    if cc == "CN" and rng.random() < 0.5:
        base += " (%s)" % rng.choice(["Shanghai", "Beijing", "China", "Shenzhen"])
    if cc == "IN" and rng.random() < 0.3:
        base += " INDIA"
    name = base + " " + form
    if rng.random() < 0.4:
        name = name.upper()
    return name


def fdate(rng_lo, rng_hi, rng):
    d = dt.date(rng_lo, 1, 1) + dt.timedelta(days=rng.randrange((dt.date(rng_hi, 12, 31) - dt.date(rng_lo, 1, 1)).days))
    return d


def make_record(rng, cc=None, stem_of=None):
    cc = cc or rng.choice(CODES)
    c = COUNTRIES[cc]
    form, kind = rng.choice(c["forms"])
    city, region, post = pick_city(rng, cc)
    street = rng.choice(c["streets"])
    rec = dict(cc=cc, form=form, kind=kind, city=city, region=region, post=post,
               jur=rng.choice(c["jur"]) if cc == "US" else cc,
               lei=make_lei(rng, rng.choice(c["lei"])), number=c["number"](rng), registry=c["registry"],
               created=fdate(1950, 2024, rng), active=rng.random() < 0.86, issued=rng.random() < 0.85)
    if cc == "US":
        city, region, post = [x for x in c["cities"] if x[1] == rec["jur"]][0] if any(x[1] == rec["jur"] for x in c["cities"]) else (city, region, post)
        rec.update(city=city, region=region, post=post)
    rec["name"] = make_name(rng, cc, form) if stem_of is None else stem_of
    rec["street"] = street
    return rec


def address(rec, with_region=None):
    parts = [rec["street"], rec["city"]]
    if with_region:
        parts.append(rec["region"])
    parts += [rec["post"], rec["cc"]]
    return ", ".join(parts)


def foreign(rng, cc, exclude=()):
    return rng.choice([x for x in CODES if x != cc and x not in exclude])


# ---- questions -----------------------------------------------------------------------------------

QTYPES = ["status_address", "status_city", "status_legal_city", "city_status", "jur_city", "kind_incorp",
          "regnum", "address", "live", "record_json", "full_onboard"]


def question(rng, q, rec, show_lei):
    n, l = rec["name"], rec["lei"]
    country = COUNTRIES[rec["cc"]]["name"]
    tail = rng.choice(["", "", " Keep it brief.", " Before we onboard a counterparty I need its register record.",
                       " This is for a KYC file.", " Please be exact."])
    lei_part = (" (LEI %s)" % l) if show_lei else ""
    if q == "status_address":
        s = rng.choice(["What is the legal status and registered address of %s%s?" % (n, lei_part),
                        "Give me the entity status and registered address for %s%s." % (n, lei_part)])
    elif q == "status_city":
        s = rng.choice(["Look up %s in the legal entity register%s. What is its status and where is it registered?" % (n, lei_part),
                        "Is %s%s still active, and in which city is it registered?" % (n, lei_part)])
    elif q == "status_legal_city":
        s = "What does the official record say about %s?%s Need the registration status and legal address." % (
            n, (" I have its LEI: %s." % l) if show_lei else "")
    elif q == "city_status":
        s = "Confirm the registered city and entity status for %s/%s, identified by LEI %s." % (n, rec["number"], l)
    elif q == "jur_city":
        s = "Which jurisdiction and legal-address city does the register list for %s (%s)?" % (n, l)
    elif q == "kind_incorp":
        s = rng.choice(["What kind of legal entity is %s, and where is it incorporated?" % n,
                        "What legal form does %s have, which jurisdiction is it under and when was it created?" % n])
    elif q == "regnum":
        s = "I need the official registration number for %s. Which register holds it and what is the entity's status?" % n
    elif q == "address":
        s = rng.choice(["What is the registered legal address of %s?" % n, "Where is %s legally registered? Full address please." % n])
    elif q == "live":
        s = "Compliance: Is %s a live legal entity in %s?" % (n, country.replace("the ", "", 1) if country.startswith("the ") else country)
    elif q == "record_json":
        s = "%s commercial register entry for %s: registration number, seat, status and LEI." % (
            rng.choice([country.replace("the ", "", 1).title() if country.startswith("the ") else country, rec["cc"]]), n)
    else:
        s = "%s in %s, LEI %s: what did the GLEIF record show at its last update on %s?" % (
            n, country.replace("the ", "", 1) if country.startswith("the ") else country, l, rec["asof"].isoformat())
    return s + tail


def search_block(rng, rec, other, asof):
    rows = [rec, other] if rng.random() < 0.5 else [other, rec]
    out = []
    for i, r in enumerate(rows, 1):
        bits = ["LEI %s" % r["lei"], "legal name %s" % r["name"], "entity status %s" % ("ACTIVE" if r["active"] else "INACTIVE"),
                "LEI registration %s" % ("ISSUED" if r["issued"] else "LAPSED"), "registered as %s at %s" % (r["number"], r["registry"]),
                "jurisdiction %s" % r["jur"], "legal address city %s, %s" % (r["city"], r["cc"]), "created %s" % r["created"].isoformat()]
        out.append("%d. %s" % (i, "; ".join(bits)))
    return " This is what the GLEIF LEI register returned for my search on %s: %s" % (asof.isoformat(), " ".join(out))


# ---- answers ---------------------------------------------------------------------------------------

def facts(rec):
    return dict(name=rec["name"], lei=rec["lei"], number=rec["number"], registry=rec["registry"], jur=rec["jur"],
                cc=rec["cc"], city=rec["city"], region=rec["region"], post=rec["post"], street=rec["street"],
                kind=rec["kind"], created=rec["created"].isoformat(), active=rec["active"], active2=rec["active"],
                issued=rec["issued"])


QFIELDS = {  # fields a question asks for (candidates for dropped_field)
    "status_address": ["status", "address"], "status_city": ["status", "city"], "status_legal_city": ["status", "city"],
    "city_status": ["city", "status"], "jur_city": ["jur", "city"], "kind_incorp": ["kind", "jur", "created"],
    "regnum": ["registry", "number", "status"], "address": ["address"], "live": ["status", "lei"],
    "record_json": ["number", "city", "status", "lei"], "full_onboard": ["number", "address", "status", "created"],
}


def st(a, up=True):
    v = "ACTIVE" if a else "INACTIVE"
    return v if up else v.lower()


def render(f, q, ch):
    """One answer from facts f; ch holds the random choices shared by both answers; f may lack dropped fields."""
    drop = f.get("drop", ())
    addr = None if "address" in drop else ", ".join(x for x in [f["street"], f["city"], f["region"] if ch["region"] else None, f["post"], f["cc"]] if x)
    status = None if "status" in drop else st(f["active"], ch["upper"])
    if ch["style"] == "json":
        keys = {"legal_name": f["name"], "lei": f["lei"], "registration_id": f["number"], "registration_authority": f["registry"],
                "entity_type": f["kind"], "active": f["active"], "entity_status": st(f["active2"]), "jurisdiction": f["jur"],
                "registered_city": "%s, %s" % (f["city"], f["cc"]), "registered_address": addr, "entity_creation_date": f["created"],
                "lei_registration_status": "ISSUED" if f["issued"] else "LAPSED"}
        dropmap = {"status": ["active", "entity_status"], "address": ["registered_address"], "city": ["registered_city"],
                   "jur": ["jurisdiction"], "kind": ["entity_type"], "created": ["entity_creation_date"],
                   "registry": ["registration_authority"], "number": ["registration_id"], "lei": ["lei"]}
        gone = {k for d in drop for k in dropmap.get(d, [])}
        obj = {}
        if ch["summary"]:
            obj["answer"] = "%s is %s, LEI %s, jurisdiction %s." % (f["name"], st(f["active"], False), f["lei"], f["jur"]) if not {"status", "lei"} & set(drop) else "%s, jurisdiction %s." % (f["name"], f["jur"])
        for k in ch["order"]:
            if k in gone or keys.get(k) is None:
                continue
            obj[k] = keys[k]
        if ch["checked"]:
            obj["checked_at"] = ch["asof"] + "T09:00:00Z"
        return json.dumps(obj, ensure_ascii=False)
    n = f["name"]
    seg = []
    if q == "status_address":
        s = "%s is %s" % (n, status) if status else n
        if addr:
            s += ", with a registered address at %s" % addr if status else " has its registered address at %s" % addr
        seg.append(s + ".")
    elif q in ("status_city", "status_legal_city", "city_status"):
        city = None if "city" in drop else "%s, %s" % (f["city"], f["cc"])
        if ch["variant"] == 0:
            parts = []
            if status:
                parts.append("Status %s" % status)
            if city:
                parts.append("legal address in %s (%s)" % (f["city"], f["cc"]))
            seg.append("; ".join(parts) + ".")
        elif ch["variant"] == 1:
            s = "%s is %s" % (n, status) if status else n
            seg.append(s + (" and registered in %s." % city if city else "."))
        else:
            if city and status:
                seg.append("%s is the registered city and the entity is %s." % (f["city"], status))
            elif city:
                seg.append("%s is the registered city." % f["city"])
            else:
                seg.append("The entity is %s." % status)
    elif q == "jur_city":
        parts = []
        if "jur" not in drop:
            parts.append("Jurisdiction %s" % f["jur"])
        if "city" not in drop:
            parts.append("city %s" % f["city"])
        seg.append(", ".join(parts) + ".")
    elif q == "kind_incorp":
        s = n + " is a %s" % f["kind"] if "kind" not in drop else n + " is registered"
        if "jur" not in drop:
            s += " under the jurisdiction %s" % f["jur"]
        if "created" not in drop:
            s += ", created on %s" % f["created"]
        seg.append(s + ".")
        if ch["extra"]:
            seg.append("LEI %s." % f["lei"])
    elif q == "regnum":
        s = "%s is registered" % n
        if "registry" not in drop:
            s += " with %s" % f["registry"]
        if "number" not in drop:
            s += " under number %s" % f["number"]
        seg.append(s + ".")
        if status:
            seg.append("Its entity status is %s%s." % (status, (" (LEI %s, LEI registration %s)" % (f["lei"], "ISSUED" if f["issued"] else "LAPSED")) if ch["extra"] else ""))
    elif q == "address":
        if addr:
            seg.append("The legal (registered) address on the official record for %s is %s." % (n, addr))
        else:
            seg.append("The official record for %s lists it as a %s." % (n, f["kind"]))
        seg.append("Jurisdiction: %s." % f["jur"])
    else:  # live, record_json, full_onboard in prose
        lead = "%s%s is %s entity registered in %s, per GLEIF." % (
            n, "" if "lei" in drop else " (LEI %s)" % f["lei"],
            ("an %s" % st(f["active"], False)) if status else "an", f["jur"])
        seg.append(lead)
        if ch["extra"]:
            lines = ["legal name: %s" % n]
            if "lei" not in drop:
                lines.append("LEI: %s" % f["lei"])
            if "number" not in drop and q != "live":
                lines.append("registration number: %s" % f["number"])
            lines.append("jurisdiction: %s" % f["jur"])
            if "city" not in drop:
                lines.append("registered city: %s" % f["city"])
            if addr and q == "full_onboard":
                lines.append("registered address: %s" % addr)
            if "created" not in drop:
                lines.append("created: %s" % f["created"])
            if status:
                lines.append("status: %s" % st(f["active2"], False))
            seg.append(". ".join(x.rstrip(".") for x in lines) + ".")
    return " ".join(seg)


# ---- faults ------------------------------------------------------------------------------------------

def apply_fault(rng, kind, f, rec, q, other, asof):
    w = dict(f)
    if kind == "country_code":
        w["cc"] = foreign(rng, f["cc"])
    elif kind == "jurisdiction":
        j = foreign(rng, f["cc"])
        w["jur"] = j
    elif kind == "city":
        w["city"], w["region"], w["post"] = pick_city(rng, foreign(rng, f["cc"]))
    elif kind == "address":
        cc2 = foreign(rng, f["cc"])
        c = COUNTRIES[cc2]
        w["street"] = rng.choice(c["streets"])
        w["city"], w["region"], w["post"] = pick_city(rng, cc2)
        w["cc"] = cc2
        if rng.random() < 0.5:
            w["jur"] = cc2
    elif kind == "contradiction":
        w["active2"] = not f["active"]
    elif kind == "dropped_field":
        w["drop"] = (rng.choice(QFIELDS[q]),)
    elif kind == "bad_lei":
        L = f["lei"]
        w["lei"] = L[:-rng.choice([1, 2, 3])] if rng.random() < 0.5 else L + rng.choice(string.digits + "ABCDEF")
    elif kind == "impossible_date":
        w["created"] = (asof + dt.timedelta(days=rng.randrange(30, 900))).isoformat()
    elif kind == "flip_status":
        w["active"] = not f["active"]
        w["active2"] = not f["active2"]
    elif kind == "other_entity":
        pick = rng.choice(["lei", "number", "city"])
        if pick == "lei":
            w["lei"] = other["lei"]
        elif pick == "number":
            w["number"] = other["number"]
        else:
            w["city"], w["region"], w["post"], w["cc"] = other["city"], other["region"], other["post"], other["cc"]
    return w


# where each fault can show in each question's answer
SHOWS = {
    "country_code": {"status_address", "status_city", "status_legal_city", "address", "record_json", "full_onboard"},
    "jurisdiction": {"jur_city", "kind_incorp", "address", "live", "record_json", "full_onboard"},
    "city": {"status_city", "status_legal_city", "city_status", "jur_city", "address", "status_address", "record_json", "full_onboard"},
    "address": {"status_address", "address", "full_onboard"},
    "contradiction": {"live", "record_json", "full_onboard"},
    "dropped_field": set(QTYPES),
    "bad_lei": {"live", "record_json", "full_onboard", "regnum", "kind_incorp"},
    "impossible_date": {"kind_incorp", "live", "record_json", "full_onboard"},
    "flip_status": {"status_address", "status_city", "status_legal_city", "city_status", "regnum", "live", "record_json", "full_onboard"},
}
JSON_ORDER = ["legal_name", "lei", "registration_id", "registration_authority", "entity_type", "active", "entity_status",
              "jurisdiction", "registered_city", "registered_address", "entity_creation_date", "lei_registration_status"]


def make_pair(rng):
    rec = make_record(rng)
    asof = dt.date(2026, rng.randrange(1, 12), rng.randrange(1, 28))
    rec["asof"] = asof
    q = rng.choice(QTYPES)
    evidence = "search" if rng.random() < 0.25 else "none"
    other = None
    prompt = question(rng, q, rec, show_lei=rng.random() < 0.7)
    if evidence == "search":
        stem = rec["name"].split(" ")[0]
        other = make_record(rng, cc=foreign(rng, rec["cc"]) if rng.random() < 0.6 else rec["cc"])
        oc = COUNTRIES[other["cc"]]
        other["name"] = "%s %s %s" % (stem, rng.choice(["INTERNATIONAL", "Holdings", COUNTRIES[other["cc"]]["name"].replace("the ", "").upper(), "Services"]), rng.choice(oc["forms"])[0])
        prompt += search_block(rng, rec, other, asof)
    f = facts(rec)
    if evidence == "search" and rng.random() < 0.45:
        kind = "other_entity"
    else:
        pool = [k for k, qs in SHOWS.items() if q in qs]
        weights = {"flip_status": 2.4 if evidence == "search" else 1.8, "dropped_field": 0.5, "city": 3.5, "country_code": 3.0, "jurisdiction": 3.0, "address": 2.5, "contradiction": 0.6, "bad_lei": 0.6, "impossible_date": 0.6}
        kind = rng.choices(pool, weights=[weights.get(k, 1.0) for k in pool])[0]
    w = apply_fault(rng, kind, f, rec, q, other, asof)
    style = "json" if q in ("record_json", "full_onboard") and rng.random() < 0.7 else ("json" if rng.random() < 0.12 else "text")
    order = JSON_ORDER[:2] + rng.sample(JSON_ORDER[2:], len(JSON_ORDER) - 2)
    ch = dict(style=style, order=order, summary=rng.random() < 0.5, checked=rng.random() < 0.4, asof=asof.isoformat(),
              upper=rng.random() < 0.8, region=rng.random() < 0.3, variant=rng.randrange(3), extra=rng.random() < 0.6)
    chosen, rejected = render(f, q, ch), render(w, q, ch)
    if chosen == rejected:
        return None
    return dict(prompt=prompt, chosen=chosen, rejected=rejected, worse_kind=kind, evidence=evidence, style=style + ":" + q)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    seen, rows = set(), []
    while len(rows) < args.n:
        r = make_pair(rng)
        if r is None or r["rejected"] in seen:
            continue
        seen.add(r["rejected"])
        rows.append(r)
    with open(args.out, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
