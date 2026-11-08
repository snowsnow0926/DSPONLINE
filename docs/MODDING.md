# 内容包 Mod 编写指南

> **2026-11-08 开发补充，尚未发布**：当前源码新增格式 v5 的原版物品/传送带覆盖、安全改名入口和残留清理卸载。正式网页/Android 1.3.9 与 Windows 1.3.10 仍使用 v4 能力；v5 包需等待对应新版本发布，不能导入旧客户端。v1～v4 继续兼容。

> 本文包含`1.3.9` 版本更新：内容包格式 `formatVersion: 4`，继续读取 v1/v2/v3。正式三端版本仍以发布记录为准。
>
> 本项目把 Mod 称为“内容包”。格式与行为的最终依据是 [`src/game/mods.ts`](../src/game/mods.ts) 和 [`src/game/contentPacks.ts`](../src/game/contentPacks.ts)；内容包只能使用经过校验的声明式 JSON，不能执行 JavaScript。

## 1. 当前 Mod 能做什么

内容包是一个 UTF-8 JSON 文件，不执行 JavaScript，也不能访问浏览器、网络或玩家文件。当前最稳定的用法是：

- 新增物品；
- 新增可制造、可部署的通用建筑，或给核心建筑新增普通生产配方；
- 新增科技，并用科技控制新配方的解锁；
- 用 `handcraftable` 设置配方能否手合；在管理器中直接编辑 JSON、切换手合和选择解锁科技；
- 用 `recipeOverrides`、`technologyOverrides` 和 `constructionOverrides` 调整核心配方、科技前置/成本和建筑施工解锁；
- 通过安全字段白名单调整核心建筑速度、功率、缓存、堆叠和储能数据；
- 新增 4～32 级的自定义传送带及其速度、科技和制造成本；
- 让带有有效制造成本的自定义建筑进入桌面和移动端部署托盘，并按通用 `kind` 稳定归类；
- 声明其他内容包依赖，按版本检查、注册、启用和停用；
- 让新物品、建筑、配方、科技和线路等级进入运行时目录、生产模拟和存档。
- 同 ID、保留旧定义的兼容更新可直接应用，保留库存、设备、研究和旧版存档读取；自动保留最近五个旧版配置供导出。
- v4 提供实际科技倍率、建筑配方白名单、配方组解锁、自定义燃料与发电机、现有行星上的自定义矿点；网页、实时/离线 Worker 与 Windows 原生目录共用同一规则。
- 可视化作者工具可编辑物品、建筑、配方、科技及规则；支持内嵌图片图标、分类和显式旧 ID 迁移。
- v5 可覆盖原版物品的展示字段，以及原版传送带的名称、真实速度、制造成本、产量和解锁科技。

以下能力仍不开放：

- 删除核心物品、配方、科技，修改原版物品物态/ID、原版传送带等级/ID，或修改覆盖白名单以外的字段；
- 执行自定义脚本、注册事件钩子或修改模拟器算法；
- 增加音频、字体、独立 UI、行星、战役、成就或任意自定义存档字段；
- 科技执行任意代码或未列出的属性。`unlocks` 仍是展示文本，实际效果使用 `technologyEffects`，门禁使用 `requiredTechId` / `recipeGroups`；
- 自定义物流载具或专属检查器。建筑仍复用现有通用 `kind` 行为，元数据不能替代模拟规则。

## v4 作者工具与规则

“运营中心 → 内容包 → 可视化作者工具”提供空白包及可运行的“晶体工业示例”。选择编辑类别，逐项修改字段，点击“校验全部配置”，核对新增/修改与兼容性预览，再注册启用。表单与 JSON 使用同一草稿；未应用的草稿不会改变工厂。存档仍为 GameState v47，新增矿点沿用现有实体结构。

