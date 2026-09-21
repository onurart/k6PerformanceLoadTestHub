# k6 kapasite ve stres testi

Bu paket HTTP tabanlı k6 kullanır; gerçek tarayıcı çalıştırmaz. Betik kendiliğinden başlamaz. Tüm çalışma ayarları
`config.env` dosyasından okunur; testi başlatmak için yalnızca `./baslat.sh` çalıştırılır.

## Güvenlik sınırları

- Testi yalnızca size ait hedefte, onaylı zaman aralığında çalıştırın. `TARGET_URL` tek bir origin olmalıdır.
- Redirect takibi kapalıdır (`redirects: 0`); başka alan adları ve üçüncü taraflar yük testine girmez.
- Bilgisayar adı, işletim sistemi, cihaz kimliği veya tarayıcı bilgisi eklenmez. `User-Agent` hem k6 ayarında hem istek başlığında
  boş bırakılır. `X-Forwarded-For`, `X-Real-IP`, `Forwarded` ve istemci ipucu başlıkları eklenmez; IP/tarayıcı taklidi,
  proxy rotasyonu veya güvenlik engeli aşma yoktur. Buna rağmen gerçek kaynak IP ağ seviyesinde sunucu, yük dengeleyici ve
  güvenlik duvarı tarafından görülebilir.
- Bilinmeyen API uçları uydurulmaz. `ENDPOINTS_JSON` yalnızca sizin doldurduğunuz yolları kullanır.
- POST/PUT/PATCH/DELETE ancak `ALLOW_STATE_CHANGING=true TEST_ENVIRONMENT=true TEST_ACCOUNT_ID=...` üçlüsüyle açılır.
  Para yatırma, bahis ve ödeme gibi işlemleri yalnızca açıkça tanımlanmış, izole test ortamı ve test hesaplarıyla ekleyin.
- Sunucunun kilitlenmesi beklenmez. Isınmadan sonra hata oranı veya p95 eşiği aşılırsa k6 yerel testi; dağıtık kullanımda
  koordinatör tüm makineleri durdurur.

## Yapılandırma

`config.env` aktif ayar dosyasıdır; `.env.example` düşük değerli örnek şablondur. Başlıca değişkenler:


| Değişken            |       Varsayılan | Anlamı                                   |
| --------------------- | ----------------: | ----------------------------------------- |
| `TARGET_URL`          | `https://url.com` | Yalnızca hedef origin                    |
| `ENDPOINTS_JSON`      |     ana sayfa GET | Endpoint, yöntem, beklenen kod/içerik   |
| `SCENARIO`            |           `smoke` | `smoke/load/stress/spike`                 |
| `MAX_RPS` / `MAX_VUS` |             5 / 5 | Bütün makinelerin toplam üst sınırı |
| `TEST_DURATION`       |              `1m` | Senaryo basamağı/sabit yük süresi     |
| `WARMUP_DURATION`     |             `15s` | Eşik değerlendirmesinden önce ısınma |
| `P95_LIMIT_MS`        |              1500 | Otomatik durdurma p95 sınırı           |
| `ERROR_RATE_LIMIT`    |              0.02 | Otomatik durdurma hata oranı             |
| `REQUEST_TIMEOUT`     |             `10s` | İstek timeout'u                          |

Endpoint örneği:

```bash
export ENDPOINTS_JSON='[
  {"name":"home","method":"GET","path":"/","expected_statuses":[200],"expected_body":"Beklenen metin"},
  {"name":"health","method":"GET","path":"/GERCEK-HEALTH-YOLUNUZ","expected_statuses":[200],"expected_body":"ok"}
]'
```

Boş `expected_body` her yanıtı içerik açısından geçirir; gerçek bir ayırt edici metin yazmanız önerilir. Endpoint'ler sırayla
seçilir. Kimlik bilgilerini dosyaya koymayın; gerekiyorsa yalnız test hesabına ait değerleri güvenli secret mekanizmasından verin.

## Tek makinede çalıştırma

Önce `k6` kurulu olmalıdır. Senaryo, limit, süre ve eşikleri `config.env` içinde düzenleyin, ardından çalıştırın:

```bash
./baslat.sh
```

Farklı bir ayar dosyası gerekiyorsa: `CONFIG_FILE=config.staging.env ./baslat.sh`.

`MAX_RPS` geliş hızını sınırlar. Sunucu yavaşladığında VU tükenirse k6 hedef RPS'yi üretemeyebilir; `dropped_iterations`
bu durumu gösterir. `MAX_VUS` hiçbir makinede aşılamaz.

## Dağıtık çalışma

