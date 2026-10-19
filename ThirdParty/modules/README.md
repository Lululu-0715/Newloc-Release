# Newloc 第三方代理模块

这个目录里的 5 个文件是**同一份 WLOC 改写规则**，分别写成了各家代理客户端
认识的不同格式。**用哪一个只取决于你手机上装的是哪个客户端**，功能完全一致。

> **App 会自动帮你挑。** 在 Newloc 的「设置 → 第三方代理」里选中客户端后，
> 点「复制模块订阅地址」拿到的就是对应文件，不需要你在这里手动判断。
> 下面这张表是给手动导入、或者排查问题时对照用的。

脚本本体在上一级目录（`wloc.js` 负责改写定位响应，`wloc-settings.js` 负责接收
App 写入的坐标）。本目录的模块文件只是「外壳」——告诉客户端去哪儿加载脚本、
要 MITM 哪些域名。

---

## 哪个文件配哪个客户端

| 文件 | 对应客户端 | 格式特征 |
|---|---|---|
| [`wloc.module`](wloc.module) | **Shadowrocket**（小火箭） | `[Script]` 段 + `type=http-response` / `http-request` |
| [`wloc.sgmodule`](wloc.sgmodule) | **Surge**、**Egern** | `[Script]` 段 + `type=http-response,pattern=...` |
| [`wloc.conf`](wloc.conf) | **Quantumult X** | 远程重写资源：`hostname =` 行 + 裸重写规则（**不能带段名**） |
| [`wloc.lpx`](wloc.lpx) | **Loon** | `#!name=` 开头的插件格式 |
| [`wloc.stoverride`](wloc.stoverride) | **Stash** | YAML override（`http.mitm` / `http.script`） |

⚠️ **Surge 和 Egern 共用 `wloc.sgmodule`**。这不是偷懒——两者都实现了 Surge
的模块格式，同一个文件可以直接导入。

⚠️ **小火箭没有 `[Rewrite]` 这个段名**。它的模块只提供 `[General]` `[Rule]`
`[Host]` `[URL Rewrite]` `[Header Rewrite]` `[Body Rewrite]` `[Map Local]`
`[Script]` `[MITM]`，脚本一律写在 `[Script]` 段里。1.0.7 及以前本仓库的
`wloc.module` 写成了 `[Rewrite]` 配 `url script-response-body`（那是
Quantumult X 的语法），小火箭读不懂，导入后模块完全不生效。
`Tests/check_proxy_modules.py` 第 3 项现在锁死了这一点。

---

## 导入地址

把对应那一行粘进客户端的「导入模块 / 添加订阅」即可。

**默认地址走 jsDelivr**（`cdn.jsdelivr.net`），因为它有真正的 CDN，
国内大多能直连；`raw.githubusercontent.com` 在国内基本拉不到，
而**拉不到脚本的表现是静默失效**——模块显示已启用、定位却纹丝不动，
或者过一会自己恢复真实位置。

| 客户端 | 导入地址 |
|---|---|
| Shadowrocket | `https://cdn.jsdelivr.net/gh/Lululu-0715/Newloc@main/ThirdParty/ProxyScripts/modules/wloc.module` |
| Surge | `https://cdn.jsdelivr.net/gh/Lululu-0715/Newloc@main/ThirdParty/ProxyScripts/modules/wloc.sgmodule` |
| Egern | `https://cdn.jsdelivr.net/gh/Lululu-0715/Newloc@main/ThirdParty/ProxyScripts/modules/wloc.sgmodule` |
| Quantumult X | `https://cdn.jsdelivr.net/gh/Lululu-0715/Newloc@main/ThirdParty/ProxyScripts/modules/wloc.conf` |
| Loon | `https://cdn.jsdelivr.net/gh/Lululu-0715/Newloc@main/ThirdParty/ProxyScripts/modules/wloc.lpx` |
| Stash | `https://cdn.jsdelivr.net/gh/Lululu-0715/Newloc@main/ThirdParty/ProxyScripts/modules/wloc.stoverride` |

直接在客户端里搜文件名是搜不到的，**要粘完整地址**。

> **jsDelivr 有缓存**：对分支（`@main`）最长缓存 12 小时。刚更新完脚本、
> 手机上还是旧行为时，要么等一等，要么把地址里的
> `https://cdn.jsdelivr.net/gh/Lululu-0715/Newloc@main/`
> 换成 `https://raw.githubusercontent.com/Lululu-0715/Newloc/main/` 临时验证
> （raw 直读仓库、没有缓存，但国内通常连不上）。
> 应用内「设置 → 连接状态 → 第三方代理」里的模块基地址也可以直接改，
> 改完点「复制模块订阅地址」拿到的就是新地址。

---

## 导入之后必须做两件事

1. **开启模块**（导入完默认可能是关闭状态）；
2. **开启 MITM**，并确认下面这 14 个主机名已加进 MITM 名单：