| 字段 | 单项结构 | 实际效果 |
| --- | --- | --- |
| `technologyEffects` | `technologyId`, 可选 `productionSpeed`, `powerConsumption`, `miningSpeed`, `storageCapacity` | 对应科技已完成后生效。每项为 0.01～100 倍，1 为原值；按包依赖和声明顺序相乘，每步限制到 0.01～100。生产倍率用于生产配方，科研速率沿用科研科技。容量作用于建筑输入/输出，仍受玩家缓存上限约束；不会删除超出新上限的存量。 |
| `recipePolicies` | `buildingId`, `recipeIds` | 明确指定该生产建筑可以使用的配方，替代默认配方族匹配；空数组禁用全部。已设置但新规则不允许的配方停止生产，库存保留。 |
| `recipeGroups` | `id`, `name`, `requiredTechId`, `recipeIds` | 同组配方统一解锁；同时属于多个组或有自身科技的配方必须满足全部条件。制造、手合、递归制造和规划均遵守门槛。 |
| `fuels` | `itemId`, `energyMj` | 将已有物品定义为燃料，热值大于 0，不超过 10 亿 MJ。 |
| `generators` | `buildingId`, `fuelItemIds`, `efficiency` | 为 `kind: power` 建筑设置可用燃料和 0～1 范围内的非零效率；输出功率由建筑 `powerGenerationKw` 决定，按实际电网需求耗料。未声明燃料的普通电力建筑提供连续功率。 |
| `resources` | `itemId`, `extractorBuildingId`, `planetIds`, `reserve` | 为包内固体或流体物品在指定现有类地行星创建矿点，使用 `kind: miner` 建筑采集。储量为 1～10¹² 整数；新档、装包或载入时仅补缺失矿点，不补满已消耗储量。遵守有限/无限资源设置。 |
| `categories` | `id`, `name` | 定义分类；物品、配方和建筑可引用 `categoryId`，物品/配方选择器支持分类检索与筛选。 |
| `idMigrations` | `kind`, `from`, `to` | 明确旧 ID 到本包同类新 ID 的映射，类型为 items/buildings/recipes/technologies/belts。保留实体身份和位置，改写内容引用；数值库存相加、大整数库存精确相加、科技进度取较高值。 |

物品、建筑、配方支持 `icon` 内嵌图片数据 URI，格式为 PNG/JPEG/WebP，文件不超过 132 KiB；作者工具可直接选取图片。禁止外部图片地址、SVG 与脚本。没有图标时使用原有符号。分类和图标不改变物料类型或生产规则。

示例规则：

```json
{
  "technologyEffects": [{ "technologyId": "my_efficiency", "productionSpeed": 2, "powerConsumption": 0.5, "miningSpeed": 2, "storageCapacity": 2 }],
  "recipePolicies": [{ "buildingId": "my_furnace", "recipeIds": ["my_plate_recipe"] }],
  "recipeGroups": [{ "id": "my_processing", "name": "材料加工", "requiredTechId": "my_efficiency", "recipeIds": ["my_plate_recipe"] }],
  "fuels": [{ "itemId": "my_ore", "energyMj": 12 }],
  "generators": [{ "buildingId": "my_generator", "fuelItemIds": ["my_ore"], "efficiency": 0.8 }],
  "resources": [{ "itemId": "my_ore", "extractorBuildingId": "my_drill", "planetIds": ["home"], "reserve": 100000 }]
}
```

这些 ID 必须由同包或已启用依赖提供，矩阵研究成本继续使用六种核心矩阵。[完整晶体工业示例](./examples/example-crystal-v4.content-pack.json)也可以从作者工具直接载入和导出。

### 安全改名与旧版存档

提高包版本，同时在新包中保留 `idMigrations`，例如 `{"kind":"items","from":"old_ore","to":"new_ore"}`。新物品定义、配方输入、燃料和资源规则都引用 `new_ore`。兼容检查会先按映射比较旧版定义，再检查类型、配方物料、设备能力和容量；没有映射的删改仍被拒绝。映射必须直达最终 ID，不允许链或循环，不能改核心 ID。再次改名时，保留每个历史来源并将目标统一更新到最终 ID；资源的矿机映射也必须保留，不能把已装设备无偿转换成别的矿机。

升级保留旧配置，原始导入文件不写回；读取时在正常迁移前改写库存、设备内容引用、物流、蓝图、队列和研究。合并存在非数值冲突或超过安全整数时取消应用，不写入半迁移的注册表。兼容更新会把已验证旧版本记录到 `compatibleSaveVersions`；导出新包携带这份记录，在另一台设备安装后也可读取这些旧版存档。作者手改该列表相当于声明对应版本兼容，应先用实际旧存档验证。

Windows 原生直接导入会先验证原文件的校验和，再对候选应用同样的 ID 迁移和缺失矿点补齐；不会写回原文件，也不会补满已有矿点。当前档仍引用包内资源、库存、蓝图或队列时，停用/移除继续受使用保护。

## v5 原版覆盖、安全改名与卸载

### 重写原版物品和传送带

作者工具新增“原版物品覆盖”“原版传送带覆盖”及“自定义传送带”分类。选择原版 ID 会载入原始定义，修改后与其他配置一起校验、预览和应用。

| 字段 | 可覆盖内容 | 保持的兼容边界 |
| --- | --- | --- |
| `itemOverrides` | `id` 指定原版物品；可改 `name`、`symbol`、`color`、`description`、内嵌 `icon` 和 `categoryId` | 不改物品 ID 或 `kind`，已有库存保持；燃料热值仍通过 `fuels` 设置 |
| `beltOverrides` | `id` 指定原版 Mk.I～Mk.III；可改 `name`、`speed`、`costs`、`outputAmount`、`requiredTechId` | 不改等级或库存 ID；速度实际参与实时、离线及原生目录；成本只影响之后的制造 |

