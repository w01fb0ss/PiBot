# Pi Bot

**Masaüstünüz için açık kaynaklı, yerel öncelikli bir yapay zekâ ajan ekibi.** Adlandırılmış yapay zekâ Botları kendi bilgisayarınızda çalışır: biriyle sohbet edin veya birkaçını bir grup sohbetine alın; plan yapar, komut çalıştırır, dosya düzenler, web'de gezinir ve bilgisayarınızı kullanırlar, riskli her adım ise onayınızı bekler. macOS, Windows ve Linux'ta çalışır ve bir Android uygulaması vardır. [pi](https://github.com/earendil-works/pi) ajan çekirdeği üzerine inşa edilmiştir.

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="https://github.com/w01fb0ss/PiBot/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/w01fb0ss/PiBot?include_prereleases"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Android-lightgrey">
  <a href="https://pibot.space"><img alt="Website" src="https://img.shields.io/badge/website-pibot.space-8b5cf6"></a>
  <a href="https://pibot.space/en/guides/"><img alt="Docs" src="https://img.shields.io/badge/docs-pibot.space%2Fen%2Fguides-0ea5e9"></a>
</p>

<p align="center">
  <a href="docs/assets/pibot-intro-60s.mp4"><img src="docs/assets/pibot-intro-15s.gif" width="800" alt="15 saniyede Pi Bot (sesli 60 saniyelik video için tıklayın)"></a>
</p>

<p align="center">▶ <a href="docs/assets/pibot-intro-60s.mp4">60 saniyelik videoyu izleyin</a> · <a href="https://pibot.space">İndir</a> · <a href="docs/guide/README.md">Kullanıcı kılavuzu</a> · <a href="https://pibot.space/en/guides/">Çevrimiçi belgeler</a></p>

[English](README.md) · [中文](README.zh-CN.md) · [日本語](README.ja.md) · [Türkçe](README.tr.md)

Pi Bot, adlandırılmış Botlardan oluşan bir ekibin kendi bilgisayarınızda çalıştığı bir masaüstü uygulamasıdır. Bir Bot ile doğrudan sohbet edebilir veya birkaçını bir grup sohbetine alıp onlara bir çalışma klasörü verebilirsiniz; plan yapar, komut çalıştırır, dosya düzenler ve işi birbirine devrederler, riskli her adım ise onayınızı bekler. "Beyin" de makinenizde çalışır: sohbetler, dosyalar, bellek ve anahtarlar yerelde kalır ve gönderdiğiniz istemleri yalnızca seçtiğiniz model sağlayıcısı görür.

Web sitesi ve indirmeler: <https://pibot.space> · Kullanıcı kılavuzu: [docs/guide](docs/guide/README.md) · Çevrimiçi belgeler: <https://pibot.space/en/guides/>

## Neler yapar

- **Botlar ve roller.** Bir ada, bir role (geliştirici, araştırmacı, yazar, çevirmen, …), kendi modeline, becerilerine, izinlerine ve belleğine sahip Botlar oluşturun.
- **Doğrudan ve grup sohbetleri.** Bir grupta planlama yapan, adımları üyelere devreden ve sonuçları toplayan bir koordinatör bulunur; plan çalıştırılmadan önce onaylarsınız.
- **Çalışma klasörleri ve değişiklikler.** Botlar seçtiğiniz klasörler içinde çalışır. Her değişiklik listelenir, gözden geçirilebilir ve macOS'ta otomatik kontrol noktalarından geri yüklenebilir.
- **Onaylar ve izinler.** Her araç çağrısı tek bir politika motorundan geçer. Komutlar bir korumalı alanda ([`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)) çalıştırılır ve onaylar, komutlar ile dışarıya gönderilen her şey bir denetim günlüğüne yazılır.
- **Rutinler ve yapılacaklar.** Zamanlanmış, klasör tarafından tetiklenen ve bağlantı tarafından tetiklenen görevler.
- **Bağlantılar.** Uygulamalar, MCP sunucuları, beceriler ve bilgi tabanları.
- **Modeller.** Ollama aracılığıyla yerel modeller, OpenRouter, kendi API anahtarlarınız ve desteklenen abonelik oturum açmaları.
- **İsteğe bağlı diğer cihazlar.** Bir Android uygulaması, başka bilgisayarlarda veya sunucularda çalışan yürütücüler (runners), kendi barındırabileceğiniz bir aktarıcı (relay) ve ACP üzerinden düzenleyicilerden kullanım.

Pi Bot; macOS 13 Ventura veya üzeri, Windows 10 / 11 ve 64-bit Linux üzerinde çalışır. Telemetri içermez ve Pi Bot'un kendi sunucuları sohbetlerinizi veya dosyalarınızı asla almaz. Seçtiğiniz model sağlayıcısı dışında yalnızca güncelleme kontrolleri, Botlarınızın kullandığı web siteleri ve aramalar ile açtığınız özellikler (telefon, yürütücüler, bağlantılar) için bağlantı kurar; her biri önceden açıklanır. Tüm giden bağlantılar için [docs/privacy](docs/privacy/en/outbound-connections.md) dosyasına bakın.

## Kurulum

Masaüstü uygulamasını <https://pibot.space> adresinden indirin, ardından [Başlangıç](docs/guide/en/01-getting-started.md) kılavuzunu izleyin.

## Kaynaktan derleme

Gereksinimler: [`.nvmrc`](.nvmrc) dosyasındaki Node sürümü ve pnpm 12.

```sh
git clone https://github.com/w01fb0ss/PiBot.git
cd PiBot
nvm use
pnpm install
pnpm dev        # masaüstü uygulamasını geliştirme modunda başlat
```

Geliştirme verilerini kurulu bir Pi Bot'tan ayrı tutmak için `PIBOT_DATA_DIR` değişkenini ayarlayın. Diğer komutlar:

| Komut | Amaç |
|---|---|
| `pnpm check` | Frozen install, tür denetimi, lint, politika matrisi ve testler |
| `pnpm check:changed [base]` | Aynı denetimler yalnızca değişen kısımlarla sınırlı |
| `pnpm verify` | `check`, derleme, renderer duman testi ve uçtan uca kabul test paketleri |
| `pnpm build` | electron-vite derlemesi (yükleyici olmadan) |

## Depo yapısı

| Yol | İçerik |
|---|---|
| `apps/desktop` | Electron uygulaması (ana süreç, renderer, paketleme) |
| `apps/mobile` | Android uygulaması (React Native + Expo) |
| `apps/relay` | Telefon ve yürütücü bağlantıları için aktarıcı (Cloudflare Worker) |
| `apps/runner`, `apps/cli` | Başsız (headless) yürütücü ve komut satırı girişi |
| `apps/plugins` | Dahili eklentiler (MCP ve/veya beceriler) |
| `packages/teams/builtin` | Çevrimdışı kullanım için dahil edilen roller ve gruplar; tam rol kütüphanesi [pibot-roles](https://github.com/w01fb0ss/pibot-roles) deposundadır |
| `packages/*` | Beş katman halinde beyin ve yetenekleri; bkz. [AGENTS.md](AGENTS.md) |
| `docs/guide`, `docs/privacy` | Kullanıcı kılavuzu ve giden bağlantı notları |
| `tests`, `tools` | Uçtan uca test paketleri, sahte model ve geliştirme araçları |

Ajan çekirdeği [pi](https://github.com/earendil-works/pi)'dir, npm bağımlılığı olarak sabitlenmiştir ve yalnızca `packages/agent` içinde kullanılır. Beyin Electron'a bağımlı değildir, bu nedenle aynı kod başsız olarak da çalışır.

## Topluluk

Sorular sormak, Botlarınızın neler yaptığını paylaşmak ve yeni sürümlerden ilk siz haberdar olmak için Pi Bot Telegram grubuna katılın: [t.me/+zzEe3q-8QflkOTJl](https://t.me/+zzEe3q-8QflkOTJl)

## Katkıda bulunma

Sorun bildirimleri (issue) ve çekme istekleri (pull request) memnuniyetle karşılanır. Lütfen önce [CONTRIBUTING.md](CONTRIBUTING.md) dosyasını ve [AGENTS.md](AGENTS.md) içindeki kuralları okuyun; güvenlik sorunlarını herkese açık issue'larda değil, [SECURITY.md](SECURITY.md) dosyasında açıklandığı şekilde bildirin.

## Katkıda bulunanlar

Pi Bot'a katkıda bulunan herkese teşekkürler. GitHub üzerindeki [katkı etkinliğine](https://github.com/w01fb0ss/PiBot/graphs/contributors) göz atın.

<!-- CONTRIBUTORS:START -->
- [@w01fb0ss](https://github.com/w01fb0ss)
- [@agooll](https://github.com/agooll)
- [@rajnishmanitiwari](https://github.com/rajnishmanitiwari)
- [@juemimgcd](https://github.com/juemimgcd)
- [@eltociear](https://github.com/eltociear)
<!-- CONTRIBUTORS:END -->

## Yıldız Geçmişi

<a href="https://www.star-history.com/#w01fb0ss/PiBot&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=w01fb0ss/PiBot&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=w01fb0ss/PiBot&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=w01fb0ss/PiBot&type=Date" />
  </picture>
</a>

## Lisans

[Apache License 2.0](LICENSE). Atıflar için [NOTICE](NOTICE) ve [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) dosyalarına bakın.