```
gs-loc.apple.com
gs-loc-cn.apple.com
gsp-ssl.ls.apple.com
gsp10-ssl.ls.apple.com
gsp10-ssl.apple.com
gsp64-ssl.ls.apple.com
gspe1-ssl.ls.apple.com
gspe19-ssl.ls.apple.com
gspe19-2-ssl.ls.apple.com
gspe35-ssl.ls.apple.com
gspe79-ssl.ls.apple.com
gspe85-ssl.ls.apple.com
bluedot.is.autonavi.com
bluedot.is.autonavi.com.gds.alibabadns.com
```

前两台是 Apple 的全球 / 国内定位入口，中间那批 `gsp*` / `gspe*` 是
**新版本系统把定位查询分散过去的备用入口**。只拦前两三台的话，在 iOS 26+
上会表现成「模块装了、MITM 也开了，定位就是纹丝不动」。最后两台是
Apple 地图在国内使用的蓝点定位（高德）端点。

`wloc.module`（Shadowrocket）、`wloc.sgmodule`（Surge / Egern）两个文件的
`hostname` 用的是 `%APPEND%` 前缀，导入时会**追加**到你的 MITM 名单，
不会覆盖已有配置；`wloc.lpx`（Loon）、`wloc.stoverride`（Stash）是直接列出的，
导入后建议自己核对一眼。

---

## Quantumult X 特别注意

Quantumult X 有两种长得很像、但**互不兼容**的格式，装错了就是「配置失败、未生效」：

| 格式 | 长什么样 | 用在哪 |
|---|---|---|
| 主配置 `.conf` | 有 `[rewrite_local]`、`[mitm]` 等段名 | 手动复制粘贴进 QX 主配置 |
| **远程重写资源** | **没有段名**，只有一行可选 `hostname = ...` 加若干条规则 | 设置 → 重写 → 引用 |

本仓库的 `wloc.conf` 是给**第二种**用的（直接用 URL 导入），所以里面
**故意不带段名**。这是 QX 官方 `sample-import-rewrite.snippet` 的格式：

```text
; hostname line is optional.
hostname = *.example.com, *.sample.com
^http://example\.com/resource2/ url 302 http://example.com/new-resource2/
```

正确导入步骤：

1. 打开 Quantumult X → **设置 → 重写 → 引用 → 添加订阅**；
2. 粘贴 `.../modules/wloc.conf` 的完整 raw 地址，确认添加；
3. 回到 **设置 → MITM**，确认 **MITM 开关已打开**，并检查主机名列表里
   有没有上面的 14 个域名（导入时会自动并入，个别版本需要手动补）；
4. 在主界面的「重写」里确认这条引用处于**启用**状态。

> 如果 QX 提示「配置失败」，八成是文件里带上了 `[rewrite_local]` 之类的段名。
> `python3 Tests/check_proxy_modules.py` 会拦住这种写法。

---

## 三个最常见的坑

### 0. 脚本拉不到（表现为「过一会自己恢复真实位置」）

模块文件只是外壳，真正的改写逻辑在两个 `.js` 里，**由客户端在每次请求时去拉**。
拉不到时的表现非常隐蔽：模块开关看着是开的，客户端也不报错，但改写没发生。
典型的两种观感：

- 切出去一分钟后定位自己恢复成真实位置（客户端重新拉脚本失败，规则失效）；
- 状态显示「已连接」，定位却纹丝不动。

所以默认地址用的是 jsDelivr。如果换了自建地址、或者用了 raw 地址，
请确认手机在那个网络下确实能打开脚本 URL。

### 1. 每个客户端要各自生成一次 CA，不能混用

每个代理客户端的根证书与它自己绑定。把 Surge 的 CA 拿给 Egern 用，
**MITM 会静默失败且不报错**——模块看着装好了、开关也开着，定位就是不变。

| 客户端 | 生成路径 |
|---|---|
| Surge | 设置 → MITM → 生成 CA |
| Egern | 设置 → MitM → 生成 CA |
| Shadowrocket | 设置 → 证书 → 生成新的 CA |
| Quantumult X | 设置 → MITM → 生成证书 |
| Loon / Stash | 设置 → MitM → 生成 CA |

生成后还要去 iOS「设置 → 通用 → 关于本机 → 证书信任设置」里逐个打开。

### 2. 绝不要给被拦截的主机加 DIRECT 规则

```ini
# 千万别这么写
DOMAIN,gs-loc.apple.com,DIRECT
```

这会让流量**绕过代理直连**，模块看起来安装成功却永远不会触发——
因为请求根本没经过 MITM。仓库里的检查脚本会拦住这种写法
（`Tests/check_proxy_modules.py` 第 5 项）。

---

## 脚本地址写死在本仓库

模块文件里的脚本 URL 指向本仓库的 raw 地址。**fork 或迁移到其他账号后
必须同步替换**，否则客户端拉脚本会 404。改动点见
[BUILD.md 第 7 节](../../../docs/BUILD.md)，改完用
`python3 Tests/check_branding.py` 验证一致性。

另外，仓库必须保持**公开**——私有仓库的 raw 地址客户端访问不到。