`requiredTechId` 省略表示沿用原版，`null` 表示无需科技，也可以填写已知科技 ID。速度必须大于 0 且不超过 1000000 件/秒，成本数量与每批产量必须为正整数。多个包同时覆盖同一类原版目标会提示冲突。停用或移除包后恢复原版定义，不截断现有物资。

可直接使用[原版覆盖 v5 示例](./examples/example-core-overrides-v5.content-pack.json)。新增 4～32 级线路继续使用 `belts`，覆盖原版线路使用 `beltOverrides`，两者用途不同。

### 不手写映射的安全改名

更新同一个包时，根节点的**内容包 `id` 保持不变**，用 `version` 区分新版。包内物品、建筑、配方、科技或传送带 ID 可以改：

1. 载入已安装配置，在对应条目的“新 ID”中输入新值。
2. 点击“安全改名并更新引用”。工具同时更新物料、配方、资源采集、科技前置、燃料列表与配方分组等引用，生成 `idMigrations`，并自动提高补丁版本号。
3. 校验全部配置，确认兼容更新预览，再应用更新。

重复改名会把旧映射直接指向最终 ID，并保留每一个历史来源；不会生成链式映射。不能改为原版 ID、已有 ID 或历史来源 ID。手动编辑 JSON 仍需自行保持这些引用和映射完整；只改一处 `id` 不构成可迁移更新。原版展示名称的修改使用覆盖字段，不能通过改原版 ID 实现。

### 清理矿点和科技残留后卸载

空闲的自动资源点、已完成/排队的自定义科技及历史产量不再只能永久占用内容包。管理器会保留正常使用检查，并提供“清理残留并移除”：

1. 暂停工厂，查看清理预览，确认将删除的空闲矿点、科技记录（含已投入进度）、历史统计和数量恰为零的库存索引。正数库存不会被清理。
2. 若仍有真实库存、矿机、设备、线路、队列、蓝图或其他引用，先回收或移除它们。自定义线路的数字等级也参与检查，不会因只运原版物资而漏过。
3. 勾选确认后，先写入并验证完整回滚快照，再保存清理后的主档和新注册表。快照或主档写入失败会停止操作；配置写入失败会尝试恢复原主档，恢复失败时明确提示使用已保留快照。

真实物资、其他内容包和其他科技保持；已消耗的科研材料不返还。管理器保留最近 8 份已移除配置，且这些备份不发给模拟 Worker。恢复卸载前进度时，先从“已移除内容包配置备份”载入并注册启用对应配置，再恢复卸载前快照。普通读档或兼容更新仍不会补满已消耗矿量；主动清理矿点后重新安装属于新的资源配置启用。

“一键清空原版内容”的范围仍待玩家确认，本批没有把清空草稿、禁用原版目录或删除旧工厂混为同一个操作。

## 2. 五分钟做出第一个内容包

仓库提供了一个可直接导入的示例：[`example-dense-materials.content-pack.json`](./examples/example-dense-materials.content-pack.json)。它新增：

- 物品 `example_dense_plate`；
- 科技 `example_dense_materials`；
- 制造台配方 `example_dense_plate_recipe`。

使用步骤：

1. 先导出当前存档，并尽量使用单独的测试存档验证内容包。
2. 复制示例 JSON，至少修改内容包 `id`、`name`、`version` 和所有自定义内容 ID。
3. 桌面端打开“运营中心 -> 内容包”；新版手机端打开“更多 -> 内容包”。
4. 点击“选择 JSON”。校验通过后点击“注册并启用”。有依赖时，先安装并启用依赖包。
5. 在科技目录研究“致密材料学”，再在制造台或手工制造目录选择“致密合金板”。
6. 完成一次真实生产，保存并刷新页面，确认物品、科技、配方和库存仍然存在。

“运营中心 -> 存档”中的“内容包校验”只做只读检查；真正使用内容包还要到“内容包”页完成“注册并启用”。启用会立即重建当前运行时目录，不要求刷新页面；刷新后仍存在说明本机注册表已正确保存。

游戏内也可以点击“导出模板”获得空白的 `dsp-content-pack-template.json`。空白模板适合从零开始，仓库示例则适合验证完整的物品、配方和科技链。

v3 的可运行配置示例见 [配方与科技规则包](./examples/example-rules-v3.content-pack.json)。管理器支持载入已安装配置、编辑 JSON、查看逐项校验结果、预览兼容更新及导出旧版配置；配方预览中的手合开关和解锁科技选择会同步写回待应用配置。