VPN tek başına farklı bölgelerden eşzamanlı trafik üretmez; yalnızca tek çalıştırıcının çıkış noktasını değiştirir. Gerçek
dağıtık test için kontrolünüzdeki farklı bölgelerde bulunan ayrı makineleri aynı anda çalıştırın. Tüm makinelerde aynı betik,
`MACHINE_COUNT`, global `MAX_RPS/MAX_VUS` ve eşsiz sıfır tabanlı `MACHINE_INDEX` kullanılmalıdır. Betik limitleri bölüm/kalan
yöntemiyle paylaştırır; makine eklemek toplam yükü katlamaz.

1. Yalnız güvenilir özel kontrol ağında koordinatörü başlatın:

```bash
python3 distributed/coordinator.py --listen 0.0.0.0 --port 8787 \
  --warmup 15 --window 10 --error-rate 0.02 --p95-ms 1500 --min-samples 20
```

2. Her makinedeki `config.env` dosyasında aynı global limitleri ve makineye özgü bölge/index değerlerini ayarlayın:

```dotenv
# Avrupa makinesi
REGION_TAG="eu"
MACHINE_COUNT="2"
MACHINE_INDEX="0"
MAX_RPS="20"
MAX_VUS="30"
COORDINATOR_URL="http://KONTROL-AGI-IP:8787"
```

Amerika makinesinde `REGION_TAG="us"` ve `MACHINE_INDEX="1"` kullanın. Sonra her iki makinede yalnızca:

```bash
./baslat.sh
```

Çalıştırıcı k6'nın JSON metriklerini saniyelik olarak koordinatöre yollar. Koordinatör ısınma sonrasında kayan pencerede toplam
hata oranı ve p95'i değerlendirir. Eşik aşılınca `/state` stop durumuna geçer; bütün çalıştırıcılar en geç yaklaşık bir saniye
artı ağ gecikmesi içinde kendi k6 süreçlerine SIGINT gönderir. Kontrol servisinin kimlik doğrulaması yoktur; internete açmayın,
özel ağ/firewall kullanın. Koordinatör durduğunda `distributed-summary.json`; her makine de bölgesel k6 özetini üretir.

## Rapor ve kapasiteyi yorumlama

Normal tek makine çalışmasında ekrandaki bütün çıktı ve test sonu özeti `log/k6-<bölge>-<makine>-<tarih>.log`
dosyasına da yazılır. Özet; HTTP durum sınıfları, başarısız istek oranı, RPS, p50/p95/p99 gecikme, timeout ve içerik
doğrulama hatalarını içerir.

`LOG_EACH_REQUEST="true"` iken her istek için zaman, `BAŞARILI/BAŞARISIZ`, endpoint, HTTP kodu, yanıt süresi ve timeout
bilgisi loglanır. Başarı yalnız beklenen HTTP kodu ve beklenen içerik doğrulandığında verilir. Test sonundaki “Gerçek ortalama
RPS” üretilen yükü; “Atlanan iterasyon” ise yük üreticisinin hedef RPS'ye yetişemediği istek sayısını gösterir. Çok yüksek
yüklerde istek başına disk/terminal loglaması ölçümü etkileyebileceğinden `LOG_EACH_REQUEST="false"` kullanılmalıdır.

`SAVE_JSON_RESULTS="true"` yapılırsa aynı özetin makine tarafından okunabilir JSON sürümü `results/` içine yazılır.
Varsayılan `false` değerinde normal testte `results/` kullanılmaz. Dağıtık modda ise merkezi çalıştırıcının makinelerden gelen
metrikleri canlı okuyabilmesi için `results/raw-*.json` zorunlu geçici/ham telemetri kaydıdır; merkezi rapor ayrıca bölge
bazında ve toplam sonuç verir. Ham dosyalar test tamamlandıktan ve rapor saklandıktan sonra arşivlenebilir veya silinebilir.

Kapasite sınırı, ilk kez p95/hata eşiğinin aşıldığı yük basamağının hemen altındaki sürdürülebilir RPS/VU olarak ele alınmalıdır.
Bir sonraki daha düşük basamakta daha uzun bir load testiyle doğrulayın. Yük üreticisinin `dropped_iterations` veya CPU sınırına
takılmadığını ayrıca kontrol edin.

k6 yalnız istemci tarafından görülen HTTP davranışını ölçer. Aynı zaman çizelgesinde sunucu CPU/RAM, veritabanı bağlantı havuzu,
sorgu gecikmesi, cache hit oranı, iş parçacığı havuzları ve kuyruk derinliklerini ayrıca izleyin; darboğazın nedeni ancak bu
telemetriyle belirlenebilir.