## 3. 完整示例

下面是示例包的核心结构。JSON 不允许注释、尾随逗号或 `NaN`、`Infinity` 等非 JSON 数值。

```json
{
  "formatVersion": 2,
  "id": "example_dense_materials_pack",
  "name": "致密材料示例包",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "新增致密合金板、对应科技和制造配方。",
  "dependencies": [],
  "items": [
    {
      "id": "example_dense_plate",
      "name": "致密合金板",
      "symbol": "DP",
      "color": "#4cc9a8",
      "kind": "solid",
      "description": "由铁块和铜块压制成的高密度结构材料。"
    }
  ],
  "buildings": [],
  "recipes": [
    {
      "id": "example_dense_plate_recipe",
      "name": "致密合金板",
      "buildingId": "assembling_machine_mk1",
      "duration": 4,
      "requiredTechId": "example_dense_materials",
      "inputs": [
        { "itemId": "iron_ingot", "amount": 2 },
        { "itemId": "copper_ingot", "amount": 1 }
      ],
      "outputs": [
        { "itemId": "example_dense_plate", "amount": 1 }
      ]
    }
  ],
  "technologies": [
    {
      "id": "example_dense_materials",
      "name": "致密材料学",
      "prerequisites": ["electromagnetic_matrix"],
      "tier": 2,
      "summary": "研究基础金属的复合压制工艺。",
      "costs": [
        { "itemId": "electromagnetic_matrix", "amount": 10 }
      ],
      "unlocks": ["致密合金板配方"]
    }
  ]
}
```

## 4. 根节点字段

| 字段 | 必填 | 类型 | 规则 |
| --- | --- | --- | --- |
| `formatVersion` | 是 | number | 当前开发源码的新包使用整数 `5`；旧 `1`、`2`、`3`、`4` 继续兼容；正式客户端支持范围见本文开头 |
| `id` | 是 | string | 内容包稳定 ID，规则见下一节 |
| `name` | 是 | string | 显示名称，建议不超过 80 字符，硬上限 120 |
| `version` | 是 | string | 简化 SemVer，例如 `1.2.0` 或 `1.2.0-beta.1` |
| `author` | 否 | string | 作者显示名，最多保留 80 字符 |
| `description` | 否 | string | 内容包说明，最多保留 240 字符 |
| `dependencies` | 否 | string[] | 最多 32 项，默认 `[]` |
| `items` | 否 | object[] | 新物品，最多 256 项 |
| `buildings` | 否 | object[] | 新的通用建筑，最多 128 项 |
| `recipes` | 否 | object[] | 新配方，最多 512 项 |
| `technologies` | 否 | object[] | 新科技，最多 256 项 |
| `buildingOverrides` | 否 | object[] | v2 核心建筑安全数值覆盖，最多 128 项 |
| `belts` | 否 | object[] | v2 自定义 4～32 级传送带，最多 29 项 |
| `recipeOverrides` | 否 | object[] | v3 核心配方的手合、科技、周期与递归优先级覆盖，最多 512 项 |
| `technologyOverrides` | 否 | object[] | v3 核心科技前置、成本、层级和说明覆盖，最多 512 项 |
| `constructionOverrides` | 否 | object[] | v3 核心建筑和传送带施工解锁覆盖，最多 512 项 |
| `technologyEffects` / `recipeGroups` / `recipePolicies` | 否 | object[] | v4 实际倍率、分组科技和建筑配方限制，各最多 512 项 |
| `fuels` / `generators` / `resources` | 否 | object[] | v4 燃料、发电和资源配置，各最多 512 项 |
| `categories` / `idMigrations` | 否 | object[] | v4 分类与旧 ID 映射，各最多 512 项 |
| `compatibleSaveVersions` | 否 | string[] | 已验证可迁移的旧版包版本，最多 128 项 |
| `itemOverrides` / `beltOverrides` | 否 | object[] | v5 原版物品展示及传送带规则覆盖；同类目标 ID 唯一 |

不应依赖未知字段保存作者数据；科技效果等规则会拒绝不支持的字段。发布包时可以在 JSON 旁单独附带 `README.md`、许可证和更新记录。

## 5. ID、版本与依赖

### ID 规则

内容包 ID 和所有内容 ID 都必须匹配：

```text
^[a-z][a-z0-9_]{1,63}$
```

也就是总长度 2 到 64 个字符，第一个字符为小写英文字母，其余字符只能是小写英文字母、数字或下划线。

所有作者都应使用内容包前缀，例如：

```text
内容包：alice_metals
物品：alice_metals_dense_plate
配方：alice_metals_dense_plate_recipe
科技：alice_metals_dense_materials
```

ID 是存档引用，不是显示名称。已经发布并被存档使用的 ID 不要改名或复用为另一种内容。兼容更新不会重写存档 ID；旧条目应保留，另加新 ID 表达不兼容的新内容。

### 版本规则

内容包版本使用 `主版本.次版本.修订版本`，可以带预发布后缀，但不支持 `+build` 构建元数据。支持的依赖写法如下：

| 写法 | 含义 |
| --- | --- |
| `base_pack` | 接受任意合法版本 |
| `base_pack@1.2.0` | 只接受 `1.2.0` |
| `base_pack@^1.2.0` | 主版本相同且不低于 `1.2.0` |
| `base_pack@~1.2.0` | 主、次版本相同且不低于 `1.2.0` |
| `base_pack@>=1.2.0` | 接受 `1.2.0` 及以上 |
| `base_pack@>1.2.0`、`<=`、`<`、`=` | 单一比较条件 |

当前不支持 `1.x`、`*`、`1.2.0 - 2.0.0`、空格组合范围或 `||`。`^` 和 `~` 使用项目内的简化规则；对兼容性要求严格时优先使用精确版本或 `~`。

### 依赖规则

跨包引用的物品、建筑或科技必须由已注册的包提供，并应在 `dependencies` 中显式声明：

```json
{
  "dependencies": ["alice_core@~1.2.0", "bob_energy@1.0.0"]
}
```

安装顺序为依赖包在前、使用方在后。依赖必须同时满足“已安装、已启用、版本匹配”。如果使用方引用了尚未注册的依赖内容，它会因为未知 ID 而无法通过校验；仅声明依赖但没有引用依赖内容的包可以先注册，但会保持停用。依赖就绪后还需要手动启用使用方。已启用的使用方仍依赖某个包时，管理器会阻止停用或移除该依赖。

不要建立循环依赖。依赖只表示其他内容包，不表示游戏版本；v2 没有 `gameVersion` 字段，需要在发布说明中写明测试过的游戏版本。

## 6. 通用数量结构

配方输入、配方输出、建筑成本和科技成本都使用同一种结构：

```json
{ "itemId": "iron_ingot", "amount": 2 }
```

规则：

- 每个数量数组最多 24 项；
- `itemId` 必须引用核心物品、同包物品或已注册依赖包物品；
- `amount` 必须是大于 0 且不超过 1,000,000 的有限数值；
- 运行时会把数量向下取整并保证至少为 1，因此作者应直接使用正整数，避免校验值与实际值看起来不一致；
- 同一个数组中不要重复同一 `itemId`，当前校验器不会替作者合并重复项。

## 7. 物品字段

| 字段 | 必填 | 类型 | 规则与默认值 |
| --- | --- | --- | --- |
| `id` | 是 | string | 新的稳定 ID，不能覆盖核心或其他已注册包的物品 |
| `name` | 是 | string | 显示名，建议最多 80 字符 |
| `symbol` | 否 | string | 节点短标记，最多保留 8 字符；默认取名称前 3 字符 |
| `color` | 否 | string | 建议使用 `#rrggbb`，最多保留 16 字符；默认由 ID 稳定生成 |
| `kind` | 否 | string | `solid`、`fluid` 或 `matrix`，默认 `solid` |
| `description` | 否 | string | 最多保留 240 字符 |

`kind: "matrix"` 目前主要影响目录分类和显示。研究站的科研输入仍只接受六种核心矩阵，不能仅靠声明自定义矩阵就创建新的科研货币。

## 8. 配方字段

| 字段 | 必填 | 类型 | 规则 |
| --- | --- | --- | --- |
| `id` | 是 | string | 新配方 ID，不能覆盖已有配方 |
| `name` | 是 | string | 配方显示名，建议最多 80 字符 |
| `buildingId` | 是 | string | 执行配方的建筑 ID |
| `duration` | 是 | number | 单周期模拟秒数，`0 < duration <= 86400` |
| `requiredTechId` | 否 | string | 核心、同包或依赖包科技 ID |
| `handcraftable` | 否 | boolean | `false` 仅允许设备生产，禁止直接/递归手合、新手合队列和自动递归代合成；省略沿用旧规则 |
| `recursivePriority` | 否 | integer | -1000～1000，自动递归选方的优先级，越大越优先 |
| `inputs` | 是 | amount[] | 输入数组，普通生产配方至少应有一项 |
| `outputs` | 是 | amount[] | 输出数组，普通生产配方至少应有一项 |

优先复用下面这些核心生产设备：

| `buildingId` | 用途 |
| --- | --- |
| `arc_smelter` | 熔炼；同一配方也兼容位面熔炉 |
| `assembling_machine_mk1` | 制造；同一配方也兼容制造台 Mk.II、Mk.III |
| `oil_refinery` | 原油精炼 |
| `chemical_plant` | 化工；同一配方也兼容量子化工厂 |
| `fractionator` | 分馏 |
| `miniature_particle_collider` | 粒子对撞 |
| `matrix_lab` | 矩阵制造 |

新配方进入配方正反查和设备配方选择；手合和递归候选遵守 `handcraftable`。显式 `true` 不能绕过核心发电、发射、充放电等专用配方的限制。规则变更前已经扣料的队列只完成当前批次，尚未开始的禁用或未解锁批次保留在队列中，不再扣料，可手动取消。设备正常生产不受手合开关影响。给已有物品增加替代配方可能改变递归选择，应验证完整上游链。

核心配方通过白名单覆盖，无需复制原配方或删除物品：

```json
"recipeOverrides": [
  { "id": "gear", "handcraftable": false, "requiredTechId": "example_dense_materials", "duration": 2 }
]
```

这里的 `id` 必须是核心配方 ID；省略字段保留原值。`requiredTechId: null` 明确移除科技门槛。支持的字段仅为 `requiredTechId`、`handcraftable`、`duration`、`recursivePriority`，不会改写核心物料输入输出。

## 9. 科技字段

| 字段 | 必填 | 类型 | 规则与默认值 |
| --- | --- | --- | --- |
| `id` | 是 | string | 新科技 ID，不能覆盖已有科技 |
| `name` | 是 | string | 显示名，建议最多 80 字符 |
| `prerequisites` | 否 | string[] | 前置科技 ID，默认 `[]`，不能形成循环 |
| `tier` | 否 | number | 科技树层级，0 到 99，运行时向下取整，默认 0 |
| `summary` | 否 | string | 说明，最多保留 240 字符 |
| `costs` | 否 | amount[] | 科研成本，默认 `[]` |
| `unlocks` | 否 | string[] | 最多保留 80 字符的展示文案，不执行游戏逻辑 |

当前科研站只可靠接收以下核心矩阵作为科技成本：

```text
electromagnetic_matrix
energy_matrix
structure_matrix
information_matrix
gravity_matrix
universe_matrix
```

要真正把科技与内容连接起来，应在配方或自定义建筑上写同一个 `requiredTechId`。科技完成后，配方和施工门禁会立即生效；只写 `unlocks` 不会解锁任何对象，也不会自动增加速度、容量或其他数值效果。

v3 可通过 `technologyOverrides` 修改核心科技的 `prerequisites`、`costs`、`tier`、`summary` 和 `unlocks`。校验器联合核心、同包和依赖包检查前置循环；v3 科研成本必须使用上述六种核心矩阵，防止注册一个研究站无法投入材料的科技。实际关联的配方与施工解锁会补充到科技说明。

```json
"technologyOverrides": [
  { "id": "basic_logistics", "costs": [{ "itemId": "electromagnetic_matrix", "amount": 10 }] }
],
"constructionOverrides": [
  { "id": "storage_mk1", "requiredTechId": "example_dense_materials" }
]
```

施工覆盖只调整已有施工条目的 `requiredTechId`，也支持 `null` 移除门槛；建筑本身、库存与成本不变。

## 10. 建筑、核心覆盖与传送带

| 字段 | 必填 | 类型 | 规则与默认值 |
| --- | --- | --- | --- |
| `id` | 是 | string | 新建筑 ID |
| `name` | 是 | string | 显示名 |
| `shortName` | 否 | string | 最多保留 24 字符；默认取名称前 8 字符 |
| `kind` | 否 | string | `machine`、`miner`、`power`、`storage`、`splitter`、`station`；默认 `machine` |
| `speed` | 否 | number | 0 到 1,000,000；运行时最小 0.01，默认 1 |
| `inputCapacity` | 否 | number | 0 到 1,000,000；运行时向下取整且最小 1，默认 100 |
| `outputCapacity` | 否 | number | 同上，默认 100 |
| `accepts` | 否 | string | `solid`、`fluid` 或 `any`，默认 `any` |
| `family` | 否 | string | `smelter`、`assembler` 或 `chemical`；复用同族核心通用配方 |
| `powerDemandKw` | 否 | number | 非负 kW |
| `powerGenerationKw` | 否 | number | 非负 kW |
| `description` | 否 | string | 最多保留 240 字符 |
| `requiredTechId` | 否 | string | 施工解锁科技 |
| `costs` | 否 | amount[] | 只有非空时才会注册建筑制造定义 |
| `outputAmount` | 否 | number | 每批施工产量，运行时向下取整且最小 1，默认 1 |

这些字段选择现有通用实体类别；`family` 让同族建筑共享实时配方，v4 的 `recipePolicies` 可以进一步指定允许的配方。带非空 `costs` 的自定义建筑进入制造及桌面/手机部署目录，`requiredTechId` 未完成时隐藏。没有成本的建筑不会成为可部署建筑。自定义 `miner` 通过 v4 `resources` 安装到对应矿点，沿用矿机堆叠、供电与耗尽规则；不提供自由坐标部署。燃料发电使用 v4 `fuels` 和 `generators`，不通过 `kind` 猜测专属行为。

### 1.1.7 托盘目录与分类

桌面和移动端现在共用同一套运行时建筑目录：核心建筑保持既有顺序，启用内容包后新增的有效建筑按注册目录顺序追加。托盘不会再要求维护一份固定核心 ID 白名单，因此内容包更新后不需要修改客户端 UI。

分类只影响托盘筛选，不会改变建筑运行逻辑：

- `power` 进入电力分类；
- `machine`、`miner` 进入生产分类；但自定义 `miner` 没有资源映射时只保留制造/删除入口，不进入自由坐标部署列表；
- `storage`、`splitter`、`station` 进入物流分类；
- `belts` 条目进入物流分类，并继续使用传送带等级、速度、线路和升级语义。

`kind: "splitter"` 只是复用通用分流建筑行为，不等于一条真正的传送带。要提供可连接、可升级的传送带等级，必须使用 `belts` 条目。自定义建筑仍不能声明脚本、端口几何、专属材质或新的模拟事件。

建筑 ID 与 `belts[].id` 共享运行时施工命名空间；同包或跨包重复会在校验/注册阶段拒绝，避免一个条目同时被解释成建筑和传送带。

`buildingOverrides` 只能修改 `speed`、`inputCapacity`、`outputCapacity`、`powerDemandKw`、`powerGenerationKw`、`powerChargeKw`、`energyCapacityMj` 和 `stackLimit`。每个字段都有硬范围，不能借此更换建筑 kind、端口或特殊逻辑。多个启用包调整同一建筑会产生冲突并阻止不确定覆盖。

`belts` 用于声明 4～32 级传送带。每项必须提供唯一 `id`、唯一 `tier`、正数 `speed` 和非空 `costs`，可选 `requiredTechId` 与 `outputAmount`。运行时吞吐、自动最高级选择、制造、施工托盘、升级、蓝图和存档都从同一动态传送带目录读取。

## 11. 引用闭合与冲突

一个可用内容包必须满足以下闭合关系：

- 配方 `buildingId` 必须存在；
- 配方输入、输出必须引用存在的物品；
- 配方 `requiredTechId` 必须存在；
- 科技前置必须存在且不能成环；
- 科技成本和建筑成本必须引用存在的物品；
- 建筑施工科技必须存在；
- 跨包引用应有显式依赖，并在校验使用方前先注册依赖包。

新增条目不能占用核心 ID；仅上述覆盖字段允许修改核心规则。其他已注册内容包即使处于停用状态，也会保留其 ID；同类别 ID 或同一类核心覆盖目标冲突时，新包不能注册。相同包 ID 可以更新自己的定义，不会误把当前已启用的旧定义认作核心冲突。

核心目录的权威 ID 位于 [`src/game/content.ts`](../src/game/content.ts)。不要根据中文显示名称猜 ID，也不要从存档里复制没有确认来源的字符串。

## 12. 存档、云同步与更新

这是内容包最重要的安全边界：

- 内容包 JSON 注册表保存在当前设备，不会塞入云存档；
- GameState v40 起保存每个启用内容包的精确 `id` 和 `version`，以及实际物品、建筑、配方、科技和线路引用；
- 同一份带 Mod 存档在另一台设备上使用前，必须先安装并启用相同依赖和兼容版本的全部内容包；
- 启用的内容包会在存档迁移之前注入运行时目录。顺序不能反过来，否则加载器可能把未知扩展 ID 当成无效引用归一掉；
- 内容包注册表对当前设备上的所有主存档、手动槽和快照共享，不是每个存档一份；
- 缺少、停用或版本不兼容的内容包会明确阻止目标存档加载，不能静默删除扩展实体或库存；在本机通过兼容检查的旧版本可以继续读取；
- 管理器的使用保护检查当前已加载存档；其他本地槽、快照或云端修订会在真正载入时再次执行精确版本门禁。

在新设备加载带 Mod 的云存档时，使用下面的顺序：

1. 先进入一个不含该 Mod 的测试存档；
2. 安装并启用全部依赖和内容包；
3. 返回主菜单；
4. 再显式下载、导入或打开带 Mod 的目标存档。

更新内容包时保持包 ID，修改正文必须提高 `version`。既有内容 ID 默认不变，v4 可通过明确迁移规则改名。管理器比较新增、修改和删除项，允许增加条目、改名称、科技门槛、手合、周期等兼容变化；拒绝无映射的删除/重命名、改变物品类别、既有配方物料或设备类别，以及破坏依赖的升级。无需清空物品。最多记录 128 个兼容版本；最近五个原清单可单独导出备份。

更新的目录验证和本地读回必须成功，才会让运行中的游戏采用新注册表；失败保留原目录与存档。其他设备仍需安装同样的更新链以获得旧版本兼容记录，或使用更新后的客户端保存并导出的新版本存档；不会仅因版本数字变大就跳过校验。注册表仍不是多版本运行系统，不提供删除、重命名 ID 的自动迁移。

停用或移除前，应逐一确认设备上的主存档、三个手动槽、快照和待恢复云修订都不再使用该包，并保留原 JSON。不要通过手工删除 `localStorage` 绕过保护。

内容包存档可以正常使用本地保存、导入导出和四个云槽。服务端会接受结构和校验合法的内容包云存档，但主槽一旦包含 `contentPacks` 就自动移除官方排行榜记录；清空 Mod 引用、禁用内容包并重新上传纯核心主档后才能恢复官方排行资格。

## 13. 发布前验证

至少完成以下检查：

1. JSON 能在“内容包校验”中通过，没有未知引用、核心覆盖或依赖错误。
2. 注册并启用后没有目录校验异常，依赖卡片全部显示“就绪”。
3. 每个新科技都能投入矩阵并完成，科技前置没有循环。
4. 每条配方都在预期核心设备中可见，输入、输出、周期和科技门禁正确。
5. 手搓、递归制造、传送带输入输出、整数结算和库存显示符合预期。
6. 保存、刷新和离线结算后状态不丢失；同包同版本重复加载结果一致。
7. 启用至少一个有成本的自定义建筑，分别在桌面和移动端确认部署托盘、分类、科技锁定和制造成本；再验证一个 `belts` 条目不会被误当成普通建筑。
8. 在干净测试存档验证停用、重新启用和依赖阻止行为。
9. 在第二个浏览器配置或设备按“先装包、后读档”的顺序做一次迁移演练。
10. 使用原创或有明确授权的名称与文案；随发布包提供作者、版本、许可和兼容游戏版本说明。

仓库维护者修改内容包协议或示例时运行：

```powershell
npm test -- src/game/mods.test.ts src/game/contentPacks.test.ts
npm run typecheck
```

文档示例由 `contentPacks.test.ts` 直接载入并验证，协议变化导致示例失效时测试会失败。

## 14. 常见错误

| 提示 | 原因与处理 |
| --- | --- |
| `内容包格式必须为 v1、v2、v3 或 v4` | `formatVersion` 不是受支持的整数；新内容包应使用 `4` |
| `内容包 ID 只能使用小写字母、数字和下划线` | ID 太短、以数字开头、包含大写字母、连字符、空格或非 ASCII 字符 |
| `版本号必须使用语义版本号` | 使用 `1.0.0` 形式；不要使用 `v1`、`1.0` 或 `1.0.0+build` |
| `不能覆盖核心...` | 更换为带作者或包前缀的新 ID；核心建筑数值只能使用 v2 `buildingOverrides` 白名单 |
| `配方引用未知...` | 修正 ID，或先注册依赖并在 `dependencies` 中声明 |
| `已注册，等待依赖` | 安装、启用匹配版本的依赖后，再手动启用当前包 |
| `仍被已启用的...依赖` | 先停用使用方，再停用或移除依赖 |
| `当前存档仍在使用...` | 停用/移除受保护；更新请保留旧 ID 并提高版本，不需要删除物品 |
| `不能删除或重命名...` | 保留旧定义，或提供通过兼容校验的 v4 ID 迁移；不要清空存档绕过检查 |
| 科技可见但无法投入自定义矩阵 | 当前科研站只接受六种核心矩阵，请改用核心矩阵成本 |
| `自定义传送带需要合法 ID、4～32 级...` | 检查唯一 ID/等级、正数速度、制造成本和可选科技引用 |
| `缺少内容包 ...` 或 `版本不匹配` | 先安装并启用存档要求的精确版本，再重新载入；不要强行删除扩展字段 |

校验界面通常只展示前几条问题。修复第一批错误后重新选择 JSON，直到完整通过，再进行注册和玩法测试。
